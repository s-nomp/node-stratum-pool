'use strict';

const assert = require('assert');
const http = require('http');
const Daemon = require('../lib/daemon').interface;

async function check() {
    let held;
    let heldSocket;
    let ordinarySocket;
    let receivedLongPoll;
    const longPollReceived = new Promise(resolve => { receivedLongPoll = resolve; });
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            const rpc = JSON.parse(data);
            assert.strictEqual(req.headers.authorization,
                'Basic ' + Buffer.from('user:password').toString('base64'));
            switch (rpc.method) {
                case 'getblocktemplate':
                    assert.deepStrictEqual(rpc.params, [{longpollid: 'opaque: not a block hash'}]);
                    held = res;
                    heldSocket = req.socket;
                    receivedLongPoll();
                    return;
                case 'ordinary':
                    ordinarySocket = req.socket;
                    break;
                case 'unauthorized':
                    res.writeHead(401);
                    res.end('unauthorized');
                    return;
                case 'malformed':
                    res.end('{');
                    return;
                case 'empty':
                    res.end('null');
                    return;
                case 'aborted':
                    res.writeHead(200, {'Content-Length': 100});
                    res.write('{');
                    setImmediate(() => res.destroy());
                    return;
                case 'timeout':
                    return;
            }
            res.end(JSON.stringify({result: rpc.method, error: null, id: rpc.id}));
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const instance = {host: '127.0.0.1', port: server.address().port,
        user: 'user', password: 'password'};
    // A selected request must not fan out to this deliberately unreachable backup.
    const daemon = new Daemon([instance, {port: 1}], () => {});
    const oldMaxSockets = http.globalAgent.maxSockets;
    http.globalAgent.maxSockets = 1;
    let callbackCount = 0;
    let requests;
    const command = (method, params, timeout) => new Promise(resolve => {
        requests = daemon.cmd(method, params, result => {
            callbackCount++;
            resolve(result);
        }, true, false, {instance: instance, agent: false, timeout: timeout});
    });
    try {
        for (const stream of [true, false]) {
            const completions = [];
            const canceledRequests = daemon.cmd('ordinary', [], result => completions.push(result),
                stream, false, {agent: false});
            assert.strictEqual(canceledRequests.length, 2);
            canceledRequests.forEach(request => {
                assert(!request.socket, 'the request must be canceled before socket assignment');
                request.abort();
            });
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(completions.length, stream ? 2 : 1,
                'immediate cancellation must complete streaming and aggregate calls');
            const results = stream ? completions : completions[0];
            assert.strictEqual(results.length, 2);
            results.forEach(result => assert(result.error));
            await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(completions.length, stream ? 2 : 1,
                'abort and close must not complete the same request twice');
        }
        const longPoll = command('getblocktemplate', [{longpollid: 'opaque: not a block hash'}], 3600);
        await longPollReceived;
        const ordinary = await new Promise(resolve => {
            daemon.cmd('ordinary', [], resolve, false, false, {instances: [instance]});
        });
        assert.strictEqual(ordinary.length, 1, 'unselected daemons must not be queried');
        assert.strictEqual(ordinary[0].response, 'ordinary');
        assert.notStrictEqual(ordinarySocket, heldSocket);
        held.end(JSON.stringify({result: {longpollid: 'next'}, error: null}));
        assert.deepStrictEqual((await longPoll).response, {longpollid: 'next'});
        for (const method of ['unauthorized', 'malformed', 'empty', 'aborted', 'timeout']) {
            const result = await command(method, [], 0.02);
            assert(result.error, method + ' must complete with an error');
        }
        const replacementReceived = new Promise(resolve => { receivedLongPoll = resolve; });
        const canceled = command('getblocktemplate', [{longpollid: 'opaque: not a block hash'}], 3600);
        await replacementReceived;
        assert.strictEqual(requests.length, 1);
        requests[0].abort();
        assert((await canceled).error, 'switching channels must cancel the held request');
        // An abort can also emit an error: callers must only be notified once.
        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(callbackCount, 7);
    } finally {
        http.globalAgent.maxSockets = oldMaxSockets;
        sockets.forEach(socket => socket.destroy());
        await new Promise(resolve => server.close(resolve));
    }
}

const deadline = setTimeout(() => {
    console.error('Daemon checks timed out');
    process.exit(1);
}, 5000);
check().then(() => {
    clearTimeout(deadline);
    console.log('Daemon long-poll connection and error checks passed.');
}, error => {
    clearTimeout(deadline);
    console.error(error);
    process.exitCode = 1;
});

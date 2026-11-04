'use strict';

const assert = require('assert');
const events = require('events');
const fs = require('fs');
const vm = require('vm');
const algos = require('../lib/algoProperties');
const bitcoin = require('bitgo-utxo-lib');
const source = fs.readFileSync(require.resolve('../lib/pool'), 'utf8');
const stratumSource = fs.readFileSync(require.resolve('../lib/stratum'), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));

function template(height, longpollid) {
    return {
        version: 4, height: height, curtime: 1700000000,
        previousblockhash: height.toString(16).padStart(64, '0'),
        target: '0f'.repeat(32), bits: '200f0f0f', longpollid: longpollid,
        transactions: [],
        finalsaplingroothash: '33'.repeat(32)
    };
}

async function start(rpc, overrides) {
    const timers = new Set();
    const retries = new Set();
    const heartbeats = new Set();
    const broadcasts = [];
    const requests = [];
    const ordinaryRequests = [];
    const subsidyRequests = [];
    let holdSubsidy = false;
    let now = 0;
    let holdOrdinary = false;
    let pending;
    const instances = [{index: 0}, {index: 1}];
    let sourceInstance = instances[0];
    const backendTemplates = [clone(rpc), clone(rpc)];
    const backendErrors = [null, null];
    const backendSubsidies = [null, null];
    const subsidyErrors = [null, null];
    async function replyRequest(request, response, error) {
        assert(request, 'expected a pending long poll');
        if (pending === request) pending = null;
        request.callback({response: response, error: error, instance: request.options.instance});
        await flush();
    }
    class Daemon extends events.EventEmitter {
        init() { this.emit('online'); }
        batchCmd(calls, callback) {
            const replies = {
                validateaddress: {isvalid: true, address: 'mi4iBXbBsydtcc5yFmsff2zCFVX4XG7qJc'},
                getdifficulty: 1, getmininginfo: {networkhashps: 1000},
                submitblock: {code: -1},
                getblockchaininfo: {chain: 'test', difficulty: 1},
                getnetworkinfo: {protocolversion: 170120, connections: 1}
            };
            callback(null, calls.map(call => ({result: replies[call[0]]})));
        }
        cmd(method, params, callback, stream, raw, options) {
            if (method === 'submitblock' || method === 'getblock') {
                callback(instances.map(instance => ({
                    instance: instance, error: null,
                    response: method === 'submitblock' ? null :
                        {hash: params[0], confirmations: 1, tx: ['coinbase']}
                })));
                return [];
            }
            if (method === 'getblocksubsidy') {
                assert(options.instance, 'subsidies must use the template daemon');
                assert.strictEqual(params.length, 1);
                const instance = options.instance;
                const response = clone(backendSubsidies[instance.index] || {
                    miner: params[0] < 201 ? 12.5 : 6.25, founders: 0
                });
                const error = subsidyErrors[instance.index];
                let finished = false;
                const request = {
                    height: params[0], instance: instance,
                    reply: () => {
                        if (finished) return;
                        finished = true;
                        callback({response: response, error: error, instance: instance});
                    },
                    abort: () => {
                        if (finished) return;
                        request.aborted = true;
                        finished = true;
                        setImmediate(() => callback({error: {message: 'request aborted'}, instance}));
                    }
                };
                subsidyRequests.push(request);
                if (!holdSubsidy) request.reply();
                return [request];
            }
            assert.strictEqual(method, 'getblocktemplate');
            const config = Array.isArray(params) ? params[0] : params;
            if (Object.prototype.hasOwnProperty.call(config, 'longpollid')) {
                assert(!pending, 'only one long poll may be outstanding');
                const request = {
                    config: config, callback: callback, options: options,
                    abort: () => {
                        if (pending === request) pending = null;
                        setImmediate(() => callback({
                            error: {message: 'request aborted'}, instance: options.instance
                        }));
                    }
                };
                pending = request;
                requests.push(request);
                return [request];
            }
            const targets = options && options.instance ? [options.instance] :
                options && options.instances ||
                [sourceInstance].concat(instances.filter(instance => instance !== sourceInstance));
            const responses = [];
            const handles = targets.map(instance => {
                const result = {response: clone(backendTemplates[instance.index]),
                    error: backendErrors[instance.index], instance: instance};
                let finished = false;
                function deliver(value) {
                    if (stream) callback(value);
                    else {
                        responses.push(value);
                        if (responses.length === targets.length) callback(responses);
                    }
                }
                return {
                    instance: instance,
                    reply: () => {
                        if (finished) return;
                        finished = true;
                        deliver(result);
                    },
                    abort: () => {
                        if (finished) return;
                        finished = true;
                        setImmediate(() => deliver({error: {message: 'request aborted'}, instance}));
                    }
                };
            });
            const round = {
                instance: targets[0], requests: handles,
                reply: () => handles.forEach(handle => handle.reply())
            };
            ordinaryRequests.push(round);
            if (!holdOrdinary) round.reply();
            return handles;
        }
    }
    const context = {
        module: {}, algos: algos, process: process, Date: {now: () => now},
        require: name => {
            if (name === './daemon.js') return {interface: Daemon};
            if (name === './stratum.js') return {Server: Server};
            return name.startsWith('./') ? require('../lib/' + name.slice(2)) : require(name);
        },
        setInterval: (callback, delay) => {
            const timer = {callback: callback, delay: delay, next: now + delay};
            timers.add(timer);
            return timer;
        },
        clearInterval: timer => timers.delete(timer),
        setTimeout: (callback, delay) => {
            const timer = {callback: callback, delay: delay, next: now + delay};
            retries.add(timer);
            return timer;
        },
        clearTimeout: timer => retries.delete(timer)
    };
    const serverContext = Object.assign({}, context, {
        exports: {},
        require: name => {
            if (name === 'net') return {
                createServer: () => ({
                    listen: (port, callback) => { setImmediate(callback); }
                })
            };
            return name.startsWith('./') ? require('../lib/' + name.slice(2)) : require(name);
        },
        setTimeout: (callback, delay) => {
            const timer = {callback: callback, delay: delay, next: now + delay};
            heartbeats.add(timer);
            return timer;
        },
        clearTimeout: timer => heartbeats.delete(timer)
    });
    vm.runInNewContext(stratumSource, serverContext, {filename: require.resolve('../lib/stratum')});
    class Server extends serverContext.exports.Server {
        constructor(options, authorize) {
            super(options, authorize);
            const broadcast = this.broadcastMiningJobs;
            this.broadcastMiningJobs = job => {
                broadcasts.push(job.slice());
                broadcast.call(this, job);
            };
        }
    }
    vm.runInNewContext(source, context, {filename: require.resolve('../lib/pool')});
    const pool = new context.module.exports(Object.assign({
        coin: {name: 'Zcash', symbol: 'ZEC', algorithm: 'equihash', supportsSegwit: true,
            parameters: {N: 48, K: 5, personalization: 'ZcashPoW'}},
        address: 'mi4iBXbBsydtcc5yFmsff2zCFVX4XG7qJc',
        ports: {'1234': {tls: false}}, daemons: instances, blockRefreshInterval: 500,
        jobRebroadcastTimeout: 55
    }, overrides));
    pool.start();
    await flush();
    return {
        pool: pool, timers: timers, retries: retries, broadcasts: broadcasts, requests: requests,
        ordinaryRequests: ordinaryRequests, subsidyRequests: subsidyRequests,
        holdSubsidy: value => { holdSubsidy = value !== false; },
        setBackendSubsidy: (index, value) => { backendSubsidies[index] = value; },
        setSubsidyError: (index, error) => { subsidyErrors[index] = error; },
        heartbeats: heartbeats,
        setBackendError: (index, error) => { backendErrors[index] = error; },
        holdOrdinary: value => { holdOrdinary = value !== false; },
        advance: async milliseconds => {
            const target = now + milliseconds;
            for (;;) {
                const due = Array.from(timers).concat(Array.from(retries), Array.from(heartbeats))
                    .filter(timer => timer.next <= target).sort((a, b) => a.next - b.next)[0];
                if (!due) break;
                now = due.next;
                if (timers.has(due)) due.next += due.delay;
                else {
                    retries.delete(due);
                    heartbeats.delete(due);
                }
                due.callback();
                await flush();
            }
            now = target;
        },
        pending: () => pending,
        setTemplate: (value, index) => {
            sourceInstance = instances[index || 0];
            backendTemplates[sourceInstance.index] = clone(value);
        },
        setBackendTemplate: (value, index) => { backendTemplates[index] = clone(value); },
        replyRequest: replyRequest,
        reply: (response, error) => replyRequest(pending, response, error)
    };
}

async function check() {
    const legacy = await start(template(200));
    assert.strictEqual(legacy.requests.length, 0);
    assert.strictEqual(Array.from(legacy.timers)[0].delay, 500);
    legacy.setTemplate(template(201));
    Array.from(legacy.timers)[0].callback();
    await flush();
    assert.strictEqual(legacy.pool.jobManager.currentJob.rpcData.height, 201);
    assert.strictEqual(legacy.requests.length, 0);

    const live = await start(template(200, 'opaque:first/id'));
    assert.strictEqual(live.requests.length, 1);
    assert.strictEqual(live.pending().config.longpollid, 'opaque:first/id');
    assert.deepStrictEqual(clone(live.pending().config.capabilities), ['coinbasetxn', 'workid', 'coinbase/append']);
    assert.deepStrictEqual(clone(live.pending().config.rules), ['segwit']);
    assert.strictEqual(live.pending().options.timeout, 3600);
    assert.strictEqual(live.pending().options.agent, false);
    assert.strictEqual(live.pending().options.instance.index, 0);
    assert.strictEqual(Array.from(live.timers)[0].delay, 60000);

    // Timer and block notifications must not open extra long-poll connections.
    Array.from(live.timers)[0].callback();
    live.pool.processBlockNotify('external', 'test');
    await flush();
    assert.strictEqual(live.requests.length, 1);

    await live.reply(template(201, 'opaque:second/id'));
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201);
    assert.strictEqual(live.broadcasts.length, 2);
    assert.strictEqual(live.pending().config.longpollid, 'opaque:second/id');
    assert.strictEqual(live.requests.length, 2);
    await live.reply(template(201, 'opaque:timeout/id'));
    assert.strictEqual(live.broadcasts.length, 2, 'unchanged templates do not broadcast');
    assert.strictEqual(live.pending().config.longpollid, 'opaque:timeout/id');

    const previousJob = live.pool.jobManager.currentJob;
    const fees = template(201, 'fee-update');
    fees.transactions.push({hash: '44'.repeat(32), data: '0600008001', fee: 10000});
    fees.finalsaplingroothash = '55'.repeat(32);
    await live.reply(fees);
    assert.strictEqual(live.broadcasts.length, 3);
    assert.strictEqual(live.broadcasts[1][7], true, 'new parents clear old miner work');
    assert.strictEqual(live.broadcasts[2][7], false, 'same-parent updates keep old miner work');
    assert.strictEqual(live.broadcasts[2][8], '48_5', 'the algorithm parameters are not clean_jobs');
    assert.strictEqual(live.broadcasts[2][9], 'ZcashPoW');
    assert.strictEqual(live.pool.jobManager.validJobs[previousJob.jobId], previousJob);

    // Idle heartbeats retain long-poll work rather than competing ordinary transaction sets.
    const rebroadcast = clone(fees);
    rebroadcast.finalsaplingroothash = '66'.repeat(32);
    live.setTemplate(rebroadcast);
    live.pool.stratumServer.emit('broadcastTimeout');
    await flush();
    assert.strictEqual(live.broadcasts.length, 4);
    assert.strictEqual(live.broadcasts[3][7], false);
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.finalsaplingroothash,
        fees.finalsaplingroothash);
    live.pool.stratumServer.emit('broadcastTimeout');
    await flush();
    assert.strictEqual(live.broadcasts.length, 5, 'unchanged work still supports forced rebroadcast');
    assert.strictEqual(live.broadcasts[4][7], false);

    await live.reply(null, {message: 'connection reset'});
    assert.strictEqual(live.pending(), null);
    assert.strictEqual(Array.from(live.timers)[0].delay, 500);
    assert.strictEqual(Array.from(live.retries)[0].delay, 1000);
    // The ordinary backstop can fail over, keeping the opaque ID on its issuing daemon.
    live.setTemplate(template(202, 'backup-id'), 1);
    Array.from(live.timers)[0].callback();
    await flush();
    assert.strictEqual(live.retries.size, 0);
    assert.strictEqual(live.pending().options.instance.index, 1);
    assert.strictEqual(live.pending().config.longpollid, 'backup-id');
    assert.strictEqual(Array.from(live.timers)[0].delay, 60000);

    await live.reply(template(203));
    assert.strictEqual(live.pending(), null);
    assert.strictEqual(Array.from(live.timers)[0].delay, 500);
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 203);

    for (const cleanJobs of [false, true]) {
        const compatibility = await start(template(201, 'initial'), {
            cleanJobsOnTemplateUpdate: cleanJobs
        });
        const oldJob = compatibility.pool.jobManager.currentJob;
        await compatibility.reply(clone(fees));
        assert.strictEqual(compatibility.broadcasts.length, 2);
        assert.strictEqual(compatibility.broadcasts[1][7], cleanJobs);
        assert.strictEqual(compatibility.broadcasts[1][8], '48_5');
        assert.strictEqual(compatibility.pool.jobManager.validJobs[oldJob.jobId], oldJob);
        assert.deepStrictEqual(compatibility.pool.jobManager.processShare(
            oldJob.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '').error,
        [20, 'incorrect size of ntime'], 'old jobs still reach share validation in either mode');

        await compatibility.reply(template(202, 'next-parent'));
        assert.strictEqual(compatibility.broadcasts[2][7], true);
        assert.strictEqual(compatibility.pool.jobManager.validJobs[oldJob.jobId], undefined);
    }

    const configured = await start(template(200, 'id'), {longPollRefreshInterval: 120000});
    assert.strictEqual(Array.from(configured.timers)[0].delay, 120000);
    const disabled = await start(template(200, 'id'), {blockRefreshInterval: 0});
    assert.strictEqual(disabled.timers.size, 0);
    await disabled.reply(null, {message: 'timeout'});
    const retry = Array.from(disabled.retries)[0];
    disabled.retries.delete(retry);
    retry.callback();
    assert.strictEqual(disabled.requests.length, 2);
    assert.strictEqual(disabled.pending().config.longpollid, 'id');
    await disabled.reply(null, {message: 'offline'});
    assert.strictEqual(disabled.retries.size, 1, 'repeated failures continue retrying');
}

async function checkBackstop() {
    const live = await start(template(200, 'initial'), {blockRefreshInterval: 5000});
    await live.reply(null, {message: 'connection refused'});
    for (let retry = 0; retry < 4; retry++) {
        await live.advance(1000);
        assert.strictEqual(live.pending().options.instance.index, 0);
        await live.reply(null, {message: 'connection refused'});
    }
    live.setTemplate(template(201, 'backup'), 1);
    await live.advance(1000);
    assert.strictEqual(live.ordinaryRequests.length, 3, 'the 5-second backstop must not starve');
    assert.strictEqual(live.pending().options.instance.index, 1, 'the healthy backup takes over');
}

async function checkPacing() {
    const live = await start(template(200, 'unchanged'));
    for (let response = 0; response < 5; response++) {
        await live.reply(template(200, 'unchanged'));
        assert.strictEqual(live.pending(), null, 'immediate unchanged replies must be paced');
        await live.advance(999);
        assert.strictEqual(live.pending(), null);
        await live.advance(1);
        assert.strictEqual(live.requests.length, response + 2, 'at most one retry per second');
    }
    assert.strictEqual(live.ordinaryRequests.length, 2, 'long polls do not trigger ordinary fetches');
    await live.advance(1000);
    await live.reply(template(200, 'unchanged'));
    assert(live.pending(), 'a genuinely held response can immediately start the next long poll');
}

async function checkHeartbeat() {
    const live = await start(template(200, 'initial'));
    const manager = live.pool.jobManager;
    const processTemplate = manager.processTemplate;
    const processed = [];
    manager.processTemplate = function (rpc) {
        processed.push(rpc.longpollid);
        return processTemplate.call(this, rpc);
    };
    live.holdOrdinary();
    // The older snapshot is captured while the first long poll is already waiting.
    live.pool.stratumServer.emit('broadcastTimeout');
    const delayed = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    await flush();
    assert.strictEqual(live.broadcasts.length, 2, 'heartbeats must not wait for ordinary responses');
    const newer = template(200, 'newer');
    newer.finalsaplingroothash = '77'.repeat(32);
    await live.reply(newer);
    const currentRoot = manager.currentJob.hashReserved;
    const broadcasts = live.broadcasts.length;
    delayed.reply();
    await flush();
    assert.deepStrictEqual(processed, ['newer'], 'superseded snapshots must not be processed');
    assert.strictEqual(manager.currentJob.hashReserved, currentRoot);
    assert.strictEqual(live.broadcasts.length, broadcasts, 'the heartbeat was already delivered');
    live.holdOrdinary(false);
    live.pool.stratumServer.emit('broadcastTimeout');
    await flush();
    assert.strictEqual(manager.currentJob.hashReserved, currentRoot);
    assert.strictEqual(live.broadcasts.length, broadcasts + 1);

    live.holdOrdinary();
    live.pool.stratumServer.emit('broadcastTimeout');
    const beforeFailure = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    await live.reply(null, {message: 'offline'});
    beforeFailure.reply();
    await flush();
    assert.strictEqual(manager.currentJob.hashReserved, currentRoot,
        'a pre-failure ordinary snapshot cannot regain authority after the long poll fails');
}

async function checkHigherBackup() {
    const live = await start(template(200, 'initial'));
    live.holdOrdinary();
    live.setTemplate(template(201, 'backup'), 1);
    Array.from(live.timers)[0].callback();
    const delayed = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    await live.reply(template(200, 'primary'));
    delayed.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201,
        'a higher backup tip must not be discarded by request order');
}

async function checkChannelHandoff() {
    const live = await start(template(200, 'initial'), {blockRefreshInterval: 5000});
    const manager = live.pool.jobManager;
    const processTemplate = manager.processTemplate;
    const processed = [];
    manager.processTemplate = function (rpc) {
        processed.push(rpc.longpollid);
        return processTemplate.call(this, rpc);
    };
    const ordinary = template(200, 'ordinary');
    ordinary.finalsaplingroothash = '66'.repeat(32);
    live.setTemplate(ordinary);
    await live.reply(null, {message: 'offline'});
    await live.advance(1000);
    const oldLongPoll = live.pending();
    Array.from(live.timers)[0].callback();
    await flush();
    const currentRoot = manager.currentJob.hashReserved;
    const delayed = template(200, 'delayed');
    delayed.finalsaplingroothash = '77'.repeat(32);
    await live.replyRequest(oldLongPoll, delayed);
    assert.deepStrictEqual(processed, ['ordinary'], 'a replaced long-poll channel cannot roll back work');
    assert.strictEqual(manager.currentJob.hashReserved, currentRoot);

    // A completed old-channel response queued during handoff can still reveal a higher tip.
    const higher = await start(template(200, 'initial'), {blockRefreshInterval: 5000});
    await higher.reply(null, {message: 'offline'});
    await higher.advance(1000);
    const held = higher.pending();
    higher.holdOrdinary();
    higher.setTemplate(ordinary);
    Array.from(higher.timers)[0].callback();
    higher.ordinaryRequests[higher.ordinaryRequests.length - 1].reply();
    held.callback({response: template(201, 'higher'), instance: held.options.instance});
    await flush();
    assert.strictEqual(higher.pool.jobManager.currentJob.rpcData.height, 201);
}

async function checkSameHeightConflict() {
    const live = await start(template(200, 'parent-a'));
    live.holdOrdinary();
    Array.from(live.timers)[0].callback();
    const delayed = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    const newer = template(200, 'parent-b');
    newer.previousblockhash = 'bb'.repeat(32);
    await live.reply(newer);
    live.setBackendTemplate(newer, 0);
    const ordinaryCount = live.ordinaryRequests.length;
    delayed.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.previousblockhash,
        newer.previousblockhash, 'a delayed conflicting parent must not replace the active tip');
    assert.strictEqual(live.ordinaryRequests.length, ordinaryCount + 1,
        'a same-height conflict needs one authoritative refresh');
    const refresh = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    assert.strictEqual(refresh.instance.index, 0);
    Array.from(live.timers)[0].callback();
    await flush();
    assert.strictEqual(live.ordinaryRequests.length, ordinaryCount + 2);
    const backup = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    assert.deepStrictEqual(backup.requests.map(request => request.instance.index), [1],
        'other daemons stay pollable during the authoritative refresh');
    backup.reply();
    await flush();
    assert.strictEqual(live.ordinaryRequests.length, ordinaryCount + 2,
        'another conflicting backup must not restart the in-flight authoritative refresh');
    refresh.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.previousblockhash,
        newer.previousblockhash);

    const authoritative = template(200, 'parent-c');
    authoritative.previousblockhash = 'cc'.repeat(32);
    live.setTemplate(template(200, 'backup-parent-a'), 1);
    live.setBackendTemplate(authoritative, 0);
    Array.from(live.timers)[0].callback();
    live.ordinaryRequests[live.ordinaryRequests.length - 1].reply();
    await flush();
    const fresh = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    assert.strictEqual(fresh.instance.index, 0, 'the active backend resolves conflicting backups');
    fresh.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.previousblockhash,
        authoritative.previousblockhash, 'the authoritative refresh can confirm a real reorg');
}

async function checkOrdinarySingleFlight() {
    const live = await start(template(200));
    live.holdOrdinary();
    live.setTemplate(template(199));
    live.pool.stratumServer.emit('broadcastTimeout');
    const delayed = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    await live.advance(5000);
    assert.strictEqual(live.ordinaryRequests.length, 3,
        'unsupported daemons must have at most one ordinary refresh outstanding');
    delayed.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 200,
        'lower-height snapshots must always be discarded');
    assert.strictEqual(live.broadcasts.length, 2, 'a discarded lower tip still gets a heartbeat');
}

async function checkStreamingAndNotify() {
    const live = await start(template(200, 'initial'));
    live.holdOrdinary();
    live.setTemplate(template(201, 'higher'));
    Array.from(live.timers)[0].callback();
    const round = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    round.requests.find(request => request.instance.index === 0).reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201,
        'a higher tip must not wait for a hung peer in the same round');

    live.setTemplate(template(202, 'notified'));
    const count = live.ordinaryRequests.length;
    live.pool.processBlockNotify('new-block', 'test');
    assert.strictEqual(live.ordinaryRequests.length, count + 1,
        'block notifications must replace stalled ordinary rounds');
    const notified = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    notified.requests.find(request => request.instance.index === 0).reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 202);
}

async function checkLateFailover() {
    const live = await start(template(200, 'initial'));
    const processed = [];
    const manager = live.pool.jobManager;
    const processTemplate = manager.processTemplate;
    manager.processTemplate = function (rpc) {
        processed.push(rpc.finalsaplingroothash);
        return processTemplate.call(this, rpc);
    };
    live.holdOrdinary();
    live.setBackendError(0, {message: 'connection refused'});
    Array.from(live.timers)[0].callback();
    const round = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    const newer = template(200, 'newer');
    newer.finalsaplingroothash = '77'.repeat(32);
    await live.reply(newer);
    round.requests.find(request => request.instance.index === 0).reply();
    round.requests.find(request => request.instance.index === 1).reply();
    await flush();
    assert.strictEqual(processed[processed.length - 1],
        newer.finalsaplingroothash, 'an old failed round must not replace healthy long-poll work');
    assert.strictEqual(live.pending().options.instance.index, 0);

    await live.reply(null, {message: 'offline'});
    Array.from(live.timers)[0].callback();
    const failing = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    const fresh = template(200, 'fresh-backup');
    fresh.finalsaplingroothash = '88'.repeat(32);
    live.setBackendTemplate(fresh, 1);
    failing.requests.find(request => request.instance.index === 0).reply();
    await flush();
    const authoritative = live.ordinaryRequests[live.ordinaryRequests.length - 1];
    assert.notStrictEqual(authoritative, failing, 'failover fetches fresh work from its new authority');
    assert.strictEqual(authoritative.instance.index, 1);
    authoritative.reply();
    await flush();
    failing.requests.find(request => request.instance.index === 1).reply();
    await flush();
    assert.strictEqual(processed[processed.length - 1],
        fresh.finalsaplingroothash);
}

async function checkIdleRebroadcast() {
    for (const cleanJobs of [false, true]) {
        const initial = template(200, 'initial');
        const live = await start(initial, {
            blockRefreshInterval: 5000, jobRebroadcastTimeout: 2,
            cleanJobsOnTemplateUpdate: cleanJobs
        });
        const manager = live.pool.jobManager;
        const first = manager.currentJob;
        const pending = live.pending();
        assert.strictEqual(first.registerSubmit('nonce', 'solution'), true);
        const refreshed = clone(initial);
        refreshed.curtime += 10;
        refreshed.finalsaplingroothash = '99'.repeat(32);
        live.setTemplate(refreshed);
        await live.advance(2000);
        const current = manager.currentJob;
        assert.strictEqual(current.rpcData.curtime, refreshed.curtime,
            'idle refreshes must obtain fresh daemon time while long polling is healthy');
        assert.notStrictEqual(current.jobId, first.jobId, 'fresh time creates different work');
        assert.strictEqual(current.hashReserved, first.hashReserved,
            'ordinary refreshes must not replace long-poll transactions or roots');
        assert.strictEqual(live.broadcasts.length, 2, 'fresh work replaces the idle heartbeat');
        assert.strictEqual(live.broadcasts[1][7], cleanJobs);
        assert.strictEqual(current.registerSubmit('nonce', 'solution'), true);

        for (let heartbeat = 0; heartbeat < 33; heartbeat++) {
            await live.advance(2000);
            assert.strictEqual(manager.currentJob, current,
                'unchanged rebroadcasts must keep the current job and duplicate-share history');
            const job = live.broadcasts[live.broadcasts.length - 1];
            assert.strictEqual(job[0], current.jobId);
            assert.strictEqual(job[7], false, 'unchanged work must not restart miners');
        }
        assert.strictEqual(current.registerSubmit('nonce', 'solution'), false);
        assert.strictEqual(first.registerSubmit('nonce', 'solution'), false);
        assert.deepStrictEqual(Object.keys(manager.validJobs), [first.jobId, current.jobId],
            'idle heartbeats must not evict real jobs');
        assert.strictEqual(live.pending(), pending, 'idle refreshes must keep the long poll');
        assert.strictEqual(live.requests.length, 1);
        assert.strictEqual(Array.from(live.timers)[0].delay, 60000);
    }
}

async function checkRealHeartbeat() {
    const live = await start(template(200), {
        blockRefreshInterval: 5000, jobRebroadcastTimeout: 2
    });
    const refreshed = template(200);
    refreshed.curtime += 10;
    live.setTemplate(refreshed);
    Array.from(live.timers)[0].callback();
    await flush();
    await live.advance(2000);
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.curtime, refreshed.curtime,
        'the real heartbeat timer must rebuild from the freshest accepted response');
    assert.strictEqual(live.heartbeats.size, 1);
    const count = live.broadcasts.length;
    live.holdOrdinary();
    await live.advance(4000);
    assert.strictEqual(live.broadcasts.length, count + 2,
        'the real one-shot heartbeat must rearm while an ordinary request is hung');
    assert.strictEqual(live.heartbeats.size, 1);
}

async function checkResponsiveDaemonPolling() {
    const live = await start(template(200));
    live.holdOrdinary();
    live.setTemplate(template(201));
    await live.advance(500);
    live.ordinaryRequests[live.ordinaryRequests.length - 1].requests
        .find(request => request.instance.index === 0).reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201);
    for (const height of [202, 203]) {
        live.setTemplate(template(height));
        const count = live.ordinaryRequests.length;
        await live.advance(500);
        assert.strictEqual(live.ordinaryRequests.length, count + 1,
            'a responsive daemon must remain pollable while its backup is hung');
        const next = live.ordinaryRequests[live.ordinaryRequests.length - 1];
        assert.deepStrictEqual(next.requests.map(request => request.instance.index), [0],
            'a hung daemon must not get overlapping ordinary requests');
        next.reply();
        await flush();
        assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, height);
    }
}

async function checkAcceptedBlockRefresh() {
    const live = await start(template(200));
    live.holdOrdinary();
    Array.from(live.timers)[0].callback();
    const count = live.ordinaryRequests.length;
    live.setTemplate(template(201));
    live.pool.jobManager.emit('share', {blockHash: 'accepted-block'}, 'block-bytes');
    assert.strictEqual(live.ordinaryRequests.length, count + 1,
        'an accepted block must supersede outstanding ordinary requests');
    live.ordinaryRequests[live.ordinaryRequests.length - 1].requests
        .find(request => request.instance.index === 0).reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201);
}

async function checkLegacySubsidy() {
    const live = await start(template(200, 'before-halving'), {
        rewardRecipients: {'n37vuNFkXfk15uFnGoVyHZ6PYQxppD3QqK': 1}, poolHex: '616263'
    });
    const before = live.pool.jobManager.currentJob;
    assert.strictEqual(before.rpcData.coinbasetxn, undefined);
    assert.strictEqual(before.rpcData.miner, 12.5);
    let generation = bitcoin.Transaction.fromHex(before.genTx);
    assert.strictEqual(generation.outs[0].value, 1237500000);
    assert.strictEqual(generation.outs[1].value, 12500000);
    assert.strictEqual(generation.ins[0].script.slice(-3).toString('hex'), '616263');

    await live.reply(template(201, 'after-halving'));
    const after = live.pool.jobManager.currentJob;
    assert.strictEqual(after.rpcData.miner, 6.25, 'subsidy must use the returned height, not cached work');
    generation = bitcoin.Transaction.fromHex(after.genTx);
    assert.strictEqual(generation.outs[0].value, 618750000);
    assert.strictEqual(generation.outs[1].value, 6250000);
    const subsidy = live.subsidyRequests[live.subsidyRequests.length - 1];
    assert.strictEqual(subsidy.height, 201);
    assert.strictEqual(subsidy.instance.index, 0);

    live.setBackendSubsidy(1, {miner: 3.125, founders: 0});
    live.setTemplate(template(202, 'backup'), 1);
    Array.from(live.timers)[0].callback();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 202);
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.miner, 3.125,
        'a backup template must use the subsidy from that same daemon');
    assert.strictEqual(live.pending().options.instance.index, 1);
    assert.strictEqual(live.pool.options.feePercent, 1);
}

async function checkSubsidyFailure() {
    const live = await start(template(200, 'initial'));
    const current = live.pool.jobManager.currentJob;
    live.setSubsidyError(0, {message: 'subsidy unavailable'});
    await live.reply(template(201, 'unusable'));
    assert.strictEqual(live.pool.jobManager.currentJob, current,
        'a failed subsidy must not publish incomplete work');
    assert.strictEqual(live.pending(), null);
    assert.strictEqual(Array.from(live.timers)[0].delay, 500);
    live.setTemplate(template(202, 'backup'), 1);
    Array.from(live.timers)[0].callback();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 202);
    assert.strictEqual(live.pending().options.instance.index, 1);
}

async function checkSubsidyCancellation() {
    const live = await start(template(200, 'initial'));
    live.holdSubsidy();
    await live.reply(template(200, 'held-subsidy'));
    const held = live.subsidyRequests[live.subsidyRequests.length - 1];
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.longpollid, 'initial');
    live.setTemplate(template(201, 'backup'), 1);
    Array.from(live.timers)[0].callback();
    await flush();
    const backup = live.subsidyRequests.find(request => request.instance.index === 1 && request.height === 201);
    backup.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201,
        'an outstanding subsidy must not block a higher backup template');
    assert.strictEqual(held.aborted, true, 'handoff must also cancel the pending subsidy request');
    held.reply();
    await flush();
    assert.strictEqual(live.pool.jobManager.currentJob.rpcData.height, 201,
        'a canceled subsidy stage cannot roll back the replacement channel');
}

const regressionChecks = {
    idle: checkIdleRebroadcast,
    subsidy: checkLegacySubsidy,
    subsidyFailure: checkSubsidyFailure,
    subsidyCancellation: checkSubsidyCancellation,
    backstop: checkBackstop,
    pacing: checkPacing,
    heartbeat: checkHeartbeat,
    higher: checkHigherBackup,
    channel: checkChannelHandoff,
    conflict: checkSameHeightConflict,
    ordinary: checkOrdinarySingleFlight,
    streaming: checkStreamingAndNotify,
    failover: checkLateFailover,
    timer: checkRealHeartbeat,
    responsive: checkResponsiveDaemonPolling,
    accepted: checkAcceptedBlockRefresh
};

const checks = process.argv[2] ? regressionChecks[process.argv[2]]() :
    check().then(checkBackstop).then(checkPacing).then(checkHeartbeat)
        .then(checkHigherBackup).then(checkChannelHandoff).then(checkSameHeightConflict)
        .then(checkOrdinarySingleFlight).then(checkStreamingAndNotify)
        .then(checkLateFailover).then(checkIdleRebroadcast).then(checkRealHeartbeat)
        .then(checkResponsiveDaemonPolling).then(checkAcceptedBlockRefresh)
        .then(checkLegacySubsidy).then(checkSubsidyFailure).then(checkSubsidyCancellation);
checks.then(() => {
    console.log('Pool long-poll, backstop, retry, failover and clean-job compatibility checks passed.');
}, error => {
    console.error(error);
    process.exitCode = 1;
});

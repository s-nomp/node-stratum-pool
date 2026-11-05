'use strict';

const assert = require('assert');
require('../lib/algoProperties');
const JobManager = require('../lib/jobManager');
const bitcoin = require('bitgo-utxo-lib');
const address = 'mi4iBXbBsydtcc5yFmsff2zCFVX4XG7qJc';
const clone = value => JSON.parse(JSON.stringify(value));

async function check() {
    const manager = new JobManager({coin: {algorithm: 'equihash'}, address: address, recipients: []});
    const events = [];
    manager.on('newBlock', job => events.push(['new', job]));
    manager.on('updatedBlock', job => events.push(['update', job]));
    let rpc = {
        version: 4, height: 200, curtime: 1700000000,
        previousblockhash: '01'.repeat(32), target: '0f'.repeat(32), bits: '200f0f0f',
        miner: 12.5,
        transactions: [], finalsaplingroothash: '22'.repeat(32)
    };
    assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
    const first = manager.currentJob;
    assert.strictEqual(events[0][0], 'new');
    assert.strictEqual(first.registerSubmit('nonce', 'solution'), true);

    const unchanged = clone(rpc);
    unchanged.curtime++;
    unchanged.longpollid = 'another-id';
    assert.strictEqual(await manager.processTemplate(unchanged), false);
    assert.strictEqual(manager.currentJob, first);
    assert.strictEqual(events.length, 1);

    async function update(change) {
        const previous = manager.currentJob;
        rpc = clone(rpc);
        change(rpc);
        assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
        assert.notStrictEqual(manager.currentJob.jobId, previous.jobId);
        assert.strictEqual(events[events.length - 1][0], 'update');
        assert.strictEqual(manager.validJobs[previous.jobId], previous);
        assert.strictEqual(manager.validJobs[first.jobId], first);
        // Share lookup must still reach validation of the old job, not reject it as stale.
        const share = manager.processShare(first.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '');
        assert.deepStrictEqual(share.error, [20, 'incorrect size of ntime']);
        assert.strictEqual(first.registerSubmit('nonce', 'solution'), false);
        assert.strictEqual(await manager.processTemplate(clone(rpc)), false);
    }
    await update(value => { value.bits = '207fffff'; });
    await update(value => { value.target = '7f'.repeat(32); });
    await update(value => { value.version = 5; });


    await update(value => {
        value.transactions.push({hash: '33'.repeat(32), data: '0600008001', fee: 10000});
    });
    assert.notStrictEqual(manager.currentJob.merkleRoot, first.merkleRoot);
    assert.strictEqual(manager.currentJob.rewardFees, 10000);
    await update(value => {
        value.transactions.push({txid: '44'.repeat(32), hash: '55'.repeat(32),
            data: '0600008002', fee: 20000});
    });
    await update(value => value.transactions.reverse());
    await update(value => { value.transactions[0].txid = '66'.repeat(32); });
    // Authorized transaction data can change without changing its v5/v6 transaction ID.
    await update(value => { value.transactions[0].data += '00'; });
    await update(value => value.transactions.pop());
    await update(value => { value.miner -= 1; });
    await update(value => { value.founders = 2; });
    await update(value => {
        value.coinbase_required_outputs = [{script: '51', amount: 1000, type: 'masternode'}];
    });
    await update(value => { value.default_witness_commitment = '6a24aa21a9ed' + 'aa'.repeat(32); });
    await update(value => { value.transactions[0].fee += 1000; });
    await update(value => { value.finalsaplingroothash = 'cc'.repeat(32); });
    await update(value => { value.coinbasetxn = {foundersaddress: address}; });

    const jobs = Object.keys(manager.validJobs);
    const outdated = clone(rpc);
    outdated.previousblockhash = 'dd'.repeat(32);
    outdated.height--;
    assert.strictEqual(await manager.processTemplate(outdated), false);
    assert.deepStrictEqual(Object.keys(manager.validJobs), jobs);
    // A same-height reorg is a new parent, not a fee update.
    rpc.previousblockhash = 'ee'.repeat(32);
    assert.strictEqual(await manager.processTemplate(rpc), true);
    assert.strictEqual(events[events.length - 1][0], 'new');
    assert.deepStrictEqual(Object.keys(manager.validJobs), [manager.currentJob.jobId]);
    assert.deepStrictEqual(
        manager.processShare(first.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '').error,
        [21, 'job not found']);

    const retained = [manager.currentJob];
    for (let update = 0; update < 64; update++) {
        rpc = clone(rpc);
        rpc.transactions[0].fee += 1;
        assert.strictEqual(await manager.processTemplate(rpc), true);
        retained.push(manager.currentJob);
        assert(Object.keys(manager.validJobs).length <= 32, 'job retention must remain bounded');
    }
    assert.deepStrictEqual(Object.keys(manager.validJobs), retained.slice(-32).map(job => job.jobId));
    for (const job of retained.slice(-32)) {
        assert.strictEqual(manager.validJobs[job.jobId], job);
        assert.deepStrictEqual(
            manager.processShare(job.jobId, 1, 1, '', '', '', '', '', 0, 'worker', '').error,
            [20, 'incorrect size of ntime']);
    }
    assert.deepStrictEqual(
        manager.processShare(retained[retained.length - 33].jobId,
            1, 1, '', '', '', '', '', 0, 'worker', '').error,
        [21, 'job not found']);
    rpc = clone(rpc);
    rpc.previousblockhash = 'ff'.repeat(32);
    rpc.height++;
    assert.strictEqual(await manager.processTemplate(rpc), true);
    assert.deepStrictEqual(Object.keys(manager.validJobs), [manager.currentJob.jobId]);
}

async function checkBuilderInputs() {
    const rpc = {
        version: 4, height: 200, curtime: 1700000000,
        previousblockhash: '01'.repeat(32), target: '0f'.repeat(32), bits: '200f0f0f',
        miner: 12.5, transactions: []
    };
    const changes = {
        height: 201, certificates: [{data: '00'}],
        founders: 2, fundingstreams: [{address: address, valueZat: 1000}],
        treasury: 1, securenodes: 1, supernodes: 1, infrastructure: 1, giveaways: 1,
        loki: 1, founderstotal: 1, founderamount: 1, coinbasevalue: 1250000000,
        masternode_payments_started: true, masternode_payments: true,
        masternodes: [{script: '51', amount: 1000}], governanceblock: [{script: '51', amount: 1000}],
        payee: address, payee_amount: 1000,
        basic_zelnode_address: address, basic_zelnode_payout: 1000,
        super_zelnode_address: address, super_zelnode_payout: 1000,
        bamf_zelnode_address: address, bamf_zelnode_payout: 1000,
        gemlink: true, founderAddress: address, founderReward: 1000,
        treasuryAddress: address, treasuryReward: 1000, premineAddress: address,
        premineReward: 1000, vrsAddress: address, vrsReward: 1000
    };
    for (const field of Object.keys(changes)) {
        const manager = new JobManager({coin: {algorithm: 'equihash'}, address: address, recipients: []});
        await manager.processTemplate(clone(rpc));
        const changed = clone(rpc);
        changed[field] = changes[field];
        assert.strictEqual(await manager.processTemplate(changed), true, field + ' must refresh work');
        assert.strictEqual(await manager.processTemplate(clone(changed)), false);
    }
    const manager = new JobManager({coin: {algorithm: 'equihash'}, address: address, recipients: []});
    await manager.processTemplate(clone(rpc));
    const unusedCoinbase = clone(rpc);
    unusedCoinbase.coinbasetxn = {data: '00', hash: '11'.repeat(32)};
    assert.strictEqual(await manager.processTemplate(unusedCoinbase), false,
        'daemon coinbase bytes are not inputs to the legacy builder');
}

async function checkFundingStreams() {
    const manager = new JobManager({coin: {
        algorithm: 'equihash', vFundingStreams: true, percentFoundersReward: 20
    }, address: address, recipients: []});
    const rpc = {
        version: 4, height: 200, curtime: 1700000000,
        previousblockhash: '01'.repeat(32), target: '0f'.repeat(32), bits: '200f0f0f',
        miner: 10, fundingstreams: [{address: address, valueZat: 250000000}], transactions: []
    };
    await manager.processTemplate(clone(rpc));
    let generation = bitcoin.Transaction.fromHex(manager.currentJob.genTx);
    assert.deepStrictEqual(generation.outs.map(output => output.value), [1000000000, 250000000]);
    rpc.miner = 5;
    rpc.fundingstreams[0].valueZat = 125000000;
    assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
    generation = bitcoin.Transaction.fromHex(manager.currentJob.genTx);
    assert.deepStrictEqual(generation.outs.map(output => output.value), [500000000, 125000000]);
    const previous = manager.currentJob.genTx;
    rpc.fundingstreams[0].address = 'n37vuNFkXfk15uFnGoVyHZ6PYQxppD3QqK';
    assert.strictEqual(await manager.processTemplate(clone(rpc)), true);
    assert.notStrictEqual(manager.currentJob.genTx, previous);
}

check().then(checkBuilderInputs).then(checkFundingStreams).then(() => {
    console.log('Same-parent builder updates and bounded old-job share lookup checks passed.');
}, error => {
    console.error(error);
    process.exitCode = 1;
});

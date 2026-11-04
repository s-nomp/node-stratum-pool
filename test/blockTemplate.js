'use strict';

// Native proof/address dependencies are not needed to check opaque template serialization.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function load(file, dependencies, globals) {
    const context = Object.assign({module: {exports: {}}, Buffer: Buffer,
        require: name => Object.prototype.hasOwnProperty.call(dependencies, name) ?
            dependencies[name] : require(name)}, globals);
    context.exports = context.module.exports;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/', file), 'utf8'),
        context, {filename: file});
    return context.module.exports;
}
const bignum = () => ({toNumber: () => 1});
const util = load('util.js', {'base58-native': {}, bignum: bignum});
const merkle = load('merkleTree.js', {'./util.js': util,
    promise: {denodeify: () => () => { throw new Error('Unexpected legacy Merkle calculation'); }},
    'merkle-bitcoin': {}});
let generationCalls = 0;
const transactions = {
    getFees: txs => txs.reduce((sum, tx) => sum + Number(tx.fee), 0),
    createGeneration: () => { generationCalls++; return '04000080'; },
    txHash: () => '12'.repeat(32)
};
const BlockTemplate = load('blockTemplate.js', {bignum: bignum, './util.js': util,
    './merkleTree.js': merkle, './transactions.js': transactions}, {diff1: 1});
const reverse = hex => Buffer.from(hex, 'hex').reverse().toString('hex');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
const pair = (a, b) => digest(digest(Buffer.from(a + b, 'hex'))).toString('hex');
const ids = [0, 1, 2, 3].map(n => digest(Buffer.from('txid-' + n)).toString('hex'));
const leaves = ids.map(reverse);
const roots = [leaves[0], pair(leaves[0], leaves[1]),
    pair(pair(leaves[0], leaves[1]), pair(leaves[2], leaves[2])),
    pair(pair(leaves[0], leaves[1]), pair(leaves[2], leaves[3]))];
const coin = {daemonCoinbase: true};
// Hash/root excerpt from a funded NU5 template captured at height 114.
const funded = {coinbasetxn: {hash: '4991965bc123eae9c6cad38c82b51f5145be2bd1babd79f277dff623297d4c73'},
    transactions: [
        {hash: '995ca7be7f9f27490eb88473c5115a4106a9ab84545dbb21c6d5dfd5d4cd8dab'},
        {hash: 'd9be70cf93ef36326611de7e4dec801e86e48f66b9f9ea6ea2fffe3816f5153a'}]};
assert.strictEqual(reverse(merkle.getRoot(funded, funded.coinbasetxn.hash, true)),
    'd2ee955036b7be98f870a8ff9ad01ce0eccb163fa51de9fa1c16b0a82e849ee0');
function job(rpc, mode) {
    return new BlockTemplate('test', rpc, null, [], 'unused', null, mode || coin, null);
}
function checkTemplate(rpc, expectedRoot) {
    const before = JSON.stringify(rpc);
    const template = job(rpc);
    const time = Buffer.alloc(4);
    time.writeUInt32LE(rpc.curtime);
    const header = template.serializeHeader(time.toString('hex'), '00'.repeat(32));
    const commitment = rpc.blockcommitmentshash ||
        (rpc.defaultroots && rpc.defaultroots.blockcommitmentshash) || rpc.finalsaplingroothash;
    assert.strictEqual(header.slice(36, 68).toString('hex'), expectedRoot);
    assert.strictEqual(header.slice(68, 100).toString('hex'), reverse(commitment));
    assert.strictEqual(template.getJobParams()[3], expectedRoot);
    assert.strictEqual(template.getJobParams()[4], reverse(commitment));
    assert.strictEqual(template.genTx, rpc.coinbasetxn.data);
    assert.strictEqual(template.genTxHash, rpc.coinbasetxn.hash);
    const solution = Buffer.from('00', 'hex');
    assert.strictEqual(template.serializeBlock(header, solution).toString('hex'),
        header.toString('hex') + solution.toString('hex') +
        util.varIntBuffer(rpc.transactions.length + 1).toString('hex') +
        rpc.coinbasetxn.data + rpc.transactions.map(tx => tx.data).join(''));
    delete rpc.rewardFees;
    assert.strictEqual(JSON.stringify(rpc), before, 'consensus template fields must not be mutated');
}
// Synthetic v5/v6 bytes exercise preservation, not transaction validity or proof verification.
['050000800a27a726b4d0d6c2', '0600008098b684d85b16a537'].forEach(prefix => {
    for (let count = 0; count < 4; count++) {
        const rpc = {version: 4, height: 200, curtime: 1700000000,
            previousblockhash: ids[3], target: '0f'.repeat(32), bits: '200f0f0f',
            coinbasetxn: {data: prefix + '00', hash: ids[0]},
            transactions: ids.slice(1, count + 1).map((hash, i) => ({
                hash: hash, data: prefix + '000' + i, fee: 10000})),
            finalsaplingroothash: ids[2]};
        checkTemplate(rpc, roots[count]);
        rpc.defaultroots = {merkleroot: reverse(roots[count]), blockcommitmentshash: ids[3]};
        checkTemplate(rpc, roots[count]);
        rpc.blockcommitmentshash = ids[1];
        checkTemplate(rpc, roots[count]);
    }
});
assert.strictEqual(merkle.getRoot({transactions: [{txid: ids[1], hash: ids[3]}]}, ids[0], true), roots[1]);
[252, 32767].forEach(count => checkTemplate({version: 4, height: 200, curtime: 1700000000,
    previousblockhash: ids[3], target: '0f'.repeat(32), bits: '200f0f0f',
    coinbasetxn: {data: '0600008098b684d85b16a537', hash: ids[0]},
    transactions: Array.from({length: count}, () => ({hash: ids[1], data: '00', fee: 0})),
    defaultroots: {merkleroot: ids[2], blockcommitmentshash: ids[3]}}, reverse(ids[2])));
assert.strictEqual(generationCalls, 0, 'daemon templates must never invoke the legacy builder');
const legacy = job({version: 4, height: 200, curtime: 1700000000,
    previousblockhash: ids[3], target: '0f'.repeat(32), bits: '200f0f0f',
    miner: 1, transactions: [], finalsaplingroothash: ids[2]}, {});
assert.strictEqual(generationCalls, 1, 'legacy coins must retain the existing builder');
assert.strictEqual(legacy.genTx, '04000080');
assert.throws(() => job({transactions: []}), /requires coinbasetxn/);

const Pool = load('pool.js', {async: {}, './varDiff.js': {}, './daemon.js': {},
    './peer.js': {}, './stratum.js': {}, './jobManager.js': {}, './util.js': util},
    {algos: {equihash: {}}});
[{rewardRecipients: {address: 1}}, {poolHex: 'abcd'}].forEach(options =>
    assert.throws(() => new Pool(Object.assign({coin: {algorithm: 'equihash', daemonCoinbase: true}},
        options)), /Daemon coinbase mode/));
assert.doesNotThrow(() => new Pool({coin: {algorithm: 'equihash', daemonCoinbase: true},
    paymentProcessing: {enabled: true}}));
assert.doesNotThrow(() => new Pool({coin: {algorithm: 'equihash'}, rewardRecipients: {address: 1}}));
console.log('Daemon coinbase serialization and legacy routing checks passed (not consensus acceptance).');

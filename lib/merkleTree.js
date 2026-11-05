var Promise = require('promise');
var merklebitcoin = Promise.denodeify(require('merkle-bitcoin'));
var util = require('./util.js');


function calcRoot(hashes) {
    var result = merklebitcoin(hashes);
    //console.log(Object.values(result)[2].root);
    return Object.values(result)[2].root;
}

exports.getRoot = function (rpcData, generateTxRaw, daemonCoinbase) {
    if (daemonCoinbase) {
        if (rpcData.defaultroots && rpcData.defaultroots.merkleroot)
            return util.reverseHex(rpcData.defaultroots.merkleroot);
        // Zcash GBT hashes are display-order txids; authorization digests are separate.
        var leaves = [generateTxRaw].concat(rpcData.transactions.map(function (tx) {
            return tx.txid !== undefined ? tx.txid : tx.hash;
        })).map(function (hash) {
            return Buffer.from(hash, 'hex').reverse();
        });
        while (leaves.length > 1) {
            var parents = [];
            for (var i = 0; i < leaves.length; i += 2)
                parents.push(util.sha256d(Buffer.concat([leaves[i], leaves[i + 1] || leaves[i]])));
            leaves = parents;
        }
        return leaves[0].toString('hex');
    }
    hashes = [util.reverseBuffer(new Buffer(generateTxRaw, 'hex')).toString('hex')];
    rpcData.transactions.forEach(function (value) {
        // Segwit support
        if (value.txid !== undefined) {
            hashes.push(value.txid);
        } else {
            hashes.push(value.hash);
        }    
    });
    if (hashes.length === 1) {
        return hashes[0];
    }
    var result = calcRoot(hashes);
    return result;
};

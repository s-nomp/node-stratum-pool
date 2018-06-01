var bitcoin = require('bitcoinjs-lib-zcash');
var util = require('./util.js');

// public members
var txHash;

exports.txHash = function(){
    return txHash;
};

function scriptCompile(addrHash){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_DUP,
            bitcoin.opcodes.OP_HASH160,
            addrHash,
            bitcoin.opcodes.OP_EQUALVERIFY,
            bitcoin.opcodes.OP_CHECKSIG
        ]);
    return script;
}

function scriptFoundersCompile(address){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_HASH160,
            address,
            bitcoin.opcodes.OP_EQUAL
        ]);
    return script;
}


exports.createGeneration = function(blockHeight, blockReward, feeReward, recipients, poolAddress, payFoundersReward, percentFoundersReward, maxFoundersRewardBlockHeight, foundersRewardAddressChangeInterval, vFoundersRewardAddress, percentTreasuryReward, treasuryRewardStartBlockHeight, treasuryRewardAddressChangeInterval, vTreasuryRewardAddress, masternodeReward, masternodePayee, masternodePayment, percentTreasuryUpdateReward, treasuryRewardUpdateStartBlockHeight, treasuryRewardUpdateAddressChangeInterval, vTreasuryRewardUpdateAddress, percentSecureNodesReward, vSecureNodesRewardAddress, percentSuperNodesReward, vSuperNodesRewardAddress, overwinter) {
    var poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash;
    if (masternodePayee !== undefined) {
        var masternodeAddrHash = bitcoin.address.fromBase58Check(masternodePayee).hash;
    }
    if (masternodePayment === undefined ) {
        masternodePayment = false;
    }
    var tx = new bitcoin.Transaction();

    if (overwinter) {
        tx.setOverwinter();
    }

    // input for coinbase tx
    if (blockHeight.toString(16).length % 2 === 0) {
        var blockHeightSerial = blockHeight.toString(16);
    } else {
        var blockHeightSerial = '0' + blockHeight.toString(16);
    }
    var height = Math.ceil((blockHeight << 1).toString(2).length / 8);
    var lengthDiff = blockHeightSerial.length/2 - height;
    for (var i = 0; i < lengthDiff; i++) {
        blockHeightSerial = blockHeightSerial + '00';
    }
    length = '0' + height;
    var serializedBlockHeight = new Buffer.concat([
        new Buffer(length, 'hex'),
        util.reverseBuffer(new Buffer(blockHeightSerial, 'hex')),
        new Buffer('00', 'hex') // OP_0
    ]);

    tx.addInput(new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
        4294967295,
        4294967295,
        new Buffer.concat([serializedBlockHeight,
            Buffer('44656661756C74207A2D6E6F6D7020706F6F6C2068747470733A2F2F6769746875622E636F6D2F7A2D6E6F6D702F7A2D6E6F6D702F77696B692F496E73696768742D706F6F6C2D6C696E6B', 'hex')]) // Default z-nomp pool https://github.com/z-nomp/z-nomp/wiki/Insight-pool-link
    );

    // calculate total fees
    var feePercent = 0;
    for (var i = 0; i < recipients.length; i++) {
        feePercent = feePercent + recipients[i].percent;
    }

    if(masternodePayment === false) {
        // txs with founders reward
        if (payFoundersReward === true && (maxFoundersRewardBlockHeight >= blockHeight || treasuryRewardStartBlockHeight || treasuryRewardUpdateStartBlockHeight)) {
            // treasury reward or Super Nodes treasury update?
            if (treasuryRewardUpdateStartBlockHeight && blockHeight >= treasuryRewardUpdateStartBlockHeight) {

                // treasury reward
                var indexCF = parseInt(Math.floor(((blockHeight - treasuryRewardUpdateStartBlockHeight) / treasuryRewardUpdateAddressChangeInterval) % vTreasuryRewardUpdateAddress.length));
                var foundersAddrHash = bitcoin.address.fromBase58Check(vTreasuryRewardUpdateAddress[indexCF]).hash;

                // Secure Nodes reward
                var indexSN = parseInt(Math.floor(((blockHeight - treasuryRewardUpdateStartBlockHeight) / treasuryRewardUpdateAddressChangeInterval) % vSecureNodesRewardAddress.length));
                var secureNodesAddrHash = bitcoin.address.fromBase58Check(vSecureNodesRewardAddress[indexSN]).hash;

                // Super Nodes reward
                var indexXN = parseInt(Math.floor(((blockHeight - treasuryRewardUpdateStartBlockHeight) / treasuryRewardUpdateAddressChangeInterval) % vSuperNodesRewardAddress.length));
                var superNodesAddrHash = bitcoin.address.fromBase58Check(vSuperNodesRewardAddress[indexXN]).hash;

                //console.log("treasuryIndex: "+indexCF);
                //console.log("treasuryAddr:  "+vTreasuryRewardUpdateAddress[indexCF]);
                //console.log("secureNodesIndex: "+indexSN);
                //console.log("secureNodesAddr:  "+vSecureNodesRewardAddress[indexSN]);
                //console.log("superNodesIndex: "+indexXN);
                //console.log("superNodesAddr:  "+vSuperNodesRewardAddress[indexXN]);

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (percentTreasuryUpdateReward + percentSecureNodesReward + percentSuperNodesReward + feePercent) / 100)) + feeReward
                );
                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (percentTreasuryUpdateReward / 100))
                );
                // Secure Nodes t-addr
                tx.addOutput(
                    scriptFoundersCompile(secureNodesAddrHash),
                    Math.round(blockReward * (percentSecureNodesReward / 100))
                );
                // Super Nodes t-addr
                tx.addOutput(
                    scriptFoundersCompile(superNodesAddrHash),
                    Math.round(blockReward * (percentSuperNodesReward / 100))
                );

            // founders or treasury reward?
            } else if (treasuryRewardStartBlockHeight && blockHeight >= treasuryRewardStartBlockHeight) {

                // treasury reward
                var index = parseInt(Math.floor(((blockHeight - treasuryRewardStartBlockHeight) / treasuryRewardAddressChangeInterval) % vTreasuryRewardAddress.length));
                var foundersAddrHash = bitcoin.address.fromBase58Check(vTreasuryRewardAddress[index]).hash;

                //console.log("treasuryIndex: "+index);
                //console.log("treasuryAddr:  "+vTreasuryRewardAddress[index]);

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (percentTreasuryReward + feePercent) / 100)) + feeReward
                );
                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (percentTreasuryReward / 100))
                );

            } else {

                // founders reward
                var index = parseInt(Math.floor(blockHeight / foundersRewardAddressChangeInterval));
                var foundersAddrHash = bitcoin.address.fromBase58Check(vFoundersRewardAddress[index]).hash;

                //console.log("foundersIndex: "+index);
                //console.log("foundersAddr:  "+vFoundersRewardAddress[index]);

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (percentFoundersReward + feePercent) / 100)) + feeReward
                );
                // founders t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (percentFoundersReward / 100))
                );
            }

        // no founders rewards :)
        } else {
            // pool t-addr
            tx.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward * (1 - (feePercent / 100))) + feeReward
            );
        }
    }
    else
    {
        // txs with founders reward
        if (payFoundersReward === true && (maxFoundersRewardBlockHeight >= blockHeight || treasuryRewardStartBlockHeight)) {

            // founders or treasury reward?
            if (treasuryRewardStartBlockHeight && blockHeight >= treasuryRewardStartBlockHeight) {

                // treasury reward
                var index = parseInt(Math.floor(((blockHeight - treasuryRewardStartBlockHeight) / treasuryRewardAddressChangeInterval) % vTreasuryRewardAddress.length));
                var foundersAddrHash = bitcoin.address.fromBase58Check(vTreasuryRewardAddress[index]).hash;

                //console.log("treasuryIndex: "+index);
                //console.log("treasuryAddr:  "+vTreasuryRewardAddress[index]);

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (percentTreasuryReward + feePercent) / 100)) + feeReward - masternodeReward
                );
                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (percentTreasuryReward / 100))
                );
                //masternode reward
                tx.addOutput(
                    scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                );

            } else {

                // founders reward
                var index = parseInt(Math.floor(blockHeight / foundersRewardAddressChangeInterval));
                var foundersAddrHash = bitcoin.address.fromBase58Check(vFoundersRewardAddress[index]).hash;

                //console.log("foundersIndex: "+index);
                //console.log("foundersAddr:  "+vFoundersRewardAddress[index]);

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (percentFoundersReward + feePercent) / 100)) + feeReward - masternodeReward
                );
                // founders t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (percentFoundersReward / 100))
                );
                //masternode reward
                tx.addOutput(
                    scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                );

            }

        } else {

            // founders reward
            var index = parseInt(Math.floor(blockHeight / foundersRewardAddressChangeInterval));
            var foundersAddrHash = bitcoin.address.fromBase58Check(vFoundersRewardAddress[index]).hash;

            //console.log("foundersIndex: "+index);
            //console.log("foundersAddr:  "+vFoundersRewardAddress[index]);

            // pool t-addr
            tx.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward * (1 - (feePercent / 100))) + feeReward - masternodeReward
            );
            //masternode reward
            tx.addOutput(
                scriptCompile(masternodeAddrHash),
                Math.round(masternodeReward)
            );
        }

    // no founders rewards :)
    } else {
        // pool t-addr
        tx.addOutput(
            scriptCompile(poolAddrHash),
            Math.round(blockReward * (1 - (feePercent / 100))) + feeReward
        );
    }

    // pool fee recipients t-addr
    for (var i = 0; i < recipients.length; i++) {
        tx.addOutput(
            scriptCompile(bitcoin.address.fromBase58Check(recipients[i].address).hash),
            Math.round(blockReward * (recipients[i].percent / 100))
        );
    }

    txHex = tx.toHex();

    // assign
    txHash = tx.getHash().toString('hex');

    /*
    console.log('txHex: ' + txHex.toString('hex'));
    console.log('txHash: ' + txHash);
    */

    return txHex;
};

module.exports.getFees = function(feeArray){
    var fee = Number();
    feeArray.forEach(function(value) {
        fee = fee + Number(value.fee);
    });
    return fee;
};

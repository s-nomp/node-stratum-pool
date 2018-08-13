const bitcoin = require('bitcoinjs-lib-zcash')
const util = require('./util.js')

const scriptCompile = addrHash => bitcoin.script.compile([
    bitcoin.opcodes.OP_DUP,
    bitcoin.opcodes.OP_HASH160,
    addrHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    bitcoin.opcodes.OP_CHECKSIG
])

const scriptFoundersCompile = address => bitcoin.script.compile([
    bitcoin.opcodes.OP_HASH160,
    address,
    bitcoin.opcodes.OP_EQUAL
])

// public members
let txHash
exports.txHash = () => txHash

exports.createGeneration = (blockHeight, blockReward, feeReward, recipients, poolAddress, poolHex, coin, masternodeReward, masternodePayee, masternodePayment) => {
    let poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash
    let tx = new bitcoin.Transaction()

    if (coin.overwinter) {
        tx.setOverwinter()
    }

    // input for coinbase tx
    let blockHeightSerial = (blockHeight.toString(16).length % 2 === 0 ? '' : '0') + blockHeight.toString(16)

    let height = Math.ceil((blockHeight << 1).toString(2).length / 8)
    let lengthDiff = blockHeightSerial.length / 2 - height
    for (let i = 0; i < lengthDiff; i++) {
        blockHeightSerial = `${blockHeightSerial}00`
    }

    let length = `0${height}`
    let serializedBlockHeight = new Buffer.concat([
        new Buffer(length, 'hex'),
        util.reverseBuffer(new Buffer(blockHeightSerial, 'hex')),
        new Buffer('00', 'hex') // OP_0
    ])

    tx.addInput(new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
        4294967295,
        4294967295,
        new Buffer.concat([
            serializedBlockHeight,
            // Default s-nomp pool https://github.com/s-nomp/s-nomp/wiki/Insight-pool-link
            Buffer(poolHex ? poolHex : '44656661756C7420732D6E6F6D7020706F6F6C2068747470733A2F2F6769746875622E636F6D2F732D6E6F6D702F732D6E6F6D702F77696B692F496E73696768742D706F6F6C2D6C696E6B', 'hex')
        ])
    )

    // calculate total fees
    let feePercent = 0
    recipients.forEach(recipient => feePercent += recipient.percent)

    // TODO: This sorely needs to be updated and simplified
    if (masternodePayment === false || masternodePayment === undefined) {
        // txs with founders reward
        // This section is for ZEN + other coins
        if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= blockHeight || coin.treasuryRewardStartBlockHeight || coin.treasuryRewardUpdateStartBlockHeight)) {
            // treasury reward or Super Nodes treasury update?
            if (coin.treasuryRewardUpdateStartBlockHeight && blockHeight >= coin.treasuryRewardUpdateStartBlockHeight) {
                // treasury reward
                let indexCF = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vTreasuryRewardUpdateAddress.length))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardUpdateAddress[indexCF]).hash

                // Secure Nodes reward
                let indexSN = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSecureNodesRewardAddress.length))
                let secureNodesAddrHash = bitcoin.address.fromBase58Check(coin.vSecureNodesRewardAddress[indexSN]).hash

                // Super Nodes reward
                let indexXN = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSuperNodesRewardAddress.length))
                let superNodesAddrHash = bitcoin.address.fromBase58Check(coin.vSuperNodesRewardAddress[indexXN]).hash

                // console.log(`treasuryIndex: ${indexCF}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardUpdateAddress[indexCF]}`)
                // console.log(`secureNodesIndex: ${indexSN}`)
                // console.log(`secureNodesAddr:  ${coin.vSecureNodesRewardAddress[indexSN]}`)
                // console.log(`superNodesIndex: ${indexXN}`)
                // console.log(`superNodesAddr:  ${coin.vSuperNodesRewardAddress[indexXN]}`)

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryUpdateReward + coin.percentSecureNodesReward + coin.percentSuperNodesReward + feePercent) / 100)) + feeReward
                )

                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryUpdateReward / 100))
                )

                // Secure Nodes t-addr
                tx.addOutput(
                    scriptFoundersCompile(secureNodesAddrHash),
                    Math.round(blockReward * (coin.percentSecureNodesReward / 100))
                )

                // Super Nodes t-addr
                tx.addOutput(
                    scriptFoundersCompile(superNodesAddrHash),
                    Math.round(blockReward * (coin.percentSuperNodesReward / 100))
                )

            // founders or treasury reward?
            } else if (coin.treasuryRewardStartBlockHeight && blockHeight >= coin.treasuryRewardStartBlockHeight) {
                // treasury reward
                let index = parseInt(Math.floor(((blockHeight - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash

                // console.log(`treasuryIndex: ${index}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardAddress[index]}`)

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward
                )

                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryReward / 100))
                )
            } else {
                // founders reward
                let index = parseInt(Math.floor(blockHeight / coin.foundersRewardAddressChangeInterval))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash

                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward
                );

                // founders t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentFoundersReward / 100))
                )
            }
        // no founders rewards :)
        } else {
            // pool t-addr
            tx.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward * (1 - (feePercent / 100))) + feeReward
            )
        }
    } else {
        // This section is for SnowGem
        let masternodeAddrHash = masternodePayee ? bitcoin.address.fromBase58Check(masternodePayee).hash : null

        // txs with founders reward
        if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= blockHeight || coin.treasuryRewardStartBlockHeight)) {
            // founders or treasury reward?
            if (coin.treasuryRewardStartBlockHeight && blockHeight >= coin.treasuryRewardStartBlockHeight) {
                // treasury reward
                let index = parseInt(Math.floor(((blockHeight - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash

                // console.log(`treasuryIndex: ${index}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardAddress[index]}`)

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward - masternodeReward
                )

                // treasury t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryReward / 100))
                )

                //masternode reward
                tx.addOutput(
                    scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                )
            } else {
                // founders reward
                let index = parseInt(Math.floor(blockHeight / coin.foundersRewardAddressChangeInterval))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash

                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                // pool t-addr
                tx.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward - masternodeReward
                )

                // founders t-addr
                tx.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentFoundersReward / 100))
                )

                //masternode reward
                tx.addOutput(
                    scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                )
            }
        // no founders rewards :)
        } else {
            // pool t-addr
            tx.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward * (1 - (feePercent / 100))) + feeReward - masternodeReward
            )

            //masternode reward
            tx.addOutput(
                scriptCompile(masternodeAddrHash),
                Math.round(masternodeReward)
            )
        }
    }

    // pool fee recipients t-addr
    recipients.forEach(recipient => tx.addOutput(
        scriptCompile(bitcoin.address.fromBase58Check(recipient.address).hash),
        Math.round(blockReward * (recipient.percent / 100))
    ))

    txHex = tx.toHex()

    // assign
    txHash = tx.getHash().toString('hex')

    // console.log(`txHex: ${txHex.toString('hex')}`)
    // console.log(`txHash: ${txHash}`)

    return txHex
}

module.exports.getFees = feeArray => {
    let fee = Number()
    feeArray.forEach(value => fee += Number(value.fee))
    return fee
}

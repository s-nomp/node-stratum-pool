const bitcoin = require('bitgo-utxo-lib')
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

exports.createGeneration = (rpcData, blockReward, feeReward, recipients, poolAddress, poolHex, coin, masternodeReward, masternodePayee, masternodePayment, zelnodeBasicAddress, zelnodeBasicAmount, zelnodeSuperAddress, zelnodeSuperAmount, zelnodeBamfAddress, zelnodeBamfAmount) => {
    let poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash

    let network = coin.network
    //console.log('network: ', network)
    let txb = new bitcoin.TransactionBuilder(network)

    // Set sapling or overwinter to either true OR block height to activate.
    // NOTE: if both are set, sapling will be used.
    if (coin.sapling === true || (typeof coin.sapling === 'number' && coin.sapling <= rpcData.height)) {
        txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION);
    } else if (coin.overwinter === true || (typeof coin.overwinter === 'number' && coin.overwinter <= rpcData.height)) {
        txb.setVersion(bitcoin.Transaction.ZCASH_OVERWINTER_VERSION);
    }

    let payZelNodeRewards = false;
    if (coin.payZelNodes === true || (typeof coin.payZelNodes === 'number' && coin.payZelNodes <= Date.now() / 1000 )) {
        payZelNodeRewards = true;
    }

    // input for coinbase tx
    let blockHeightSerial = (rpcData.height.toString(16).length % 2 === 0 ? '' : '0') + rpcData.height.toString(16)

    let height = Math.ceil((rpcData.height << 1).toString(2).length / 8)
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

    txb.addInput(new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
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

    // Zcash uses fundingstreams from getblocksubsidy and no longer uses founders addresses in coins
    if(coin.vFundingStreams) {

        // pool t-addr
        txb.addOutput(
            scriptCompile(poolAddrHash),
            Math.round(Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100) + feeReward))
        );

        // loop through founders and add them to our coinbase transaction
        rpcData.fundingstreams.map((founderItem) => {
            txb.addOutput(
                scriptFoundersCompile(bitcoin.address.fromBase58Check(founderItem.address).hash),
                founderItem.valueZat
            );
        });

    }

    // TODO: This sorely needs to be updated and simplified
    else if ((masternodePayment === false || masternodePayment === undefined) && payZelNodeRewards === false && !rpcData.coinbase_required_outputs) {
        // txs with founders reward
        // This section is for ZEN + other coins
        if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= rpcData.height || coin.symbol === 'zen' || coin.symbol === 'zent' || coin.payAllFounders === true)) {
            // This section is for Horizen
            if (coin.symbol === 'zen' || coin.symbol === 'zent') {

                // select the correct fork for current height
                let forkIndex = coin.forks.findIndex((f) => rpcData.height < f.activationHeight);
                // set to last fork in case rpcData.height > coin.forks[coin.forks.length - 1].activationHeight
                forkIndex = forkIndex === -1 ? coin.forks.length : forkIndex;
                let fork = coin.forks[forkIndex - 1];

                let pctTreasury = fork.treasury ? fork.treasury.pct : 0;
                let pctSecureNodes = fork.securenodes ? fork.securenodes.pct : 0;
                let pctSuperNodes = fork.supernodes ? fork.supernodes.pct : 0;

                // pool t-addr
                txb.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward.total * (1 - (pctTreasury + pctSecureNodes + pctSuperNodes + feePercent) / 100)) + feeReward
                )

                // treasury reward
                if (pctTreasury) {
                    let indexTre = fork.treasury.changeInterval ? parseInt(Math.floor(((rpcData.height - fork.activationHeight) / fork.treasury.changeInterval) % fork.treasury.addresses.length)) : 0;
                    let treasuryAddrHash = bitcoin.address.fromBase58Check(fork.treasury.addresses[indexTre]).hash;
                    txb.addOutput(
                        scriptFoundersCompile(treasuryAddrHash),
                        Math.round(blockReward.total * (pctTreasury / 100))
                    )
                }

                // Secure Nodes reward
                if (pctSecureNodes) {
                    let indexSec = fork.securenodes.changeInterval ? parseInt(Math.floor(((rpcData.height - fork.activationHeight) / fork.securenodes.changeInterval) % fork.securenodes.addresses.length)) : 0;
                    let secureNodesAddrHash = bitcoin.address.fromBase58Check(fork.securenodes.addresses[indexSec]).hash;
                    txb.addOutput(
                        scriptFoundersCompile(secureNodesAddrHash),
                        Math.round(blockReward.total * (pctSecureNodes / 100))
                    )
                }

                // Super Nodes reward
                if (pctSuperNodes) {
                    let indexSup = fork.supernodes.changeInterval ? parseInt(Math.floor(((rpcData.height - fork.activationHeight) / fork.supernodes.changeInterval) % fork.supernodes.addresses.length)) : 0;
                    let superNodesAddrHash = bitcoin.address.fromBase58Check(fork.supernodes.addresses[indexSup]).hash;
                    txb.addOutput(
                        scriptFoundersCompile(superNodesAddrHash),
                        Math.round(blockReward.total * (pctSuperNodes / 100))
                    )
                }

            } else if (coin.payAllFounders === true) {
                // SafeCash / Genx
                // Calculate and do the pool fee deduction
                var poolFeeDeductionTotalPercent = 0;
                // Calculate the total pool fee deduction
                recipients.forEach(function (recipient) {
                    poolFeeDeductionTotalPercent += recipient.percent;
                });

                var poolDeductionAmount = Math.round(blockReward.total * (poolFeeDeductionTotalPercent / 100));

                txb.addOutput(
                    scriptCompile(poolAddrHash),
                    blockReward.miner - poolDeductionAmount + feeReward
                    );

                // Infrastructure
                if (rpcData.infrastructure && rpcData.infrastructure > 0)
                {
                    let infrastructureAddrHash = bitcoin.address.fromBase58Check(coin.infrastructureAddresses[0]).hash
                    txb.addOutput(scriptFoundersCompile(infrastructureAddrHash), blockReward.infrastructure);
                }
                // Giveaways
                if (rpcData.giveaways && rpcData.giveaways > 0)
                {
                    let giveawaysAddrHash = bitcoin.address.fromBase58Check(coin.giveawayAddresses[0]).hash
                    txb.addOutput(scriptFoundersCompile(giveawaysAddrHash), blockReward.giveaways);
                }
                // Add founders
                if (rpcData.founders && rpcData.founders.length > 0)
                {
                    // loop through founders and add them to our coinbase transaction
                    rpcData.founders.map((founderItem) => {
                        txb.addOutput(
                            new Buffer(founderItem.script, 'hex'),
                            founderItem.amount
                        );
                    });
                }
                // Add masternode payments
                if (rpcData.masternodes && rpcData.masternodes.length > 0)
                {
                    // loop through masternodes and add them to our coinbase transaction
                    rpcData.masternodes.map((masternodeItem) => {
                        txb.addOutput(
                            new Buffer(masternodeItem.script, 'hex'),
                            masternodeItem.amount
                        );
                    });
                }
                // Add governance payments
                if (rpcData.governanceblock && rpcData.governanceblock.length > 0)
                {
                    // loop through governance items and add them to our coinbase transaction
                    rpcData.governanceblock.map((governanceItem) => {
                        txb.addOutput(
                            new Buffer(governanceItem.script, 'hex'),
                            governanceItem.amount
                        );
                    });
                }
            } else if(Array.isArray(coin.vYcashFoundersRewardAddress)) {
                // Founders reward for Ycash
                let foundersAddrHash = bitcoin.address.fromBase58Check(rpcData.coinbasetxn.foundersaddress).hash

                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vYcashFoundersRewardAddress[index]}`)

                // pool t-addr
                txb.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward
                );

                // founders t-addr
                txb.addOutput(
                    scriptCompile(foundersAddrHash),
                    Math.round(blockReward.total * (coin.percentFoundersReward / 100))
                )
            } else {
                // founders reward
                let index = parseInt(Math.floor(rpcData.height / coin.foundersRewardAddressChangeInterval))
                let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash

                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                // pool t-addr
                txb.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward
                );

                // founders t-addr
                txb.addOutput(
                    scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward.total * (coin.percentFoundersReward / 100))
                )
            }
            // no founders rewards :)
        } else {
            // pool t-addr
            txb.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward
            )
        }
    } else if (payZelNodeRewards === false && rpcData.coinbase_required_outputs && rpcData.coinbase_required_outputs.length) {
        // This section is for ANON (Anonymous Bitcoin)
        // ANON getblocktemplate provides an array of objects
        // (coinbase_required_outputs) it contains all the required coinbase
        // outputs (masternode, developement fund, superblocks) each object has
        // the following keys: amount, script (hex), type. 'type' provides
        // short info about the purpose of the output for example 'masternode',
        // 'development' or 'superblock'

        // keep track of total the amount of all outputs (except superblock) in coinbase_required_outputs array
        let required_outputs_total = 0;

        // loop through coinbase_required_outputs and add them to our coinbase transaction
        rpcData.coinbase_required_outputs.map((output) => {
            if (output.type !== "superblock") {
                required_outputs_total += output.amount;
            }

            txb.addOutput(
                new Buffer(output.script, 'hex'),
                output.amount
            )
        })

        // we want to calculate pool fee using miner reward only
        blockReward.total -= required_outputs_total;

        //now pay to the pool address
        txb.addOutput(
            scriptCompile(poolAddrHash),
            ((blockReward.total) * (1 - feePercent / 100) + feeReward)
        )
    } else if (payZelNodeRewards === false) {
        let masternodeAddrHash = masternodePayee ? bitcoin.address.fromBase58Check(masternodePayee).hash : null

        if (rpcData.founderAddress) {
          // This section is for Gemlink
          if (rpcData.gemlink) {
            // founders reward
            let founderAddrHash = bitcoin.address.fromBase58Check(
              rpcData.founderAddress
            ).hash;
            let treasuryReward = rpcData.treasuryReward
              ? rpcData.treasuryReward
              : 0;
            let premineReward = rpcData.premineReward ? rpcData.premineReward : 0;
    
            blockReward.total -= premineReward;
            let poolAmount =
              Math.round(
                blockReward.total *
                  (1 - rpcData.founderReward / blockReward.total - feePercent / 100)
              ) +
              feeReward -
              masternodeReward -
              treasuryReward;
    
            // pool t-addr
            txb.addOutput(scriptCompile(poolAddrHash), poolAmount);
    
            // console.log(rpcData.founderReward)
            // founders t-addr
            if (!!rpcData.founderReward) {
              txb.addOutput(
                scriptFoundersCompile(founderAddrHash),
                Math.round(rpcData.founderReward)
              );
            }
    
            //masternode reward
            if (!!masternodeReward) {
              txb.addOutput(
                scriptCompile(masternodeAddrHash),
                Math.round(masternodeReward)
              );
            }
    
            if (rpcData.treasuryAddress && !!treasuryReward) {
              let treasuryAddrHash = bitcoin.address.fromBase58Check(
                rpcData.treasuryAddress
              ).hash;
              //treasury tx
              txb.addOutput(
                scriptFoundersCompile(treasuryAddrHash),
                Math.round(treasuryReward)
              );
            }
    
            if (!!premineReward) {
              let premineAddrHash = bitcoin.address.fromBase58Check(
                rpcData.premineAddress
              ).hash;
              //treasury tx
              txb.addOutput(
                scriptFoundersCompile(premineAddrHash),
                Math.round(premineReward)
              );
            }
            // end gemlink
          } else {
            // This section is for SnowGem
            // founders reward
            let founderAddrHash = bitcoin.address.fromBase58Check(
              rpcData.founderAddress
            ).hash;
            let treasuryReward = rpcData.treasuryReward
              ? rpcData.treasuryReward
              : 0;
            // console.log(`foundersAddr:  ${rpcData.founderAddress}`)
    
            // pool t-addr
            txb.addOutput(
              scriptCompile(poolAddrHash),
              Math.round(
                blockReward.total *
                  (1 - rpcData.founderReward / blockReward.total - feePercent / 100)
              ) +
                feeReward -
                masternodeReward -
                treasuryReward
            );
    
            // console.log(rpcData.founderReward)
            // founders t-addr
            txb.addOutput(
              scriptFoundersCompile(founderAddrHash),
              Math.round(rpcData.founderReward)
            );
    
            //masternode reward
            txb.addOutput(
              scriptCompile(masternodeAddrHash),
              Math.round(masternodeReward)
            );
    
            if (rpcData.treasuryAddress) {
              let treasuryAddrHash = bitcoin.address.fromBase58Check(
                rpcData.treasuryAddress
              ).hash;
              //treasury tx
              txb.addOutput(
                scriptFoundersCompile(treasuryAddrHash),
                Math.round(treasuryReward)
              );
            }

            // end SnowGem
          }
        }

        // start Vidulum
        else if(coin.VRSEnabled && rpcData.vrsAddress && rpcData.height >= coin.VRSBlock) {
            // Vidulum Reward System
            let vrsAddrHash = bitcoin.address.fromBase58Check(rpcData.vrsAddress).hash

            // this prevents NaN error
            feeReward = feeReward || 0;
            feePercent = feePercent || 0;
            masternodeReward = masternodeReward || 0;

            // pool t-addr
            txb.addOutput(
                scriptCompile(poolAddrHash),
                Math.round(blockReward.total * (1 - rpcData.vrsReward / blockReward.total - feePercent / 100)) + feeReward - masternodeReward
            )

            // Vidulum Reward System t-addr
            txb.addOutput(
                scriptFoundersCompile(vrsAddrHash),
                Math.round(rpcData.vrsReward)
            )

            //masternode reward
            txb.addOutput(
                scriptCompile(masternodeAddrHash),
                Math.round(masternodeReward)
            )
        }
        //end Vidulum

        else
        {
            // txs with founders reward
            if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= rpcData.height || coin.treasuryRewardStartBlockHeight)) {
                // founders or treasury reward?
                if (coin.treasuryRewardStartBlockHeight && rpcData.height >= coin.treasuryRewardStartBlockHeight) {
                    // treasury reward
                    let index = parseInt(Math.floor(((rpcData.height - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length))
                    let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash

                    // console.log(`treasuryIndex: ${index}`)
                    // console.log(`treasuryAddr:  ${coin.vTreasuryRewardAddress[index]}`)

                    // pool t-addr
                    txb.addOutput(
                        scriptCompile(poolAddrHash),
                        Math.round(blockReward.total * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward - masternodeReward
                    )

                    // treasury t-addr
                    txb.addOutput(
                        scriptFoundersCompile(foundersAddrHash),
                        Math.round(blockReward.total * (coin.percentTreasuryReward / 100))
                    )

                    //masternode reward
                    txb.addOutput(
                        scriptCompile(masternodeAddrHash),
                        Math.round(masternodeReward)
                    )
                } else {
                    // founders reward
                    let index = parseInt(Math.floor(rpcData.height / coin.foundersRewardAddressChangeInterval))
                    let foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash

                    // console.log(`foundersIndex: ${index}`)
                    // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                    // pool t-addr
                    txb.addOutput(
                        scriptCompile(poolAddrHash),
                        Math.round(blockReward.total * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward - masternodeReward
                    )

                    // founders t-addr
                    txb.addOutput(
                        scriptFoundersCompile(foundersAddrHash),
                        Math.round(blockReward.total * (coin.percentFoundersReward / 100))
                    )

                    //masternode reward
                    txb.addOutput(
                        scriptCompile(masternodeAddrHash),
                        Math.round(masternodeReward)
                    )
                }
                // no founders rewards :)
            } else {
                // Note: For ANON coin, it enters this code when fullnode doesn't
                // return any masternode payee This should never happen on mainnet,
                // since there are plenty of masternodes. But, it is possible on
                // ANON testnet, since there are not so many masternodes.

                // this prevents NaN error
                feeReward = feeReward || 0;
                feePercent = feePercent || 0;
                masternodeReward = masternodeReward || 0;

                // pool t-addr
                txb.addOutput(
                    scriptCompile(poolAddrHash),
                    Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward - masternodeReward
                )

                // masternode reward
                // what if there is no masternode winner?
                if (masternodeAddrHash) {
                    txb.addOutput(
                        scriptCompile(masternodeAddrHash),
                        Math.round(masternodeReward)
                    )
                }
            }
        }
    } else {
        // case for ZelCash
        let zelnodeBasicAddrHash = zelnodeBasicAddress ? bitcoin.address.fromBase58Check(zelnodeBasicAddress).hash : null
        let zelnodeSuperAddrHash = zelnodeSuperAddress ? bitcoin.address.fromBase58Check(zelnodeSuperAddress).hash : null
        let zelnodeBamfAddrHash = zelnodeBamfAddress ? bitcoin.address.fromBase58Check(zelnodeBamfAddress).hash : null

        // pool t-addr
        txb.addOutput(
            scriptCompile(poolAddrHash),
            Math.round(blockReward.total * (1 - (feePercent / 100))) + feeReward - zelnodeBasicAmount - zelnodeSuperAmount - zelnodeBamfAmount
        )

        // zelnode basic reward
        if (zelnodeBasicAddrHash != null) {
            txb.addOutput(
                scriptCompile(zelnodeBasicAddrHash),
                Math.round(zelnodeBasicAmount)
            )
        }

        // zelnode super reward
        if (zelnodeSuperAddrHash != null) {
            txb.addOutput(
                scriptCompile(zelnodeSuperAddrHash),
                Math.round(zelnodeSuperAmount)
            )
        }

        // zelnode bamf reward
        if (zelnodeBamfAddrHash != null) {
            txb.addOutput(
                scriptCompile(zelnodeBamfAddrHash),
                Math.round(zelnodeBamfAmount)
            )
        }
    }

    // Segwit support
    if (rpcData.default_witness_commitment !== undefined) {
        txb.addOutput(new Buffer(rpcData.default_witness_commitment, 'hex'), 0);
    }

    // pool fee recipients t-addr
    if (recipients.length > 0 && recipients[0].address != '') {
        let burn = 0
        if (coin.burnFees) {
            burn = feeReward
        }
        recipients.forEach(recipient => {
            txb.addOutput(
                scriptCompile(bitcoin.address.fromBase58Check(recipient.address).hash),
                Math.round(blockReward.total * (recipient.percent / 100) - burn)
            )
            burn = 0
        })
    }

    let tx = txb.build()

    txHex = tx.toHex()
    // console.log('hex coinbase transaction: ' + txHex)

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

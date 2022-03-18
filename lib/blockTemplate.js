var bignum = require('bignum');

var merkle = require('./merkleTree.js');
var transactions = require('./transactions.js');
var util = require('./util.js');

/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
var BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    extraNoncePlaceholder,
    recipients,
    poolAddress,
    poolHex,
    coin,
    daemon
) {
    //private members
    var submits = [];

    //public members
    this.rpcData = rpcData;
    this.jobId = jobId;
    this.algoNK = coin.parameters && coin.parameters.N && coin.parameters.K ? coin.parameters.N+'_'+coin.parameters.K : undefined;
    this.persString = coin.parameters ? coin.parameters.personalization : undefined;

    // get target info
    this.target = bignum(rpcData.target, 16);

    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

    // generate the fees and coinbase tx
    let blockReward = {
        'total': (this.rpcData.miner) * (coin.subsidyMultipleOfSatoshi || 100000000)
    };

    var masternodeReward;
    var masternodePayee;
    var masternodePayment;
    var zelnodeBasicAddress;
    var zelnodeBasicAmount;
    var zelnodeSuperAddress;
    var zelnodeSuperAmount;
    var zelnodeBamfAddress;
    var zelnodeBamfAmount;

    if (coin.vFundingStreams) {
        // Zcash has moved to fundingstreams via getblocksubsidy.
        // This will calculate block reward and fundingstream totals.

        fundingstreamTotal = 0;
        for (var i = 0, len = this.rpcData.fundingstreams.length; i < len; i++) {
            fundingstreamTotal += this.rpcData.fundingstreams[i]["valueZat"];
        }

        blockReward = {
            "miner": (this.rpcData.miner * 100000000),
            "fundingstream": (fundingstreamTotal),
            "total": (this.rpcData.miner * 100000000 + fundingstreamTotal)
        }
    } else if (coin.payFoundersReward === true) {
        if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
            console.log('Error, founders reward missing for block template!');
        } else if (coin.payAllFounders) {
            // SafeCash / Genx
            if (!rpcData.masternode_payments_started) {
                // Pre masternodes
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderSplit": (this.rpcData.loki),
                    "total": (this.rpcData.miner + this.rpcData.founderstotal + this.rpcData.infrastructure + this.rpcData.giveaways)
                };
                //console.log(`SafeCash: ${this.rpcData.miner}`);
            } else {
                // console.log(this.rpcData);
                // Masternodes active
                blockReward = {
                    "miner": (this.rpcData.miner),
                    "infrastructure": (this.rpcData.infrastructure),
                    "giveaways": (this.rpcData.giveaways),
                    "founderamount": (this.rpcData.founderamount),
                    "total": (this.rpcData.coinbasevalue)
                };
            }
        } else if (this.rpcData.gemlink) {
            blockReward = {
                "total": (this.rpcData.miner + this.rpcData.founders + (this.rpcData.treasury || 0) + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000 + (this.rpcData.premineReward || 0)
            };
        }
         else {
            blockReward = {
                "total": (this.rpcData.miner + this.rpcData.founders + (this.rpcData.treasury || 0) + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000
            };
        }
    }

    //Vidulum VRS Support
    if (coin.VRSEnabled === true) {
        //VRS Activation is Live
        if (this.rpcData.height >= coin.VRSBlock) {
            if (!this.rpcData.vrsReward || this.rpcData.vrsReward.length <= 0) {
                console.log('Error, vidulum reward system payout missing for block template!');
            } else {
                blockReward = {
                    "total": (this.rpcData.miner * 100000000) + this.rpcData.vrsReward + this.rpcData.payee_amount
                };
            }
        } else { //VRS Ready but not yet activated by chain
            blockReward = {
                "total": (this.rpcData.miner * 100000000) + this.rpcData.payee_amount
            };
        }
    }

    masternodeReward = rpcData.payee_amount;
    masternodePayee = rpcData.payee;
    masternodePayment = rpcData.masternode_payments;
    zelnodeBasicAddress = coin.payZelNodes ? rpcData.basic_zelnode_address : null;
    zelnodeBasicAmount = coin.payZelNodes ? (rpcData.basic_zelnode_payout || 0) : 0;
    zelnodeSuperAddress = coin.payZelNodes ? rpcData.super_zelnode_address : null;
    zelnodeSuperAmount = coin.payZelNodes ? (rpcData.super_zelnode_payout || 0) : 0;
    zelnodeBamfAddress = coin.payZelNodes ? rpcData.bamf_zelnode_address : null;
    zelnodeBamfAmount = coin.payZelNodes ? (rpcData.bamf_zelnode_payout || 0) : 0;

    var fees = [];
    rpcData.transactions.forEach(function (value) {
        fees.push(value);
    });
    this.rewardFees = transactions.getFees(fees);
    rpcData.rewardFees = this.rewardFees;

    if (typeof this.genTx === 'undefined') {
        this.genTx = transactions.createGeneration(
            rpcData,
            blockReward,
            this.rewardFees,
            recipients,
            poolAddress,
            poolHex,
            coin,
            masternodeReward,
            masternodePayee,
            masternodePayment,
            zelnodeBasicAddress,
            zelnodeBasicAmount,
            zelnodeSuperAddress,
            zelnodeSuperAmount,
            zelnodeBamfAddress,
            zelnodeBamfAmount
        ).toString('hex');
        this.genTxHash = transactions.txHash();

        /*
        console.log('this.genTxHash: ' + transactions.txHash());
        console.log('this.merkleRoot: ' + merkle.getRoot(rpcData, this.genTxHash));
        */
    }

    // generate the merkle root
    this.prevHashReversed = util.reverseBuffer(new Buffer(rpcData.previousblockhash, 'hex')).toString('hex');
    if (rpcData.finalsaplingroothash) {
        this.hashReserved = util.reverseBuffer(new Buffer(rpcData.finalsaplingroothash, 'hex')).toString('hex');
    } else {
        this.hashReserved = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
    }
    this.merkleRoot = merkle.getRoot(rpcData, this.genTxHash);
    this.merkleRootReversed = util.reverseBuffer(new Buffer(this.merkleRoot, 'hex')).toString('hex');

    this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase
    // we can't do anything else until we have a submission

    this.txs = new Array();
    this.txs.push(this.genTx)
    for (var tx of rpcData.transactions) {
        this.txs.push(tx.data);
    }

    this.calculateTrees = async function () {
        return new Promise(resolve => {
            daemon.cmd(
                'getblockmerkleroots',
                [this.txs,
                    this.rpcData.certificates.length > 0 ? this.rpcData.certificates.map(el => el.data) : []],
                result => result.error ? resolve(result.error) : resolve(this.getTrees(result[0].response))
            )
        })
    }
    this.getTrees = function (response) {
        this.merkleRoot = response.merkleTree;
        this.hashReserved = util.reverseBuffer(new Buffer(response.scTxsCommitment, 'hex')).toString('hex');
        this.merkleRootReversed = util.reverseBuffer(new Buffer(this.merkleRoot, 'hex')).toString('hex');
        this.certCount = this.rpcData.certificates.length;
    }

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
    this.serializeHeader = function (nTime, nonce) {
        var header = new Buffer(140);
        var position = 0;

        header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
        header.write(this.prevHashReversed, position += 4, 32, 'hex');
        header.write(this.merkleRootReversed, position += 32, 32, 'hex');
        header.write(this.hashReserved, position += 32, 32, 'hex');
        header.write(nTime, position += 32, 4, 'hex');
        header.write(util.reverseBuffer(new Buffer(rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');
        header.write(nonce, position += 4, 32, 'hex');
        return header;
    };

    // join the header and txs together
    this.serializeBlock = function (header, soln) {
        var txCount = this.txCount.toString(16);
        if (Math.abs(txCount.length % 2) == 1) {
            txCount = "0" + txCount;
        }

        if (this.txCount <= 0xfc) {
            var varInt = new Buffer(txCount, 'hex');
        } else if (this.txCount <= 0x7fff) {
            if (txCount.length == 2) {
                txCount = "00" + txCount;
            }
            var varInt = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer(txCount, 'hex'))]);
        }

        buf = new Buffer.concat([
            header,
            soln,
            varInt,
            new Buffer(this.genTx, 'hex')
        ]);

        if (this.rpcData.transactions.length > 0) {
            this.rpcData.transactions.forEach(function (value) {
                tmpBuf = new Buffer.concat([buf, new Buffer(value.data, 'hex')]);
                buf = tmpBuf;
            });
        }


        if (this.rpcData.version == 3 && (coin.symbol == "zen" || coin.symbol == "zent")) {
            var certCount = this.certCount.toString(16);
            if (Math.abs(certCount.length % 2) == 1) {
                certCount = "0" + certCount;
            }
            if (this.certCount <= 0xfc) {
                var varIntCert = new Buffer(certCount, 'hex');
            } else if (this.certCount <= 0x7fff) {
                if (certCount.length == 2) {
                    certCount = "00" + certCount;
                }
                var varIntCert = new Buffer.concat([Buffer('FD', 'hex'), util.reverseBuffer(new Buffer(certCount, 'hex'))]);
            }
            tmpBuf = new Buffer(varIntCert, 'hex');
            certBuf = new Buffer.concat([buf, tmpBuf]);
            buf = certBuf;

            if (this.rpcData.certificates.length > 0) {
                this.rpcData.certificates.forEach(function (value) {
                    tmpBuf = new Buffer.concat([buf, new Buffer(value.data, 'hex')]);
                    buf = tmpBuf;
                });
            }
        }

        return buf;
    };

    // submit the block header
    this.registerSubmit = function (header, soln) {
        var submission = (header + soln).toLowerCase();
        if (submits.indexOf(submission) === -1) {

            submits.push(submission);
            return true;
        }
        return false;
    };

    // used for mining.notify
    this.getJobParams = function () {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.hashReserved,
                util.packUInt32LE(rpcData.curtime).toString('hex'),
                util.reverseBuffer(new Buffer(this.rpcData.bits, 'hex')).toString('hex'),
                true,
                this.algoNK,
                this.persString
            ];
        }
        return this.jobParams;
    };
};

var events = require('events');
var async = require('async');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');

/*process.on('uncaughtException', function(err) {
 console.log(err.stack);
 throw err;
 });*/

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };


    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }


    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };


    function GetFirstJob(finishedCallback) {

        GetBlockTemplate(function (error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            emitLog(startMessage);
            return;
        }
        var infoLines = [startMessage,
            'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + options.coin.reward,
            'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
            'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
            'Current Connect Peers:\t' + options.initStats.connections,
            'Network Difficulty:\t' + options.initStats.difficulty,
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) {
        var callConfig = {
            "capabilities": [
                "coinbasetxn",
                "workid",
                "coinbase/append"
            ]
        };

        // Segwit support
        if (options.coin.supportsSegwit)
        {
            callConfig.rules = ["segwit"];
        }

        var checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', callConfig, function (results) {
                var synced = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0')
                        generateProgress();
                }

            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });


        var generateProgress = function () {
            var cmd = options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            _this.daemon.cmd(cmd, [], function (results) {
                var blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function (results) {

                    var peers = results[0].response;
                    var totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                });

            });
        };

    }


    function SetupApi() {
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }


    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled)
            return;

        if (options.testnet && !options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function () {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function () {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function (e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function (msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
     Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(blockHex, callback) {
        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{'mode': 'submit', 'data': blockHex}];
        }

        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function (results) {
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    if (result.error) {
                        emitErrorLog('rpc error with daemon instance ' +
                            result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                            JSON.stringify(result.error)
                        );
                        return;
                    }
                    else if (result.response === 'rejected') {
                        emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                        return;
                    }
                }
                emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                callback();
            }
        );
    }

    function SetupRecipients() {
        var recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};

        for (var r in options.rewardRecipients) {
            var percent = options.rewardRecipients[r];
            var rObj = {
                percent: percent,
                address: r
            };
                recipients.push(rObj);
                options.feePercent += percent;
        }

        if (recipients.length === 0) {
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    var jobManagerLastSubmitBlockHex = false;

    function SetupJobManager() {
        options.daemon = _this.daemon
        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                var job = blockTemplate.getJobParams();
                job[8] = false;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', function (shareData, blockHex) {
            //console.log('share :', isValidShare, isValidBlock, shareData)
            var isValidShare = !shareData.error;
            var isValidBlock = !!blockHex;
            var emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
             If we calculated that the block solution was found,
             before we emit the share, lets submit the block,
             then check if it was accepted using RPC getblock
             */
            if (!isValidBlock)
                emitShare();
            else {
                if (jobManagerLastSubmitBlockHex === blockHex) {
                    emitWarningLog('Warning, ignored duplicate submit block ' + blockHex);
                } else {
                    jobManagerLastSubmitBlockHex = blockHex;
                    SubmitBlock(blockHex, function () {
                        CheckBlockAccepted(shareData.blockHash, function (isAccepted, tx) {
                            isValidBlock = isAccepted === true;
                            if (isValidBlock === true) {
                                shareData.txHash = tx;
                            } else {
                                shareData.error = tx;
                            }
                            emitShare();
                            GetBlockTemplate(function (error, result, foundNewBlock) {
                                if (foundNewBlock) {
                                    emitLog('Block notification via RPC after block submission');
                                }
                            });
                        });
                    });
                }
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemons, function (severity, message) {
            _this.emit('log', severity, message);
        });

        _this.daemon.once('online', function () {
            finishedCallback();

        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

        }).on('error', function (message) {
            emitErrorLog(message);

        });

        _this.daemon.init();
    }


    function DetectCoinData(finishedCallback) {

        var batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        if (options.coin.hasGetInfo) {
            batchRpcCalls.push(['getinfo', []]);
        } else {
            batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
        }

        _this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++) {
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }

            if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                options.coin.reward = 'POS';
            else
                options.coin.reward = 'POW';


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
             only given if address is owned by wallet.*/
            if (options.coin.reward === 'POS' && typeof(rpcResults.validateaddress.pubkey) === 'undefined') {
                emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            options.poolAddressScript = (function () {
                return util.addressToScript(rpcResults.validateaddress.address);
            })();

            options.testnet = options.coin.hasGetInfo ? rpcResults.getinfo.testnet : rpcResults.getblockchaininfo.chain === "test";
            options.protocolVersion = options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;

            var tempDifficulty = options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
            if (typeof(tempDifficulty) == 'object') {
                tempDifficulty = tempDifficulty['proof-of-work'];
            }

            options.initStats = {
                connections: (options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections),
                difficulty: tempDifficulty  * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };


            if (rpcResults.submitblock.message === 'Method not found') {
                options.hasSubmitMethod = false;
            }
            else if (rpcResults.submitblock.code === -1) {
                options.hasSubmitMethod = true;
            }
            else {
                emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                return;
            }

            finishedCallback();

        });
    }


    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            var job = _this.jobManager.currentJob.getJobParams();
            _this.stratumServer.broadcastMiningJobs(job);
            finishedCallback();

        }).on('broadcastTimeout', function () {
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetBlockTemplate( async function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                await _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) {
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                var extraNonce = _this.jobManager.extraNonceCounter.next();
                resultCallback(null,
                    extraNonce,
                    extraNonce
                );

                if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }
                var job = _this.jobManager.currentJob.getJobParams()
                this.sendMiningJob(job);

            }).on('submit', function (params, resultCallback) {
                var result = _this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,
                    params.soln
                );

                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function () {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(function (error, result, foundNewBlock) {
                if (foundNewBlock)
                    emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(callback) {
        function  getNextBlockHeight() {
            // If the current job has a height value (chainTip + 1 from last GBT RPC call) use it, as it's less expensive than doing another RPC call in a function called by each pool fork when polling.
            // On the first call after a new block has arrived this data will be outdated, but this time window is very small due to RPC polling and jobRebroadcastTimeout, and only relevant on a halving block boundry condition.
            if (typeof(_this.jobManager) !== 'undefined' && typeof(_this.jobManager.currentJob) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData.height) !== 'undefined') {
                getBlockSubsidyandTemplate(_this.jobManager.currentJob.rpcData.height);
            // Otherwise do a 'getblockcount' RPC call returning chainTip + 1, this would be the case on GetFirstJob().
            } else {
                _this.daemon.cmd(
                    'getblockcount',
                    [],
                    result => result.error ? callback(result.error) : getBlockSubsidyandTemplate(result[0].response + 1)
                )
            }
        }

        function getBlockSubsidyandTemplate(blockheight) {
            _this.daemon.cmd(
                'getblocksubsidy',
                [blockheight],
                result => result.error ? callback(result.error) : getBlockTemplate(result[0].response)
            )
        }

        function getBlockTemplate(subsidy) {
            var callConfig = {
                "capabilities": [
                    "coinbasetxn",
                    "workid",
                    "coinbase/append"
                ]
            };

            // Segwit support
            if (options.coin.supportsSegwit)
            {
                callConfig.rules = ["segwit"];
            }

            _this.daemon.cmd('getblocktemplate',
            [callConfig],
            async function (result) {
                    if (result.error) {
                        emitErrorLog('getblocktemplate call failed for daemon instance ' +
                            result.instance.index + ' with error ' + JSON.stringify(result.error));
                        callback(result.error);
                    } else {
                        result.response.miner = subsidy.miner;

                        if (options.coin.vFundingStreams) {
                            //Zcash uses fundingstreams instead of founders reward
                            result.response.fundingstreams = subsidy.fundingstreams
                        } else if (!result.response.founders)
                        {
                            result.response.founders = (subsidy.founders || subsidy.community || (subsidy['founders-chris'] + subsidy['founders-jimmy'] + subsidy['founders-scott'] + subsidy['founders-shelby'] + subsidy['founders-loki'] ));
                        } else {
                            // founders already set in block template
                            // console.log(result.response.founders);
                        }

                        //SnowGem treasury reward
                        if(subsidy.treasury)
                        {
                            result.response.treasury = subsidy.treasury
                        }

                        // I hate to do this but vision coin doesn't send the
                        // correct response for getblocksubsidy so this allows
                        // us to override.
                        if (options.coin.rewardMinersPercent) {
                            result.response.miner = options.coin.blockReward * options.coin.rewardMinersPercent
                        }

                        if (options.coin.rewardFoundersPercent) {
                            result.response.founders = options.coin.blockReward * options.coin.rewardFoundersPercent
                        }

                        result.response.securenodes = (subsidy.securenodes || 0);
                        result.response.supernodes = (subsidy.supernodes || 0);

                        // SafeCash / Genx
                        if (!result.response.masternode_payments_started) {
                            // Before masternodes
                            result.response.infrastructure = (subsidy.infrastructure || 0);
                            result.response.giveaways = (subsidy.giveaways || 0);
                            result.response.chris = (subsidy['founders-chris'] || 0);
                            result.response.jimmy = (subsidy['founders-jimmy'] || 0);
                            result.response.scott = (subsidy['founders-scott'] || 0);
                            result.response.shelby = (subsidy['founders-shelby'] || 0);
                            result.response.loki = (subsidy['founders-loki'] || 0);
                        } else {
                            // Masternodes active
                            result.response.infrastructure = (subsidy.infrastructure || 0);
                            result.response.giveaways = (subsidy.giveaways || 0);
                            result.response.masternodestotal = (subsidy.masternodestotal || 0);
                            result.response.governancetotal = (subsidy.governancetotal || 0);
                            result.response.founderstotal = (subsidy.founderstotal || 0);
                            result.response.founderamount = (subsidy.founderamount || 0);
                        }

                        var processedNewBlock =  await _this.jobManager.processTemplate(result.response);
                        callback(null, result.response, processedNewBlock);
                        callback = () => {
                        }
                    }
                }, true
            );
        }

        getNextBlockHeight();
    }


    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            function (results) {
                var validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });
                // do we have any results?
                if (validResults.length >= 1) {
                    // check for invalid blocks with negative confirmations
                    if (validResults[0].response.confirmations >= 0) {
                        // accepted valid block!
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        // reject invalid block, due to confirmations
                        callback(false, {"confirmations": validResults[0].response.confirmations});
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, {"unknown": "check coin daemon logs"});
            }
        );
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        if (typeof(_this.jobManager) !== 'undefined' && typeof(_this.jobManager.currentJob) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            GetBlockTemplate(function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            })
        }
    };


    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
             //Send new difficulty, then force miner to use new diff by resending the
             //current job parameters but with the "clean jobs" flag set to false
             //so the miner doesn't restart work and submit duplicate shares
             client.sendDifficulty(newDiff);
             var job = _this.jobManager.currentJob.getJobParams();
             job[8] = false;
             client.sendMiningJob(job);
             }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;

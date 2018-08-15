var http = require('http');
var cp = require('child_process');
var events = require('events');

var async = require('async');

/**
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
 **/

function DaemonInterface(daemons, logger) {

    //private members
    var _this = this;
    logger = logger || function (severity, message) {
            console.log(severity + ': ' + message);
        };


    var instances = (function () {
        for (var i = 0; i < daemons.length; i++)
            daemons[i]['index'] = i;
        return daemons;
    })();


    function init() {
        isOnline(function (online) {
            if (online)
                _this.emit('online');
        });
    }

    function isOnline(callback) {
        cmd('getpeerinfo', [], function (results) {
            var allOnline = results.every(function (result) {
                return !results.error;
            });
            callback(allOnline);
            if (!allOnline)
                _this.emit('connectionFailed', results);
        });
    }


    /**
     * timeout in seconds
     */
    function performHttpRequest(instance, jsonData, callback, timeout) {
        if (!timeout) {
            timeout = 60
        }

        var options = {
            hostname: (typeof(instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: instance.user + ':' + instance.password,
            headers: {
                'Content-Length': jsonData.length
            }
        };

        var parseJson = function (res, data) {
            var dataJson;

            if (res.statusCode === 401) {
                logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                dataJson = JSON.parse(data);
            }
            catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ":0");
                    parseJson(res, data);
                    return;
                }
                logger('error', 'Could not parse rpc data from daemon instance  ' + instance.index
                    + '\nRequest Data: ' + jsonData
                    + '\nReponse Data: ' + data);

            }
            if (dataJson) {
                callback(dataJson.error, dataJson, data);
            }
        };

        var req = http.request(options, function (res) {
            var data = '';
            res.setEncoding('utf8');
            res.on('data', function (chunk) {
                data += chunk;
            });
            res.on('end', function () {
                parseJson(res, data);
            });
        });

        req.setTimeout(timeout * 1000, function() {
            req.abort();
        });

        req.on('error', function (e) {
            if (e.code === 'ECONNREFUSED')
                callback({type: 'offline', message: e.message}, null);
            else
                callback({type: 'request error', message: e.message}, null);
        });

        req.end(jsonData);
    }


    //Performs a batch JSON-RPC command - only uses the first configured rpc daemon
    /* First argument must have:
     [
     [ methodName, [params] ],
     [ methodName, [params] ]
     ]
     */

    function batchCmd(cmdArray, callback, timeout) {

        var requestJson = [];

        for (var i = 0; i < cmdArray.length; i++) {
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i
            });
        }

        var serializedRequest = JSON.stringify(requestJson);

        performHttpRequest(instances[0], serializedRequest, function (error, result) {
            callback(error, result);
        }, timeout);
    }

    /* Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to every configured daemon.
     The callback function is fired once with the result from each daemon unless streamResults is
     set to true. */
    function cmd(method, params, callback, streamResults, returnRawData) {

        var results = [];

        async.each(instances, function (instance, eachCallback) {

            var itemFinished = function (error, result, data) {

                var returnObj = {
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };
                if (returnRawData) returnObj.data = data;
                if (streamResults) callback(returnObj);
                else results.push(returnObj);
                eachCallback();
                itemFinished = function () {
                };
            };

            var requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });

            performHttpRequest(instance, requestJson, function (error, result, data) {
                itemFinished(error, result, data);
            });


        }, function () {
            if (!streamResults) {
                callback(results);
            }
        });

    }


    //public members

    this.init = init;
    this.isOnline = isOnline;
    this.cmd = cmd;
    this.batchCmd = batchCmd;
}

DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

exports.interface = DaemonInterface;

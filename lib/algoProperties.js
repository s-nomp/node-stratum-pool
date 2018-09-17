var ev = require('equihashverify');
var util = require('./util.js');

var diff1 = global.diff1 = 0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

var algos = module.exports = global.algos = {
    sha256: {
        //Uncomment diff if you want to use hardcoded truncated diff
        //diff: '00000000ffff0000000000000000000000000000000000000000000000000000',
        hash: function(){
            return function(){
                return util.sha256d.apply(this, arguments);
            }
        }
    },
    'equihash': {
        multiplier: 1,
        diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        hash: function(coinOptions) {
            let parameters = coinOptions.parameters
            if (!parameters) {
                parameters = {
                    N: 200,
                    K: 9,
                    personalization: 'ZcashPoW'
                }
            }

            let N = parameters.N || 200
            let K = parameters.K || 9
            let personalization = parameters.personalization || 'ZcashPoW'

            return function() {
                return ev.verify.apply(
                    this,
                    [
                        arguments[0],
                        arguments[1],
                        personalization,
                        N,
                        K
                    ]
                )
            }
        }
    },
    'equihash144_5': {
        multiplier: 1,
        diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        hash: function(coinOptions) {
            let parameters = coinOptions.parameters
            if (!parameters) {
                parameters = {
                    N: 144,
                    K: 5,
                    personalization: 'BitcoinZ'
                }
            }

            let N = parameters.N || 144
            let K = parameters.K || 5
            let personalization = parameters.personalization || 'BitcoinZ'

            return function() {
                return ev.verify.apply(
                    this,
                    [
                        arguments[0],
                        arguments[1],
                        personalization,
                        N,
                        K
                    ]
                )
            }
        }
    },
    'equihash192_7': {
        multiplier: 1,
        diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        hash: function(coinOptions) {
            let parameters = coinOptions.parameters
            if (!parameters) {
                parameters = {
                    N: 192,
                    K: 7,
                    personalization: 'ZERO_PoW'
                }
            }

            let N = parameters.N || 192
            let K = parameters.K || 7
            let personalization = parameters.personalization || 'ZERO_PoW'

            return function() {
                return ev.verify.apply(
                    this,
                    [
                        arguments[0],
                        arguments[1],
                        personalization,
                        N,
                        K
                    ]
                )
            }
        }
    }
};

for (var algo in algos){
    if (!algos[algo].multiplier)
        algos[algo].multiplier = 1;
}

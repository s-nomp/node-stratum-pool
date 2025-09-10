# High Performance SHA256 Stratum Pool Server

High performance Stratum poolserver with enhanced SHA256 support in Node.js. One instance of this software can startup and manage multiple coin pools, each with their own daemon and stratum port :)

## 🚀 New Features in This Fork

### AsicBoost Support with Version Rolling
- **Full AsicBoost compatibility** for modern SHA256 ASIC miners
- **Version rolling** (BIP320) support for improved mining efficiency
- Automatic detection and negotiation of version rolling mask
- Compatible with all major ASIC manufacturers (Bitmain, MicroBT, Canaan, etc.)

### Solo Mining Mode
- Complete solo mining functionality
- Direct block rewards to miner addresses
- Real-time solo mining statistics

### Enhanced PROP Payout Mode
- **Fixed and properly implemented** proportional payout system
- Accurate share tracking and reward distribution
- Improved round management
- Fair distribution based on actual work contributed

---

## Notice
This is a module for Node.js that will do nothing on its own. Unless you're a Node.js developer who would like to handle stratum authentication and raw share data then this module will not be of use to you. For a full featured portal that uses this module, see [s-nomp (Some New Open Mining Portal)](https://github.com/s-nomp/s-nomp). It handles payments, website front-end, database layer, mutli-coin/pool support, auto-switching miners between coins/pools, etc.. The portal also has an [MPOS](https://github.com/MPOS/php-mpos) compatibility mode so that the it can function as a drop-in-replacement for [python-stratum-mining](https://github.com/Crypto-Expert/stratum-mining).

[![NPM](https://nodei.co/npm/stratum-pool.png?downloads=true&stars=true)](https://nodei.co/npm/stratum-pool/)

## Why
This server was built to be more efficient and easier to setup, maintain and scale than existing stratum poolservers which are written in python. Compared to the spaghetti state of the latest [stratum-mining python server](https://github.com/Crypto-Expert/stratum-mining/), this software should also have a lower barrier to entry for other developers to fork and add features or fix bugs.

## Features

### Core Features
* Daemon RPC interface
* Stratum TCP socket server
* Block template / job manager
* P2P to get block notifications as peer node
* Optimized generation transaction building
* Connecting to multiple daemons for redundancy
* Process share submissions
* Session managing for purging DDoS/flood initiated zombie workers
* Auto ban IPs that are flooding with invalid shares
* **POW** (proof-of-work) & **POS** (proof-of-stake) support
* Transaction messages support
* Vardiff (variable difficulty / share limiter)
* When started with a coin daemon that hasn't finished syncing to the network it shows the blockchain download progress and initializes once synced

### Enhanced SHA256 Features (New)
* ✓ **AsicBoost Support** - Overt AsicBoost with version rolling
* ✓ **Version Rolling (BIP320)** - Efficient nonce space distribution
* ✓ **Solo Mining Mode** - Direct mining without pool shares
* ✓ **Proper PROP Implementation** - Fair proportional reward distribution

### Hashing Algorithms Supported
* ✓ **SHA256** (Bitcoin, Bitcoin Cash, etc.)
* ✓ **SHA256 with AsicBoost**
* ✓ Equihash 200,9
* ✓ Equihash 144,5
* ✓ Equihash 192,7
* ✓ Scrypt
* ✓ X11
* ✓ And more...

## Requirements
* node v8.11+
* coin daemon (preferably one with a relatively updated API)

## Installation

### Install as a node module by cloning repository

```bash
git clone -b sha256-nomp-node-stratum-pool https://github.com/janos-raul/stratum-pool.git node_modules/stratum-pool
npm update
```

## Configuration

### Basic Coin Configuration

```javascript
var myCoin = {
{
  "name": "bitcoin",
  "symbol": "BTC",
  "algorithm": "sha256",
  "reward": "POW",										
  "asicboost": true,                    
  "versionMask": "0x3fffe000",           
  "enforcePoolVersionMask": true,       
  "versionRollingMinBits": 16,         										
  "asicboostMinDifficulty": 1000,      
  "asicboostMaxClients": 1000,         
  "coinbase": "sha256-mining.go.ro",
  "txMessages": false,
  "segwit": true,
  "taproot": true,
  "coinbaseTxVersion": 2,
  "hasBlockReward": true,
  "blockVersion": 536870912,
  "default_witness_commitment": true,
  "shareDifficultyTarget": "target",
  "rpcTimeout": 5000,
  "blockTime": 300,
  "minConf": 101,
  
"addressValidation": {
		"validateWorkerUsername": true,
		"addressPrefix": "bc",
		"minLength": 30,
		"maxLength": 42
  },

"explorer": {
        "txURL": "https://bitcoinexplorer.org/tx/",
        "blockURL": "https://bitcoinexplorer.org/block/"
    },
	
"rpc": {
            "host": "127.0.0.1",
            "port": 8332,
            "user": "bitcoinrpc",
            "password": "password"
  }
}
```

### Pool Configuration with New Features

```javascript
var Stratum = require('stratum-pool');

var pool = Stratum.createPool({

{
  "enabled": true,
  "coin": "bitcoin.json",
  "asicboost": true,
  "blockIdentifier":"",

  "address": "",

    "rewardRecipients": {
        "": 2.0
        "22851477d63a085dbc2398c8430af1c09e7343f6": 0.1
    },

  "paymentProcessing": {
	"minConf": 101,
    "enabled": true,
	"soloMining": true, 
    "paymentMode": "prop", 	
    "poolFee": 2.0,
    "soloFee": 2.0,  
    "_comment_paymentMode": "prop, pplnt",
    "paymentInterval": 3600,
    "minimumPayment": 0.01,
	"minimumPayment_solo": 0.01,
    "maxBlocksPerPayment": 5,
      "daemon": {
            "host": "127.0.0.1",
            "port": 8332,
            "user": "bitcoinrpc",
            "password": "password"
        }
    },

    "tlsOptions": {
        "enabled": false,
        "serverKey": "",
        "serverCert": "",
        "ca": ""
    },
	
  "ports": {
    "50212": {
      "diff": 25000,
	  "tls": false,
	  "soloMining": true,
      "varDiff": {
        "minDiff": 5000,
        "maxDiff": 5000000000000000,
        "targetTime": 15,
        "retargetTime": 60,
        "variancePercent": 30
	   }
      },
	  "50213": {
      "diff": 50000,
	  "tls": false,
	  "soloMining": true,
      "varDiff": {
        "minDiff": 25000,
        "maxDiff": 5000000000000000,
        "targetTime": 15,
        "retargetTime": 60,
        "variancePercent": 30
      }
    },
   	  "50214": {
      "diff": 100000,
	  "tls": false,
	  "soloMining": true,
      "varDiff": {
        "minDiff": 50000,
        "maxDiff": 5000000000000000,
        "targetTime": 15,
        "retargetTime": 60,
        "variancePercent": 30
      }
    },
   	  "50216": {
      "diff": 500000,
	  "tls": false,
	  "soloMining": true,
      "varDiff": {
        "minDiff": 100000,
        "maxDiff": 5000000000000000,
        "targetTime": 15,
        "retargetTime": 60,
        "variancePercent": 30
      }
    } 	
  },
  
    "poolId": "main",
    "_comment_poolId": "use it for region identification: eu, us, asia or keep default if you have one stratum instance for one coin",

    "daemons": [
        {
            "host": "127.0.0.1",
            "port": 8332,
            "user": "bitcoinrpc",
            "password": "password"
        }
  ],

    "p2p": {
        "enabled": false,
        "host": "127.0.0.1",
        "port": 34230,
        "disableTransactions": true
    },

    "mposMode": {
        "enabled": false,
        "host": "127.0.0.1",
        "port": 3306,
        "user": "",
        "password": "",
        "database": "",
        "checkPassword": true,
        "autoCreateWorker": false
    }
}
```

### Event Handling with New Features

```javascript
// Enhanced share event with AsicBoost data
pool.on('share', function(isValidShare, isValidBlock, data) {
    /*
    Enhanced data object now includes:
        - versionRollingBits: bits used for version rolling
        - asicboostUsed: boolean indicating if AsicBoost was used
        - soloMining: boolean indicating if this was a solo mining share
        - minerAddress: address for solo miners
    */
    
            if (!isValidBlock)
                emitShare();
            else{
                SubmitBlock(blockHex, function(){
    
    console.log('Share data:', JSON.stringify(data));
});
```

## Usage Examples

### Basic SHA256 Pool with AsicBoost

```javascript
var bitcoin = {
  "name": "bitcoin",
  "symbol": "BTC",
  "algorithm": "sha256",
  "reward": "POW",										
  "asicboost": true,                    
  "versionMask": "0x3fffe000",           
  "enforcePoolVersionMask": true,       
  "versionRollingMinBits": 16,         										
  "asicboostMinDifficulty": 1000,      
  "asicboostMaxClients": 1000,         
  "coinbase": "sha256-mining.go.ro",
  "txMessages": false,
  "segwit": true,
  "taproot": true,
  "coinbaseTxVersion": 2,
  "hasBlockReward": true,
  "blockVersion": 536870912,
  "default_witness_commitment": true,
  "shareDifficultyTarget": "target",
  "rpcTimeout": 5000,
  "blockTime": 300,
  "minConf": 101,
};

// Create pool with AsicBoost enabled
var pool = Stratum.createPool({
    "coin": bitcoin,
    "address": "bc1qpool...",
	"asicboost": true,
    // ... other configuration
});
```

### Solo Mining Setup

```javascript
// Configure solo mining port, solo mining detection is based on user password "m=solo"
"ports": {
    "3334": {
        "diff": 8192,
        "soloMining": true,
        "varDiff": {
            "minDiff": 8192,
            "maxDiff": 1048576,
            "targetTime": 30,
            "retargetTime": 120,
            "variancePercent": 40
        }
    }
}
```

## Stratum Extensions

This implementation supports the following stratum extensions:

- `mining.subscribe` with version rolling support
- `mining.configure` for AsicBoost negotiation
- `mining.suggest_target` for solo miners
- `mining.submit` with version bits

## Testing

Test your AsicBoost implementation:
```bash
# Test with bfgminer
bfgminer -o stratum+tcp://localhost:3333 -u walletaddress -p x --version-rolling

# Test with cgminer
cgminer -o stratum+tcp://localhost:3333 -u walletaddress -p x
```

## Performance Optimizations

- AsicBoost reduces power consumption by ~20%
- Version rolling improves efficiency for high-hashrate miners
- Optimized share validation for SHA256
- Efficient job distribution for large mining farms

## Credits

* Original stratum-pool developers
* [vekexasia](//github.com/vekexasia) - co-developer & great tester
* [LucasJones](//github.com/LucasJones) - got p2p block notify working
* [TheSeven](//github.com/TheSeven) - technical guidance
* SHA256-NOMP Contributors - AsicBoost, solo mining, and PROP implementation

## Donations

To support continued development:

* BTC:  `bc1q0aa3k39ww33z24p3wpk72jjn32h2n5rfr85pnx`
* BTCS: `bs1q8dnz4q52czdusl8hy04fw3jryj2kc3earck3y2`
* BCH:  `qzhpajyfz7yvl8963rre5zqdp72pqy47ysttst0wmr`

## License

Released under the GNU General Public License v2

http://www.gnu.org/licenses/gpl-2.0.html

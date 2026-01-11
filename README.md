# AutoTransfer
Automatic transfers for Hive/HBD, Hive Engine tokens, Steem/SBD, and Blurt.
It polls balances on a fixed interval, keeps a reserve, and sends the rest to your destination wallets.

## Features
- Separate workers for Hive native, Hive Engine tokens, Steem, and Blurt
- Optional failover RPC endpoints (comma-separated lists)
- Retries on 5xx/network errors for balance fetches
- Simple `.env` setup

## Requirements
- Node.js 18+ (recommended)
- Active private keys for any account you want to send from

## Install
```bash
npm install
```

## Quick Start
1) Copy the example env file:
```bash
copy .env-example .env
```
2) Edit `.env` with your accounts, keys, and destination wallets.
3) Run the bot:
```bash
node index.js
```

## How It Works
- Each enabled worker runs in a loop.
- On each loop, it fetches balances and sends any amount above the reserve.
- Hive Engine tokens are transferred via custom JSON operations.

## Refresh Rate
The main loop delay is set in `index.js`:
```js
const MAIN_LOOP_DELAY = 3 * 60 * 1000; // 3 minutes
```
Change this value to increase/decrease how often balances are checked.

## Environment Configuration
Edit `.env` to match your setup. The format for account lists is:
```
account=private_key,account2=private_key2
```

### Core Toggles
```
ENABLE_HIVE=true
ENABLE_HIVE_ENGINE=true
ENABLE_STEEM=false
ENABLE_BLURT=false
```

### Accounts
```
HIVE_ACCOUNTS=alice=5Kxxx,bob=5Kyyy
HIVE_ENGINE_ACCOUNTS=alice=5Kxxx
STEEM_ACCOUNTS=steem1=5Jaaa
BLURT_ACCOUNTS=blurt1=5Jccc
```

### RPC Endpoints (comma-separated lists supported)
```
HIVE_RPC=https://api.hive.blog
STEEM_RPC=https://api.steemit.com
BLURT_RPC=https://rpc.blurt.world
ENGINE_API=https://api.hive-engine.com/rpc/contracts
```
Example with failover:
```
HIVE_RPC=https://api.hive.blog,https://anyx.io
ENGINE_API=https://api.hive-engine.com/rpc/contracts,https://api.hive-engine.com/rpc/contracts
```

### Destination Wallets
```
DEST_HIVE_NATIVE=mainwallet
DEST_HIVE_TOKENS=tokenwallet
DEST_STEEM=steemwallet
DEST_BLURT=blurtwallet
```

### Reserves (keep this amount on the source account)
```
HIVE_RESERVE=0.001
HBD_RESERVE=0.001
STEEM_RESERVE=0.001
SBD_RESERVE=0.001
BLURT_RESERVE=0.001
```

## Logs
You will see two types of Hive logs:
- `HIVE <name> native`: HIVE/HBD balances and queued amounts
- `HIVE ENGINE <name> tokens`: token balances and queued ops

## Notes
- Use **active private keys**. Posting keys will not work for transfers.
- Transfers are only attempted when balance > reserve.
- If Hive Engine destination is missing, the worker logs a warning.

## Troubleshooting
- 503 errors usually mean the RPC or Hive Engine endpoint is down or rate-limited.
- Add multiple endpoints to reduce downtime.
- If nothing is happening, check that the account has balances above reserves.

# Celo Wallet Stats Dashboard

React + Express dashboard for wallet analytics using:

- Addresses loaded from `./data/addresses.js` as an exported data array
- Celo Explorer API with contract-specific token queries
- Token filters for `CELO`, `USDT`, `cUSD`, and `USDC`
- Date range filtering, with the first 3 months shown by default
- Address pagination (15 per page) with Prev/Next navigation
- Multiple charts for transaction insights
- CSV export of filtered results

## Data Format

The app uses a JS data module structured as:

```js
const walletRecords = [
  {
    "id": 1,
    "email": "user@example.com",
    "address": "0x671eef621c47d17186e60df1a1496eb1d36d6d3d"
  },
  ...
]

export default walletRecords
```

## Features

- Reads wallet addresses and associated data from an exported JS array
- Fetches  token transactions for each wallet via Celo Explorer API
- Contract-based queries for precise token transaction data
- Aggregates:
  - transactions per token
  - incoming vs outgoing count
  - monthly activity timeline
  - top wallets by transaction count
- Paginated address display (15 per page) to manage large wallet sets
- Lets you customize the data module path from the UI
- Caches fetched explorer data for 10 minutes to speed up repeated filtering
- Export filtered stats to CSV files
npm install
npm run dev
```

This starts:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001`

## Data Module File

The default path is now:

`./data/addresses.js`

### Generate JS Data Module From CSV

If you have a new CSV file with columns `masked_email` and `address`, generate the data module:

```bash
npm run generate:data-module
```

This will convert `./data/sql.csv` to `./data/addresses.js`.

You can override the data module path in either way:

- Type a different path in the dashboard input and click `Reload Data Module`
- Set environment variable before running:

```bash
export DATA_MODULE_PATH="/path/to/your/file.js"
npm run dev
```

## API endpoints

- `GET /api/addresses?dataModulePath=/path/to/file.js&page=1&limit=15`
- `GET /api/wallet-stats?dataModulePath=/path/to/file.js&from=UNIX_SECONDS&to=UNIX_SECONDS&page=1&limit=15`

Parameters:
- `dataModulePath`: Path to the JS data module (defaults to `./data/addresses.js`)
- `page`: Page number for pagination (defaults to 1)
- `limit`: Items per page (defaults to 15)
- `from`, `to`: Unix timestamps for date range filtering

## Token Contract Addresses (Celo Blockchain)

The API fetches transactions for these token contracts:

- **CELO**: `0x471EcE3750da237f93B8E339c536989b8978a438`
- **USDT**: `0x88eeC49f2c90b5ee0Ee7bABf12d6fF8F233C2Bfd`
- **cUSD**: `0x765DE816845861e75A25fCA122bb6022DB00DAEa`
- **USDC**: `0xef4229c8c3250C675F21BCefa42f58EfbfF6002a`

Transactions are fetched using the Celo Explorer API with the `contractaddress` parameter for accurate token filtering.
# celo-exploror
# celo-status

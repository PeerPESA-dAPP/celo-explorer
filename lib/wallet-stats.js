import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const API_BASE = 'https://explorer.celo.org/mainnet/api'
export const TOKEN_CONTRACTS = {
  CELO: '0x471EcE3750da237f93B8E339c536989b8978a438',
  USDT: '0x88eeC49f2c90b5ee0Ee7bABf12d6fF8F233C2Bfd',
  CUSD: '0x765DE816845861e75A25fCA122bb6022DB00DAEa',
  USDC: '0xef4229c8c3250C675F21BCefa42f58EfbfF6002a',
}
export const DEFAULT_DATA_MODULE_PATH = './data/addresses.js'
export const PAGE_SIZE = 1000
export const MAX_PAGES_PER_WALLET = 8
export const CACHE_TTL_MS = 10 * 60 * 1000
const RATE_LIMIT_MAX_RETRIES = 4
const RATE_LIMIT_BASE_DELAY_MS = 1200
const NETWORK_RETRY_BASE_DELAY_MS = 800
const WALLET_CHUNK_SIZE = 5
const WALLET_CHUNK_DELAY_MS = 0

export const logTrace = (step, details = {}) => {
  console.log(`[wallet-stats][${new Date().toISOString()}] ${step}`, details)
}

export const isValidAddress = (value) => /^0x[a-fA-F0-9]{40}$/.test(value)

// In-memory cache (module-level, persists across requests in the same process)
export const cache = {
  dataModulePath: '',
  addresses: [],
  addressesFetchedAt: 0,
  txByWallet: new Map(),
  inFlightWalletFetches: new Map(),
}

export const loadWalletRecords = async (dataModulePath) => {
  logTrace('loadWalletRecords:start', { dataModulePath })
  const absoluteModulePath = path.resolve(process.cwd(), /*turbopackIgnore: true*/ dataModulePath)
  const moduleStats = await fs.stat(absoluteModulePath)
  const moduleUrl = pathToFileURL(absoluteModulePath)
  const importedModule = await import(/* webpackIgnore: true */ `${moduleUrl.href}?t=${moduleStats.mtimeMs}`)
  const records = importedModule.default ?? importedModule.walletRecords ?? importedModule.records

  if (!Array.isArray(records)) {
    logTrace('loadWalletRecords:error', { dataModulePath, reason: 'export is not array' })
    throw new Error('Data module must export an array of wallet records')
  }

  logTrace('loadWalletRecords:done', { dataModulePath, recordCount: records.length })
  return records
}

export const extractAddressesFromModule = async (dataModulePath) => {
  logTrace('extractAddressesFromModule:start', { dataModulePath })
  const data = await loadWalletRecords(dataModulePath)
  const addresses = []

  for (const record of data) {
    const address = record.address || ''
    if (address && isValidAddress(address)) {
      addresses.push(address.toLowerCase())
    }
  }

  const uniqueAddresses = [...new Set(addresses)]
  logTrace('extractAddressesFromModule:done', {
    dataModulePath,
    rawCount: addresses.length,
    uniqueCount: uniqueAddresses.length,
  })
  return uniqueAddresses
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const getRetryDelayMs = (response, attempt) => {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterSeconds = Number(retryAfter)

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000
  }

  return RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt
}

export const fetchJsonWithRetry = async (url, requestLabel) => {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    logTrace('fetchJsonWithRetry:attempt', { requestLabel, attempt: attempt + 1, url })
    let response
    try {
      response = await fetch(url)
    } catch (error) {
      logTrace('fetchJsonWithRetry:network-error', {
        requestLabel,
        attempt: attempt + 1,
        message: String(error.message || error),
      })
      if (attempt < RATE_LIMIT_MAX_RETRIES) {
        await sleep(NETWORK_RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }

      console.warn(
        `Network error for ${requestLabel}; returning empty result after retries: ${String(error.message || error)}`,
      )
      return { status: '0', message: 'network error', result: [] }
    }

    if (response.ok) {
      logTrace('fetchJsonWithRetry:success', { requestLabel, attempt: attempt + 1, status: response.status })
      return response.json()
    }

    if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
      logTrace('fetchJsonWithRetry:rate-limit-retry', {
        requestLabel,
        attempt: attempt + 1,
        status: response.status,
      })
      await sleep(getRetryDelayMs(response, attempt))
      continue
    }

    if (response.status === 429) {
      logTrace('fetchJsonWithRetry:rate-limit-exhausted', {
        requestLabel,
        attempts: RATE_LIMIT_MAX_RETRIES + 1,
      })
      console.warn(
        `Rate-limited for ${requestLabel}; returning empty result after ${RATE_LIMIT_MAX_RETRIES + 1} attempts`,
      )
      return { status: '0', message: 'rate limited', result: [] }
    }

    logTrace('fetchJsonWithRetry:http-error', {
      requestLabel,
      attempt: attempt + 1,
      status: response.status,
    })
    throw new Error(`Failed API call for ${requestLabel}: ${response.status}`)
  }

  logTrace('fetchJsonWithRetry:retry-limit-exhausted', { requestLabel })
  return { status: '0', message: 'retry limit exceeded', result: [] }
}

export const isAddressCacheFresh = (dataModulePath) =>
  cache.dataModulePath === dataModulePath &&
  cache.addresses.length > 0 &&
  Date.now() - cache.addressesFetchedAt < CACHE_TTL_MS

export const loadAddressIndex = async (dataModulePath) => {
  if (isAddressCacheFresh(dataModulePath)) {
    logTrace('loadAddressIndex:cache-hit', {
      dataModulePath,
      addressCount: cache.addresses.length,
    })
    return { addresses: cache.addresses, cached: true }
  }

  logTrace('loadAddressIndex:cache-miss', { dataModulePath })

  const addresses = await extractAddressesFromModule(dataModulePath)

  cache.dataModulePath = dataModulePath
  cache.addresses = addresses
  cache.addressesFetchedAt = Date.now()
  cache.txByWallet = new Map()
  cache.inFlightWalletFetches = new Map()

  logTrace('loadAddressIndex:cache-populated', {
    dataModulePath,
    addressCount: addresses.length,
  })
  return { addresses, cached: false }
}

export const fetchWalletTokenTx = async (walletAddress) => {
  logTrace('fetchWalletTokenTx:start', { walletAddress })
  const allRows = []

  for (const [token, contractAddress] of Object.entries(TOKEN_CONTRACTS)) {
    logTrace('fetchWalletTokenTx:token-start', { walletAddress, token, contractAddress })
    for (let page = 1; page <= MAX_PAGES_PER_WALLET; page += 1) {
      try {
        logTrace('fetchWalletTokenTx:page-start', { walletAddress, token, page })
        const query = new URLSearchParams({
          module: 'account',
          action: 'tokentx',
          address: walletAddress,
          contractaddress: contractAddress,
          page: String(page),
          offset: String(PAGE_SIZE),
          sort: 'asc',
        })

        const payload = await fetchJsonWithRetry(
          `${API_BASE}?${query.toString()}`,
          `${walletAddress} (${token})`,
        )
        const pageRows = Array.isArray(payload.result) ? payload.result : []
        logTrace('fetchWalletTokenTx:page-complete', {
          walletAddress,
          token,
          page,
          rowCount: pageRows.length,
        })

        const normalizedRows = pageRows
          .map((tx) => {
            const decimals = Number(tx.tokenDecimal || 0)
            const denominator = decimals > 0 ? 10 ** decimals : 1
            const normalizedValue = Number(tx.value || 0) / denominator

            return {
              hash: tx.hash,
              logIndex: tx.logIndex,
              walletAddress,
              from: String(tx.from || '').toLowerCase(),
              to: String(tx.to || '').toLowerCase(),
              timestamp: Number(tx.timeStamp),
              token,
              value: Number.isFinite(normalizedValue) ? normalizedValue : 0,
              gasUsed: Number(tx.gasUsed || 0),
              gasPrice: Number(tx.gasPrice || 0),
            }
          })
          .filter(Boolean)

        allRows.push(...normalizedRows)

        if (pageRows.length < PAGE_SIZE) {
          logTrace('fetchWalletTokenTx:token-finished-early', {
            walletAddress,
            token,
            page,
            reason: 'page smaller than PAGE_SIZE',
          })
          break
        }
      } catch (error) {
        logTrace('fetchWalletTokenTx:page-error', {
          walletAddress,
          token,
          page,
          message: String(error.message || error),
        })
        console.error(
          `Failed token page fetch for ${walletAddress} (${token}) page ${page}: ${String(error.message || error)}`,
        )
        break
      }
    }
  }

  logTrace('fetchWalletTokenTx:done', { walletAddress, totalRows: allRows.length })
  return allRows
}

export const ensureWalletTransactions = async (walletAddresses) => {
  logTrace('ensureWalletTransactions:start', { requestedWalletCount: walletAddresses.length })
  let fullyCached = true
  const walletsToFetch = []

  for (const walletAddress of walletAddresses) {
    if (cache.txByWallet.has(walletAddress) || cache.inFlightWalletFetches.has(walletAddress)) {
      continue
    }

    fullyCached = false
    walletsToFetch.push(walletAddress)
  }

  logTrace('ensureWalletTransactions:cache-scan-complete', {
    requestedWalletCount: walletAddresses.length,
    walletsToFetch: walletsToFetch.length,
    cacheHits: walletAddresses.length - walletsToFetch.length,
  })

  for (let index = 0; index < walletsToFetch.length; index += WALLET_CHUNK_SIZE) {
    const walletChunk = walletsToFetch.slice(index, index + WALLET_CHUNK_SIZE)
    logTrace('ensureWalletTransactions:chunk-start', {
      chunkIndex: index / WALLET_CHUNK_SIZE + 1,
      chunkSize: walletChunk.length,
      walletChunk,
    })
    const chunkResults = await Promise.all(
      walletChunk.map(async (walletAddress) => {
        const inFlightPromise = (async () => {
          try {
            return await fetchWalletTokenTx(walletAddress)
          } catch (error) {
            console.error(
              `Failed to fetch wallet transactions for ${walletAddress}: ${String(error.message || error)}`,
            )
            return []
          }
        })()

        cache.inFlightWalletFetches.set(walletAddress, inFlightPromise)
        const txs = await inFlightPromise
        cache.inFlightWalletFetches.delete(walletAddress)
        return [walletAddress, txs]
      }),
    )

    for (const [walletAddress, txs] of chunkResults) {
      cache.txByWallet.set(walletAddress, txs)
    }

    logTrace('ensureWalletTransactions:chunk-complete', {
      chunkIndex: index / WALLET_CHUNK_SIZE + 1,
      cachedWallets: chunkResults.length,
    })

    if (WALLET_CHUNK_DELAY_MS > 0 && index + WALLET_CHUNK_SIZE < walletsToFetch.length) {
      await sleep(WALLET_CHUNK_DELAY_MS)
    }
  }

  const pendingResults = await Promise.all(
    walletAddresses.map(async (walletAddress) => {
      if (cache.txByWallet.has(walletAddress)) {
        return [walletAddress, cache.txByWallet.get(walletAddress) || []]
      }

      const inFlight = cache.inFlightWalletFetches.get(walletAddress)
      if (!inFlight) {
        return [walletAddress, []]
      }

      const txs = await inFlight
      cache.txByWallet.set(walletAddress, txs)
      return [walletAddress, txs]
    }),
  )

  return {
    cached: fullyCached,
    txByWallet: new Map(pendingResults),
  }
}

const toMonthLabel = (ts) => {
  const date = new Date(ts * 1000)
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}`
}

export const aggregateStats = ({ addresses, txByWallet, fromTs, toTs }) => {
  logTrace('aggregateStats:start', { addressCount: addresses.length, fromTs, toTs })
  const tokenStatsMap = new Map()
  const walletStats = []
  const timelineMap = new Map()
  const allTransactions = []
  const seenTxHashes = new Set()
  let incomingCount = 0
  let outgoingCount = 0
  let totalGasFeeCELO = 0

  for (const walletAddress of addresses) {
    const transactions = txByWallet.get(walletAddress) || []
    const walletTokenMap = new Map()

    for (const tx of transactions) {
      if (tx.timestamp < fromTs || tx.timestamp > toTs) {
        continue
      }

      allTransactions.push(tx)

      const incoming = tx.to === walletAddress
      if (incoming) {
        incomingCount += 1
      } else {
        outgoingCount += 1
      }

      const tokenStat = tokenStatsMap.get(tx.token) || {
        token: tx.token,
        txCount: 0,
        totalIn: 0,
        totalOut: 0,
        wallets: new Set(),
      }

      tokenStat.txCount += 1
      tokenStat.wallets.add(walletAddress)
      if (incoming) {
        tokenStat.totalIn += tx.value
      } else {
        tokenStat.totalOut += tx.value
      }
      tokenStatsMap.set(tx.token, tokenStat)

      const walletToken = walletTokenMap.get(tx.token) || {
        token: tx.token,
        txCount: 0,
        in: 0,
        out: 0,
      }

      walletToken.txCount += 1
      if (incoming) {
        walletToken.in += tx.value
      } else {
        walletToken.out += tx.value
      }
      walletTokenMap.set(tx.token, walletToken)

      const monthLabel = toMonthLabel(tx.timestamp)
      const monthStats = timelineMap.get(monthLabel) || {
        month: monthLabel,
        CELO: 0,
        USDT: 0,
        CUSD: 0,
        USDC: 0,
        gasFeeCELO: 0,
      }
      monthStats[tx.token] += 1

      if (!seenTxHashes.has(tx.hash)) {
        seenTxHashes.add(tx.hash)
        const gasFee = (tx.gasUsed * tx.gasPrice) / 1e18
        if (Number.isFinite(gasFee) && gasFee > 0) {
          totalGasFeeCELO += gasFee
          monthStats.gasFeeCELO += gasFee
        }
      }

      timelineMap.set(monthLabel, monthStats)
    }

    const perToken = [...walletTokenMap.values()]
    const txCount = perToken.reduce((sum, item) => sum + item.txCount, 0)
    const totalIn = perToken.reduce((sum, item) => sum + item.in, 0)
    const totalOut = perToken.reduce((sum, item) => sum + item.out, 0)

    walletStats.push({ walletAddress, txCount, totalIn, totalOut, perToken })
  }

  const tokenStats = [...tokenStatsMap.values()]
    .map((item) => ({
      token: item.token,
      txCount: item.txCount,
      totalIn: item.totalIn,
      totalOut: item.totalOut,
      wallets: item.wallets.size,
    }))
    .sort((a, b) => b.txCount - a.txCount)

  const timeline = [...timelineMap.values()].sort((a, b) => a.month.localeCompare(b.month))
  const sortedWallets = walletStats.sort((a, b) => b.txCount - a.txCount)
  const sortedTransactions = allTransactions.sort((a, b) => b.timestamp - a.timestamp)

  logTrace('aggregateStats:done', {
    tokenCount: tokenStats.length,
    walletCount: sortedWallets.length,
    timelinePoints: timeline.length,
    transactionCount: sortedTransactions.length,
    totalGasFeeCELO,
  })

  return {
    tokenStats,
    walletStats: sortedWallets,
    timeline,
    transactions: sortedTransactions,
    gasStats: { total: totalGasFeeCELO },
    directionStats: [
      { name: 'Incoming', value: incomingCount },
      { name: 'Outgoing', value: outgoingCount },
    ],
  }
}

export const getAllowedOrigins = () =>
  new Set(
    (process.env.ALLOWED_ORIGINS || 'http://localhost:3032,http://127.0.0.1:3032')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )

export const corsHeaders = (requestOrigin) => {
  const allowed = getAllowedOrigins()
  const origin = requestOrigin || ''
  if (!origin || allowed.has(origin)) {
    return { 'Access-Control-Allow-Origin': origin || '*' }
  }
  return {}
}

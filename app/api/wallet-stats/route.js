import {
  aggregateStats,
  corsHeaders,
  DEFAULT_DATA_MODULE_PATH,
  ensureWalletTransactions,
  loadAddressIndex,
  logTrace,
} from '../../../lib/wallet-stats.js'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const dataModulePath =
    searchParams.get('dataModulePath') ||
    process.env.DATA_MODULE_PATH ||
    DEFAULT_DATA_MODULE_PATH
  const addressQuery = (searchParams.get('addressQuery') || '').trim().toLowerCase()
  const pageSize = Number(searchParams.get('limit')) || 15
  const pageNumber = Math.max(1, Number(searchParams.get('page')) || 1)

  logTrace('api.wallet-stats:start', {
    dataModulePath,
    addressQuery,
    pageSize,
    pageNumber,
    from: searchParams.get('from') || null,
    to: searchParams.get('to') || null,
  })

  const origin = request.headers.get('origin') || ''
  const headers = corsHeaders(origin)

  try {
    const { addresses: allAddressesUnfiltered, cached: addressesCached } =
      await loadAddressIndex(dataModulePath)

    const allAddresses = addressQuery
      ? allAddressesUnfiltered.filter((address) => address.includes(addressQuery))
      : allAddressesUnfiltered

    const startIdx = (pageNumber - 1) * pageSize
    const endIdx = startIdx + pageSize
    const pageAddresses = allAddresses.slice(startIdx, endIdx)
    const totalPages = Math.ceil(allAddresses.length / pageSize)

    logTrace('api.wallet-stats:addresses-selected', {
      totalAddresses: allAddressesUnfiltered.length,
      matchedAddresses: allAddresses.length,
      selectedAddresses: pageAddresses.length,
      startIdx,
      endIdx,
      totalPages,
    })

    const { cached: transactionsCached, txByWallet } =
      await ensureWalletTransactions(pageAddresses)

    const allTimestamps = [...txByWallet.values()]
      .flat()
      .map((tx) => tx.timestamp)
      .filter((ts) => Number.isFinite(ts))
      .sort((a, b) => a - b)

    if (allTimestamps.length === 0) {
      logTrace('api.wallet-stats:no-transactions', { selectedAddresses: pageAddresses.length })
      return Response.json(
        {
          meta: {
            dataModulePath,
            cached: addressesCached && transactionsCached,
            totalAddresses: allAddressesUnfiltered.length,
            totalMatchedAddresses: allAddresses.length,
            addressQuery,
            addressesCount: pageAddresses.length,
            page: pageNumber,
            pageSize,
            totalPages,
            txCount: 0,
            availableFrom: null,
            availableTo: null,
            defaultFrom: null,
            defaultTo: null,
            appliedFrom: null,
            appliedTo: null,
          },
          tokenStats: [],
          walletStats: pageAddresses.map((walletAddress) => ({
            walletAddress,
            txCount: 0,
            totalIn: 0,
            totalOut: 0,
            perToken: [],
          })),
          timeline: [],
          transactions: [],
          gasStats: { total: 0 },
          directionStats: [],
        },
        { headers },
      )
    }

    const availableFrom = allTimestamps[0]
    const availableTo = allTimestamps[allTimestamps.length - 1]

    const firstDate = new Date(availableFrom * 1000)
    const defaultToDate = new Date(firstDate)
    defaultToDate.setUTCMonth(defaultToDate.getUTCMonth() + 3)

    const defaultFrom = availableFrom
    const defaultTo = Math.min(availableTo, Math.floor(defaultToDate.getTime() / 1000))

    const fromTs = searchParams.get('from') ? Number(searchParams.get('from')) : defaultFrom
    const toTs = searchParams.get('to') ? Number(searchParams.get('to')) : defaultTo

    const stats = aggregateStats({ addresses: pageAddresses, txByWallet, fromTs, toTs })

    logTrace('api.wallet-stats:responding', {
      selectedAddresses: pageAddresses.length,
      txCount: allTimestamps.length,
      walletStatsCount: stats.walletStats.length,
      tokenStatsCount: stats.tokenStats.length,
      transactionRows: stats.transactions.length,
      cached: addressesCached && transactionsCached,
    })

    return Response.json(
      {
        meta: {
          dataModulePath,
          cached: addressesCached && transactionsCached,
          totalAddresses: allAddressesUnfiltered.length,
          totalMatchedAddresses: allAddresses.length,
          addressQuery,
          addressesCount: pageAddresses.length,
          page: pageNumber,
          pageSize,
          totalPages,
          txCount: allTimestamps.length,
          availableFrom,
          availableTo,
          defaultFrom,
          defaultTo,
          appliedFrom: fromTs,
          appliedTo: toTs,
        },
        ...stats,
      },
      { headers },
    )
  } catch (error) {
    logTrace('api.wallet-stats:error', {
      message: String(error.message || error),
      stack: error?.stack || null,
    })
    return Response.json(
      { message: `Failed to fetch and aggregate wallet stats: ${String(error.message || error)}` },
      { status: 500, headers },
    )
  }
}

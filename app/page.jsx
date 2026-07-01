'use client'

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const DEFAULT_DATA_MODULE_PATH = './data/addresses.js'
const DIRECTION_COLORS = ['#0d9488', '#ea580c']
const TOKEN_ORDER = ['CELO', 'USDT', 'CUSD', 'USDC']
const DEFAULT_TO_DATE = dayjs().format('YYYY-MM-DD')
const DEFAULT_FROM_DATE = dayjs().subtract(1, 'month').format('YYYY-MM-DD')

const formatNumber = (value) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value || 0)

const formatGas = (value) =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 }).format(value || 0)

const sumField = (items, field) =>
  items.reduce((sum, item) => sum + Number(item[field] || 0), 0)

const escapeCsvCell = (value) => {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

const downloadCsv = (filename, headers, rows) => {
  const csvLines = [headers, ...rows].map((row) => row.map(escapeCsvCell).join(','))
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export default function DashboardPage() {
  const [dataModulePath] = useState(DEFAULT_DATA_MODULE_PATH)
  const [addressCount, setAddressCount] = useState(0)
  const [pageSize] = useState(100)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [fromDate, setFromDate] = useState(DEFAULT_FROM_DATE)
  const [toDate, setToDate] = useState(DEFAULT_TO_DATE)
  const [singleAddressQuery, setSingleAddressQuery] = useState('')
  const [addressFilter, setAddressFilter] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [chunkCountdown, setChunkCountdown] = useState(0)
  const autoLoadAbortRef = useRef(null)
  const [error, setError] = useState('')
  const [activeView, setActiveView] = useState('analysis')
  const [copyStatus, setCopyStatus] = useState('')
  const [selectedWallet, setSelectedWallet] = useState(null)
  const searchDebounceRef = useRef(null)
  const previousFilterRef = useRef('')

  const copyText = async (value) => {
    const text = String(value || '').trim()
    if (!text) return

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const input = document.createElement('textarea')
        input.value = text
        input.setAttribute('readonly', '')
        input.style.position = 'absolute'
        input.style.left = '-9999px'
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        document.body.removeChild(input)
      }
      setCopyStatus(`Copied: ${text}`)
      setTimeout(() => setCopyStatus(''), 1800)
    } catch {
      setCopyStatus('Copy failed')
      setTimeout(() => setCopyStatus(''), 1800)
    }
  }

  const mergeStatsPayload = (base, incoming) => {
    if (!base) return incoming

    const tokenStatsByToken = new Map(base.tokenStats.map((item) => [item.token, { ...item }]))
    for (const token of incoming.tokenStats) {
      const existing = tokenStatsByToken.get(token.token)
      if (existing) {
        existing.txCount += token.txCount
        existing.totalIn += token.totalIn
        existing.totalOut += token.totalOut
        existing.wallets += token.wallets
      } else {
        tokenStatsByToken.set(token.token, { ...token })
      }
    }

    const timelineByMonth = new Map(base.timeline.map((item) => [item.month, { ...item }]))
    for (const month of incoming.timeline) {
      const existing = timelineByMonth.get(month.month)
      if (existing) {
        existing.CELO += month.CELO || 0
        existing.USDT += month.USDT || 0
        existing.CUSD += month.CUSD || 0
        existing.USDC += month.USDC || 0
        existing.gasFeeCELO = (existing.gasFeeCELO || 0) + (month.gasFeeCELO || 0)
      } else {
        timelineByMonth.set(month.month, {
          month: month.month,
          CELO: month.CELO || 0,
          USDT: month.USDT || 0,
          CUSD: month.CUSD || 0,
          USDC: month.USDC || 0,
          gasFeeCELO: month.gasFeeCELO || 0,
        })
      }
    }

    const directionByName = new Map(base.directionStats.map((item) => [item.name, { ...item }]))
    for (const direction of incoming.directionStats) {
      const existing = directionByName.get(direction.name)
      if (existing) {
        existing.value += direction.value
      } else {
        directionByName.set(direction.name, { ...direction })
      }
    }

    return {
      ...incoming,
      meta: {
        ...incoming.meta,
        txCount: (base.meta?.txCount || 0) + (incoming.meta?.txCount || 0),
      },
      walletStats: [...base.walletStats, ...incoming.walletStats],
      transactions: [...(base.transactions || []), ...(incoming.transactions || [])],
      tokenStats: [...tokenStatsByToken.values()].sort((a, b) => b.txCount - a.txCount),
      timeline: [...timelineByMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
      directionStats: [...directionByName.values()],
      gasStats: {
        total: (base.gasStats?.total || 0) + (incoming.gasStats?.total || 0),
      },
    }
  }

  const fetchStatsPage = async ({
    customFrom,
    customTo,
    customDataModulePath,
    customAddressQuery,
    customPage = 1,
  }) => {
    const activeDataModulePath = customDataModulePath || dataModulePath
    const query = new URLSearchParams({
      dataModulePath: activeDataModulePath,
      page: String(customPage),
      limit: String(pageSize),
    })

    if (customFrom) query.set('from', String(dayjs(customFrom).unix()))
    if (customTo) query.set('to', String(dayjs(customTo).unix()))
    if (customAddressQuery && customAddressQuery.trim()) {
      query.set('addressQuery', customAddressQuery.trim())
    }

    const response = await fetch(`/api/wallet-stats?${query.toString()}`)

    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error(`Unexpected response from server (status ${response.status})`)
    }

    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.message || 'Unable to fetch wallet stats')
    }

    return payload
  }

  const loadFirstPage = async ({ customFrom, customTo, customDataModulePath }) => {
    const payload = await fetchStatsPage({
      customFrom,
      customTo,
      customDataModulePath,
      customPage: 1,
      customAddressQuery: '',
    })

    setTotalPages(payload.meta.totalPages || 1)
    setAddressCount(payload.meta.totalAddresses || 0)
    setCurrentPage(1)
    setData(payload)

    if (customFrom && customTo) {
      setFromDate(customFrom)
      setToDate(customTo)
    }

    return payload
  }

  const loadRemainingPages = async ({ totalPgs, customFrom, customTo, customDataModulePath, customAddressQuery = '' }) => {
    if (totalPgs <= 1) return
    const abortSignal = {}
    autoLoadAbortRef.current = abortSignal
    setLoadingMore(true)
    try {
      for (let page = 2; page <= totalPgs; page++) {
        if (autoLoadAbortRef.current !== abortSignal) return
        // 3-second break between chunks with live countdown
        for (let secs = 3; secs > 0; secs--) {
          if (autoLoadAbortRef.current !== abortSignal) return
          setChunkCountdown(secs)
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        if (autoLoadAbortRef.current !== abortSignal) return
        setChunkCountdown(0)
        const payload = await fetchStatsPage({
          customFrom,
          customTo,
          customDataModulePath,
          customAddressQuery,
          customPage: page,
        })
        if (autoLoadAbortRef.current !== abortSignal) return
        setCurrentPage(page)
        setData((prev) => mergeStatsPayload(prev, payload))
      }
    } catch (autoLoadError) {
      setError(autoLoadError.message)
    } finally {
      if (autoLoadAbortRef.current === abortSignal) {
        setLoadingMore(false)
        setChunkCountdown(0)
      }
    }
  }

  const loadSearchFirstChunk = async (queryText) => {
    const payload = await fetchStatsPage({
      customFrom: fromDate,
      customTo: toDate,
      customDataModulePath: dataModulePath,
      customAddressQuery: queryText,
      customPage: 1,
    })
    setData(payload)
  }

  useEffect(() => {
    const bootstrap = async () => {
      autoLoadAbortRef.current = null
      setLoading(true)
      setError('')
      try {
        const firstPayload = await loadFirstPage({
          customDataModulePath: dataModulePath,
          customFrom: DEFAULT_FROM_DATE,
          customTo: DEFAULT_TO_DATE,
        })
        loadRemainingPages({
          totalPgs: firstPayload.meta.totalPages || 1,
          customFrom: DEFAULT_FROM_DATE,
          customTo: DEFAULT_TO_DATE,
          customDataModulePath: dataModulePath,
        })
      } catch (bootstrapError) {
        setError(bootstrapError.message)
      } finally {
        setLoading(false)
      }
    }
    bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onApplyDateFilter = async (event) => {
    event.preventDefault()
    autoLoadAbortRef.current = null
    setLoadingMore(false)
    setLoading(true)
    setError('')
    try {
      const firstPayload = await loadFirstPage({ customFrom: fromDate, customTo: toDate })
      loadRemainingPages({
        totalPgs: firstPayload.meta.totalPages || 1,
        customFrom: fromDate,
        customTo: toDate,
        customDataModulePath: dataModulePath,
      })
    } catch (filterError) {
      setError(filterError.message)
    } finally {
      setLoading(false)
    }
  }

  const onSearchSingleAddress = () => {
    const query = singleAddressQuery.trim().toLowerCase()
    if (!query) {
      setError('Enter an address to search')
      return
    }
    if (!data) {
      setError('Data is still loading, please wait')
      return
    }
    const match = data.walletStats.find((w) => w.walletAddress.toLowerCase().includes(query))
    if (!match) {
      setError(`No wallet found matching: ${query}`)
      setSelectedWallet(null)
      return
    }
    setError('')
    setSelectedWallet(match)
    setActiveView('wallet')
  }

  const onClearSingleAddressSearch = () => {
    setSingleAddressQuery('')
    setSelectedWallet(null)
    setError('')
    if (activeView === 'wallet') setActiveView('analysis')
  }

  const totalTx = useMemo(() => {
    if (!data) return 0
    return sumField(data.tokenStats, 'txCount')
  }, [data])

  const topWallets = useMemo(() => {
    if (!data) return []
    return data.walletStats.slice(0, 9)
  }, [data])

  const totalsByToken = useMemo(() => {
    if (!data) return []
    return data.tokenStats.map((token) => ({
      token: token.token,
      volume: token.totalIn + token.totalOut,
      txCount: token.txCount,
      wallets: token.wallets,
    }))
  }, [data])

  const filteredWalletStats = useMemo(() => {
    const wallets = data?.walletStats || []
    const query = addressFilter.trim().toLowerCase()
    if (!query) return wallets
    return wallets.filter((wallet) => wallet.walletAddress.toLowerCase().includes(query))
  }, [data, addressFilter])

  const transactedAddressCount = useMemo(
    () => filteredWalletStats.filter((wallet) => wallet.txCount > 0).length,
    [filteredWalletStats],
  )

  const listedTotalIn = useMemo(() => sumField(filteredWalletStats, 'totalIn'), [filteredWalletStats])
  const listedTotalOut = useMemo(() => sumField(filteredWalletStats, 'totalOut'), [filteredWalletStats])

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    const query = addressFilter.trim()
    const hadPreviousFilter = previousFilterRef.current.length > 0
    previousFilterRef.current = query

    if (searchDebounceRef.current) {
      clearTimeout(searchDebounceRef.current)
    }

    if (!query) {
      if (hadPreviousFilter) {
        setError('')
        loadFirstPage({
          customFrom: fromDate,
          customTo: toDate,
          customDataModulePath: dataModulePath,
        }).catch((searchError) => setError(searchError.message))
      }
      return
    }

    searchDebounceRef.current = setTimeout(async () => {
      setError('')
      try {
        await loadSearchFirstChunk(query)
      } catch (searchError) {
        setError(searchError.message)
      }
    }, 300)

    return () => {
      if (searchDebounceRef.current) {
        clearTimeout(searchDebounceRef.current)
      }
    }
  }, [addressFilter, dataModulePath, fromDate, toDate])
  /* eslint-enable react-hooks/exhaustive-deps */

  const exportDateSuffix = useMemo(() => {
    if (!fromDate || !toDate) return dayjs().format('YYYYMMDD')
    return `${fromDate.replaceAll('-', '')}_${toDate.replaceAll('-', '')}`
  }, [fromDate, toDate])

  const onExportTokenSummary = () => {
    if (!data) return
    const headers = ['token', 'txCount', 'wallets', 'totalIn', 'totalOut']
    const rows = data.tokenStats.map((token) => [
      token.token, token.txCount, token.wallets, token.totalIn, token.totalOut,
    ])
    downloadCsv(`token-summary-${exportDateSuffix}.csv`, headers, rows)
  }

  const onExportWalletDetails = () => {
    if (!data) return
    const headers = [
      'walletAddress', 'txCount', 'totalIn', 'totalOut',
      'celoTx', 'celoIn', 'celoOut',
      'usdtTx', 'usdtIn', 'usdtOut',
      'cusdTx', 'cusdIn', 'cusdOut',
      'usdcTx', 'usdcIn', 'usdcOut',
    ]
    const rows = data.walletStats.map((wallet) => {
      const byToken = new Map(wallet.perToken.map((item) => [item.token, item]))
      const tokenValues = TOKEN_ORDER.flatMap((token) => {
        const item = byToken.get(token)
        return [item?.txCount || 0, item?.in || 0, item?.out || 0]
      })
      return [wallet.walletAddress, wallet.txCount, wallet.totalIn, wallet.totalOut, ...tokenValues]
    })
    downloadCsv(`wallet-details-${exportDateSuffix}.csv`, headers, rows)
  }

  const onExportTimeline = () => {
    if (!data) return
    const headers = ['month', 'celoTx', 'usdtTx', 'cusdTx', 'usdcTx']
    const rows = data.timeline.map((item) => [
      item.month, item.CELO || 0, item.USDT || 0, item.CUSD || 0, item.USDC || 0,
    ])
    downloadCsv(`timeline-${exportDateSuffix}.csv`, headers, rows)
  }

  const onExportTransactions = () => {
    if (!data || !data.transactions) return
    const headers = ['timestamp', 'sender', 'receiver', 'amount', 'token', 'hash']
    const rows = data.transactions.map((tx) => [
      new Date(tx.timestamp * 1000).toISOString(),
      tx.from, tx.to, tx.value, tx.token, tx.hash,
    ])
    downloadCsv(`transactions-${exportDateSuffix}.csv`, headers, rows)
  }

  return (
    <main className="dashboard">
      <form className="controls card" onSubmit={onApplyDateFilter}>
        <div className="control-group">
          <label htmlFor="fromDate">From</label>
          <input
            id="fromDate"
            type="date"
            value={fromDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
        </div>
        <div className="control-group">
          <label htmlFor="toDate">To</label>
          <input
            id="toDate"
            type="date"
            value={toDate}
            onChange={(event) => setToDate(event.target.value)}
          />
        </div>
        <button type="submit" disabled={loading || !fromDate || !toDate}>
          Apply Date Filter
        </button>
        <div className="control-group">
          <label htmlFor="singleAddressQuery">Single Address</label>
          <input
            id="singleAddressQuery"
            value={singleAddressQuery}
            onChange={(event) => setSingleAddressQuery(event.target.value)}
            placeholder="0x..."
          />
        </div>
        <button type="button" onClick={onSearchSingleAddress} disabled={loading || !singleAddressQuery.trim() || !data}>
          Search Address
        </button>
        <button type="button" onClick={onClearSingleAddressSearch} disabled={loading}>
          Clear Address Search
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="loading">Loading wallet stats...</p> : null}
      {copyStatus ? <p className="loading">{copyStatus}</p> : null}

      <section className="view-switch card" aria-label="Dashboard views">
        <button
          type="button"
          className={activeView === 'analysis' ? 'view-btn active' : 'view-btn'}
          onClick={() => setActiveView('analysis')}
        >
          Filters + Graphs
        </button>
        <button
          type="button"
          className={activeView === 'transactions' ? 'view-btn active' : 'view-btn'}
          onClick={() => setActiveView('transactions')}
          disabled={!data}
        >
          Transactions
        </button>
        <button
          type="button"
          className={activeView === 'export' ? 'view-btn active' : 'view-btn'}
          onClick={() => setActiveView('export')}
          disabled={!data}
        >
          Export
        </button>
        {selectedWallet ? (
          <button
            type="button"
            className={activeView === 'wallet' ? 'view-btn active' : 'view-btn'}
            onClick={() => setActiveView('wallet')}
          >
            Wallet Detail
          </button>
        ) : null}

        {data ? (
          <div className="load-more-controls">
            <span className="page-info">
              Loaded {data.walletStats.length} of {addressCount} wallets
              {loadingMore
                ? chunkCountdown > 0
                  ? ` — next chunk in ${chunkCountdown}s (page ${currentPage + 1} of ${totalPages})`
                  : ` — loading chunk ${currentPage} of ${totalPages}…`
                : ` — all loaded`}
            </span>
          </div>
        ) : null}
      </section>

      {selectedWallet && activeView === 'wallet' ? (() => {
        const byToken = new Map(selectedWallet.perToken.map((item) => [item.token, item]))
        const perTokenChartData = TOKEN_ORDER.map((token) => {
          const item = byToken.get(token)
          return { token, txCount: item?.txCount || 0, received: item?.in || 0, sent: item?.out || 0 }
        })
        return (
          <section className="transactions-layout">
            <article className="card transactions-card">
              <h3>Wallet Detail</h3>
              <p className="copyable" onClick={() => copyText(selectedWallet.walletAddress)} title="Click to copy">
                {selectedWallet.walletAddress}
              </p>
              <div className="preview-grid">
                <p>Total Transactions: <strong>{selectedWallet.txCount}</strong></p>
                <p>Total Received: <strong>{formatNumber(selectedWallet.totalIn)}</strong></p>
                <p>Total Sent: <strong>{formatNumber(selectedWallet.totalOut)}</strong></p>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Token</th>
                      <th>Tx Count</th>
                      <th>Received</th>
                      <th>Sent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {TOKEN_ORDER.map((token) => {
                      const item = byToken.get(token)
                      return (
                        <tr key={token}>
                          <td>{token}</td>
                          <td>{item?.txCount || 0}</td>
                          <td>{formatNumber(item?.in || 0)}</td>
                          <td>{formatNumber(item?.out || 0)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </article>
            <article className="card transactions-card">
              <h3>Transactions by Token</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={perTokenChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="token" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="txCount" name="Transactions" fill="#0f766e" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <h3 style={{ marginTop: '1.5rem' }}>Volume Sent &amp; Received</h3>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={perTokenChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="token" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="received" name="Received" fill="#0d9488" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="sent" name="Sent" fill="#ea580c" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>
          </section>
        )
      })() : null}

      {data && activeView === 'analysis' ? (
        <>
          <section className="metric-grid">
            <article className="metric card">
              <h3>Total Token Transactions</h3>
              <p>{formatNumber(totalTx)}</p>
            </article>
            <article className="metric card">
              <h3>Wallets with Activity</h3>
              <p>{formatNumber(data.walletStats.filter((item) => item.txCount > 0).length)}</p>
            </article>
            <article className="metric card">
              <h3>Total Incoming</h3>
              <p>{formatNumber(sumField(data.tokenStats, 'totalIn'))}</p>
            </article>
            <article className="metric card">
              <h3>Total Outgoing</h3>
              <p>{formatNumber(sumField(data.tokenStats, 'totalOut'))}</p>
            </article>
            <article className="metric card">
              <h3>Gas Fees Paid (CELO)</h3>
              <p>{formatGas(data.gasStats?.total)}</p>
            </article>
          </section>

          <section className="chart-grid">
            <article className="chart card">
              <h3>Transactions by Token</h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.tokenStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="token" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="txCount" name="Transactions" fill="#0f766e" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card">
              <h3>Volume Sent &amp; Received by Token</h3>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.tokenStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="token" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="totalIn" name="Received" fill="#0d9488" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="totalOut" name="Sent" fill="#ea580c" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card">
              <h3>Incoming vs Outgoing</h3>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={data.directionStats}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={95}
                    label
                  >
                    {data.directionStats.map((entry, index) => (
                      <Cell
                        key={`direction-${entry.name}`}
                        fill={DIRECTION_COLORS[index % DIRECTION_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card span-2">
              <h3>Monthly Token Activity</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={data.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip />
                  <Line type="monotone" dataKey="CELO" stroke="#115e59" strokeWidth={2.5} />
                  <Line type="monotone" dataKey="USDT" stroke="#0284c7" strokeWidth={2.5} />
                  <Line type="monotone" dataKey="CUSD" stroke="#ea580c" strokeWidth={2.5} />
                  <Line type="monotone" dataKey="USDC" stroke="#a16207" strokeWidth={2.5} />
                </LineChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card span-2">
              <h3>Top Wallets by Transaction Count</h3>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={topWallets} layout="vertical" margin={{ left: 180 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis type="number" />
                  <YAxis dataKey="walletAddress" type="category" width={320} interval={0} />
                  <Tooltip />
                  <Bar dataKey="txCount" fill="#155e75" radius={[0, 8, 8, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card span-2">
              <h3>Monthly Gas Fees (CELO)</h3>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.timeline}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="month" />
                  <YAxis />
                  <Tooltip formatter={(value) => formatGas(value)} />
                  <Line type="monotone" dataKey="gasFeeCELO" name="Gas Fee (CELO)" stroke="#7c3aed" strokeWidth={2.5} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </article>

            <article className="chart card span-2">
              <h3>Token Volume Snapshot</h3>
              <ResponsiveContainer width="100%" height={290}>
                <BarChart data={totalsByToken}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#d6f1eb" />
                  <XAxis dataKey="token" />
                  <YAxis />
                  <Tooltip />
                  <Bar dataKey="volume" fill="#0f766e" />
                </BarChart>
              </ResponsiveContainer>
            </article>
          </section>
        </>
      ) : null}

      {data && activeView === 'transactions' ? (
        <section className="transactions-layout">
          <article className="card transactions-card">
            <div className="control-group">
              <label htmlFor="addressFilter">Filter by address</label>
              <input
                id="addressFilter"
                value={addressFilter}
                onChange={(event) => setAddressFilter(event.target.value)}
                placeholder="Type full or partial wallet address"
              />
            </div>
          </article>

          <article className="card transactions-card">
            <h3>Wallet Stats for All Listed Addresses</h3>
            <p>{filteredWalletStats.length} listed addresses loaded for this filter</p>
            <div className="preview-grid">
              <p>Total addresses that transacted: {transactedAddressCount}</p>
              <p>Total in (listed): {formatNumber(listedTotalIn)}</p>
              <p>Total out (listed): {formatNumber(listedTotalOut)}</p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Tx Count</th>
                    <th>Total In</th>
                    <th>Total Out</th>
                    {TOKEN_ORDER.map((token) => (
                      <Fragment key={token}>
                        <th>{token} Tx</th>
                        <th>{token} In</th>
                        <th>{token} Out</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredWalletStats.map((wallet) => {
                    const byToken = new Map(wallet.perToken.map((item) => [item.token, item]))
                    return (
                      <tr key={wallet.walletAddress}>
                        <td>
                          <button
                            type="button"
                            className="copy-btn"
                            onClick={() => copyText(wallet.walletAddress)}
                          >
                            Copy
                          </button>{' '}
                          <span
                            className="copyable"
                            onClick={() => copyText(wallet.walletAddress)}
                            title="Click to copy wallet"
                          >
                            {wallet.walletAddress}
                          </span>
                        </td>
                        <td>{wallet.txCount}</td>
                        <td>{formatNumber(wallet.totalIn)}</td>
                        <td>{formatNumber(wallet.totalOut)}</td>
                        {TOKEN_ORDER.map((token) => {
                          const item = byToken.get(token)
                          return (
                            <Fragment key={token}>
                              <td>{item?.txCount || 0}</td>
                              <td>{formatNumber(item?.in || 0)}</td>
                              <td>{formatNumber(item?.out || 0)}</td>
                            </Fragment>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      ) : null}

      {data && activeView === 'export' ? (
        <section className="export-layout">
          <article className="card export-card">
            <h3>Export current filtered results</h3>
            <p>
              Active filter window: <strong>{fromDate}</strong> to <strong>{toDate}</strong>
            </p>
            <p>The exported files are generated from the current filtered graphs and stats.</p>
            <div className="export-actions">
              <button type="button" onClick={onExportTokenSummary}>
                Export Token Summary CSV
              </button>
              <button type="button" onClick={onExportWalletDetails}>
                Export Wallet Details CSV
              </button>
              <button type="button" onClick={onExportTimeline}>
                Export Monthly Timeline CSV
              </button>
              <button type="button" onClick={onExportTransactions} disabled={!data?.transactions?.length}>
                Export Transactions CSV
              </button>
            </div>
          </article>

          <article className="card export-card">
            <h3>Preview before export</h3>
            <div className="preview-grid">
              <p>Total token rows: {data.tokenStats.length}</p>
              <p>Total wallet rows: {data.walletStats.length}</p>
              <p>Total timeline rows: {data.timeline.length}</p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>Tx Count</th>
                    <th>Total In</th>
                    <th>Total Out</th>
                  </tr>
                </thead>
                <tbody>
                  {topWallets.slice(0, 6).map((wallet) => (
                    <tr key={wallet.walletAddress}>
                      <td>
                        <button
                          type="button"
                          className="copy-btn"
                          onClick={() => copyText(wallet.walletAddress)}
                        >
                          Copy
                        </button>{' '}
                        <span
                          className="copyable"
                          onClick={() => copyText(wallet.walletAddress)}
                          title="Click to copy wallet"
                        >
                          {wallet.walletAddress}
                        </span>
                      </td>
                      <td>{wallet.txCount}</td>
                      <td>{formatNumber(wallet.totalIn)}</td>
                      <td>{formatNumber(wallet.totalOut)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      ) : null}
    </main>
  )
}

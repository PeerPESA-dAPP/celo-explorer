import {
  corsHeaders,
  DEFAULT_DATA_MODULE_PATH,
  extractAddressesFromModule,
  logTrace,
} from '../../../lib/wallet-stats.js'

export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const dataModulePath = DEFAULT_DATA_MODULE_PATH
  const addressQuery = (searchParams.get('addressQuery') || '').trim().toLowerCase()
  const pageSize = Number(searchParams.get('limit')) || 15
  const pageNumber = Math.max(1, Number(searchParams.get('page')) || 1)

  logTrace('api.addresses:start', { dataModulePath, addressQuery, pageSize, pageNumber })

  const origin = request.headers.get('origin') || ''
  const headers = corsHeaders(origin)

  try {
    const allAddresses = await extractAddressesFromModule(dataModulePath)
    const addresses = addressQuery
      ? allAddresses.filter((address) => address.includes(addressQuery))
      : allAddresses
    const totalPages = Math.ceil(addresses.length / pageSize)
    const startIdx = (pageNumber - 1) * pageSize
    const endIdx = startIdx + pageSize
    const pageAddresses = addresses.slice(startIdx, endIdx)

    logTrace('api.addresses:done', {
      totalAddresses: allAddresses.length,
      matchedAddresses: addresses.length,
      returnedAddresses: pageAddresses.length,
      pageNumber,
      totalPages,
    })

    return Response.json(
      {
        dataModulePath,
        addresses: pageAddresses,
        totalMatchedAddresses: addresses.length,
        count: addresses.length,
        page: pageNumber,
        pageSize,
        totalPages,
        currentPageSize: pageAddresses.length,
      },
      { headers },
    )
  } catch (error) {
    logTrace('api.addresses:error', { message: String(error.message || error) })
    return Response.json(
      { message: `Could not read addresses from data module: ${String(error.message || error)}` },
      { status: 500, headers },
    )
  }
}

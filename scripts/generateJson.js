import fs from 'node:fs/promises'
import Papa from 'papaparse'

const CSV_PATH = './data/sql.csv'
const DATA_MODULE_PATH = './data/addresses.js'

const generateJsonFromCsv = async () => {
  try {
    console.log('Reading CSV file...')
    const rawCsv = await fs.readFile(CSV_PATH, 'utf8')

    console.log('Parsing CSV...')
    const parsed = Papa.parse(rawCsv, { header: true, skipEmptyLines: true })

    console.log(`Found ${parsed.data.length} rows`)

    const jsonData = parsed.data.map((row, index) => ({
      id: index + 1,
      email: row.masked_email || '',
      address: row.address ? row.address.toLowerCase() : '',
    }))

    const moduleSource = `const walletRecords = ${JSON.stringify(jsonData, null, 2)}\n\nexport default walletRecords\nexport { walletRecords }\n`

    console.log(`Writing JS data module to ${DATA_MODULE_PATH}...`)
    await fs.writeFile(DATA_MODULE_PATH, moduleSource)

    console.log(`✓ Successfully generated ${DATA_MODULE_PATH} with ${jsonData.length} records`)
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}

generateJsonFromCsv()

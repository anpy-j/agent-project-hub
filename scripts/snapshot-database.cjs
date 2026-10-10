const Database = require('better-sqlite3')
const { mkdirSync, existsSync, renameSync } = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const source = path.join(root, 'data', 'project-hub.db')
if (!existsSync(source)) throw new Error('Project database is missing: ' + source)
const dir = path.join(root, '.packaging-data')
mkdirSync(dir, { recursive: true })
const temporary = path.join(dir, `snapshot-${process.pid}-${Date.now()}.db`)
const database = new Database(source, { readonly: true })
try {
  database.exec(`VACUUM INTO '${temporary.replace(/'/g, "''")}'`)
  renameSync(temporary, path.join(dir, 'project-hub.db'))
} finally { database.close() }

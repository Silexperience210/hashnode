import Database from 'better-sqlite3'
import { readFileSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dir = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH || join(__dir, '../../data/hashnode.db')

let db

export function getDb() {
  if (!db) {
    mkdirSync(dirname(DB_PATH), { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    // Run schema
    const schema = readFileSync(join(__dir, '../../db/schema.sql'), 'utf8')
    db.exec(schema)
  }
  return db
}

export function getConfig(key, defaultVal = null) {
  const db = getDb()
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key)
  return row ? row.value : defaultVal
}

export function setConfig(key, value) {
  const db = getDb()
  db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, String(value))
}

export function isSetupComplete() {
  return getConfig('setup_complete') === '1'
}

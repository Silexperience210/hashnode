import jwt from 'jsonwebtoken'
import { getConfig, setConfig } from './db.js'
import crypto from 'crypto'

const BOOT_SECRET = crypto.randomBytes(48).toString('hex')

function getSecret() {
  // Use DB secret if set (persisted by setup/init). Fall back to a
  // per-process boot secret so all requests within the same process share
  // the same key even before setup runs (tokens survive across requests
  // but are invalidated on server restart — acceptable pre-setup behaviour).
  return getConfig('jwt_secret') || BOOT_SECRET
}

export function sign(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: '30d' })
}

export function verify(token) {
  try { return jwt.verify(token, getSecret()) } catch { return null }
}

export function fromHeader(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}

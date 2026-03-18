import jwt from 'jsonwebtoken'
import { getConfig, setConfig } from './db.js'
import crypto from 'crypto'

function getSecret() {
  let secret = getConfig('jwt_secret')
  if (!secret) {
    // Use a temporary secret until setup runs setConfig('jwt_secret', ...)
    secret = crypto.randomBytes(48).toString('hex')
  }
  return secret
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

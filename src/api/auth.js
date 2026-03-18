/**
 * Auth API — NIP-07 challenge/verify flow
 *
 * POST /api/auth/challenge  — request a challenge for a pubkey
 * POST /api/auth/verify     — submit signed NIP-07 event, receive JWT
 * GET  /api/auth/profile    — return the authenticated user's profile
 *
 * Also exports requireAuth and requireAdmin middlewares used by other routers.
 */
import { Router } from 'express'
import crypto from 'crypto'
import { getDb, getConfig } from '../lib/db.js'
import { isValidPubkey, verifyAuthEvent } from '../lib/nostr-auth.js'
import { sign, verify, fromHeader } from '../lib/jwt.js'
import { secp256k1 } from '@noble/curves/secp256k1'

// ── Minimal bech32 encoder (for LNURL — no external dep needed) ────────────────
const B32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const B32_GEN     = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
function _b32Polymod(v) {
  let c = 1
  for (const x of v) { const t = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= B32_GEN[i] }
  return c
}
function _b32HrpExpand(hrp) {
  const r = [...hrp].map(c => c.charCodeAt(0) >> 5)
  r.push(0)
  return r.concat([...hrp].map(c => c.charCodeAt(0) & 31))
}
function _b32ConvertBits(data, from, to) {
  let acc = 0, bits = 0
  const ret = [], maxv = (1 << to) - 1
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv) } }
  if (bits > 0) ret.push((acc << (to - bits)) & maxv)
  return ret
}
function toLnurl(url) {
  const hrp = 'lnurl'
  const data = _b32ConvertBits(Buffer.from(url, 'utf8'), 8, 5)
  const chkIn = [..._b32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = _b32Polymod(chkIn) ^ 1
  const checksum = [5,4,3,2,1,0].map(p => (mod >> (5 * p)) & 31)
  return (hrp + '1' + [...data, ...checksum].map(d => B32_CHARSET[d]).join('')).toUpperCase()
}

// ── LNURL-auth in-memory sessions: k1 → { key: null|string, created: ms } ─────
const lnauthSessions = new Map()

const router = Router()

// ── Rate limiting (in-memory) ─────────────────────────────────────────────────
// Stores: key → [timestamp, …] within a sliding WINDOW_MS window
const rateLimitByPubkey = new Map()
const rateLimitByIp     = new Map()
const WINDOW_MS         = 5 * 60 * 1000  // 5 minutes
const MAX_PER_PUBKEY    = 5
const MAX_PER_IP        = 30

/**
 * Returns true when the caller is within rate limit, false when they are over.
 * Automatically evicts timestamps outside the window.
 */
function checkRateLimit(map, key, max) {
  const now  = Date.now()
  const hits = (map.get(key) || []).filter((t) => now - t < WINDOW_MS)
  if (hits.length >= max) return false
  hits.push(now)
  map.set(key, hits)
  return true
}

/** Best-effort client IP: honours X-Forwarded-For when behind a reverse proxy. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return forwarded.split(',')[0].trim()
  return req.socket?.remoteAddress || req.ip || 'unknown'
}

// ── GET /lnauth/start ─────────────────────────────────────────────────────────
// Returns { k1, lnurl } — browser opens lnurl in Lightning wallet
router.get('/lnauth/start', (req, res) => {
  try {
    const k1 = crypto.randomBytes(32).toString('hex')

    // Build callback URL (use Cloudflare URL if available, else request host)
    const cfUrl = getConfig('cloudflare_url') || ''
    let base
    if (cfUrl) {
      base = cfUrl.replace(/\/$/, '')
    } else {
      const proto = req.headers['x-forwarded-proto'] || 'http'
      const host  = req.headers['x-forwarded-host']  || req.headers.host
      base = `${proto}://${host}`
    }
    const callbackUrl = `${base}/api/auth/lnauth/callback?tag=login&k1=${k1}&action=login`
    const lnurl = toLnurl(callbackUrl)

    // Purge stale sessions (> 10 min old)
    for (const [k, v] of lnauthSessions) {
      if (Date.now() - v.created > 10 * 60 * 1000) lnauthSessions.delete(k)
    }
    lnauthSessions.set(k1, { key: null, created: Date.now() })

    return res.json({ k1, lnurl })
  } catch (err) {
    console.error('[auth/lnauth/start] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /lnauth/callback ──────────────────────────────────────────────────────
// Called by Lightning wallet after user approves login
router.get('/lnauth/callback', (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  try {
    const { k1, sig, key } = req.query
    if (!k1 || !sig || !key) return res.json({ status: 'ERROR', reason: 'Missing parameters' })

    const session = lnauthSessions.get(k1)
    if (!session) return res.json({ status: 'ERROR', reason: 'Unknown or expired challenge' })

    // Verify secp256k1 DER signature: sig(k1_bytes) with compressed pubkey
    const msgBytes = Buffer.from(k1, 'hex')
    const sigObj   = secp256k1.Signature.fromDER(sig)
    const valid    = secp256k1.verify(sigObj, msgBytes, key)
    if (!valid) return res.json({ status: 'ERROR', reason: 'Invalid signature' })

    session.key = key
    return res.json({ status: 'OK' })
  } catch (err) {
    console.error('[auth/lnauth/callback] error:', err)
    return res.json({ status: 'ERROR', reason: 'Verification error: ' + err.message })
  }
})

// ── GET /lnauth/poll/:k1 ──────────────────────────────────────────────────────
// SSE stream — browser waits here until wallet confirms
router.get('/lnauth/poll/:k1', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const k1      = req.params.k1
  const session = lnauthSessions.get(k1)
  if (!session) {
    res.write(`data: ${JSON.stringify({ error: 'unknown_k1' })}\n\n`)
    return res.end()
  }

  if (session.key) { _finishLnauth(k1, session.key, res); return }

  let attempts = 0
  const timer = setInterval(() => {
    const s = lnauthSessions.get(k1)
    if (s?.key) { clearInterval(timer); _finishLnauth(k1, s.key, res) }
    else if (++attempts >= 150) {
      clearInterval(timer)
      res.write(`data: ${JSON.stringify({ error: 'timeout' })}\n\n`)
      res.end()
    }
  }, 2000)

  req.on('close', () => clearInterval(timer))
})

function _finishLnauth(k1, rawKey, res) {
  lnauthSessions.delete(k1)

  // LNAUTH key = 33-byte compressed pubkey (66 hex). Strip parity prefix for storage.
  const pubkey = rawKey.length === 66 ? rawKey.slice(2) : rawKey

  const db          = getDb()
  const ownerPubkey = getConfig('owner_pubkey') || ''
  const adminList   = (getConfig('admin_pubkeys') || '').split(',').map(s => s.trim()).filter(Boolean)
  const isAdmin     = pubkey === ownerPubkey || adminList.includes(pubkey) ? 1 : 0

  db.prepare(
    `INSERT INTO users (pubkey_nostr, is_admin) VALUES (?, ?)
     ON CONFLICT(pubkey_nostr) DO UPDATE SET is_admin = excluded.is_admin`
  ).run(pubkey, isAdmin)

  const user  = db.prepare('SELECT * FROM users WHERE pubkey_nostr = ?').get(pubkey)
  const token = sign({ sub: user.id, pubkey: user.pubkey_nostr, is_admin: user.is_admin === 1 })

  res.write(`data: ${JSON.stringify({
    token,
    pubkey,
    user: { id: user.id, pubkey, is_admin: user.is_admin === 1 },
  })}\n\n`)
  res.end()
}

// ── POST /challenge ───────────────────────────────────────────────────────────
router.post('/challenge', (req, res) => {
  try {
    const { pubkey } = req.body || {}
    if (!pubkey || !isValidPubkey(pubkey)) {
      return res.status(400).json({ error: 'Invalid pubkey — must be 64 lowercase hex chars' })
    }

    const ip = clientIp(req)

    if (!checkRateLimit(rateLimitByPubkey, pubkey, MAX_PER_PUBKEY)) {
      return res.status(429).json({ error: `Too many challenge requests for this pubkey (max ${MAX_PER_PUBKEY} per 5 min)` })
    }
    if (!checkRateLimit(rateLimitByIp, ip, MAX_PER_IP)) {
      return res.status(429).json({ error: `Too many challenge requests from this IP (max ${MAX_PER_IP} per 5 min)` })
    }

    const challenge  = crypto.randomBytes(32).toString('hex')
    const expiresAt  = new Date(Date.now() + WINDOW_MS).toISOString()

    const db = getDb()
    // Purge stale challenges for this pubkey before inserting
    db.prepare("DELETE FROM challenges WHERE pubkey_nostr = ? AND expires_at < datetime('now')").run(pubkey)
    db.prepare(
      'INSERT INTO challenges (challenge, pubkey_nostr, ip_address, expires_at) VALUES (?,?,?,?)'
    ).run(challenge, pubkey, ip, expiresAt)

    return res.json({ challenge })
  } catch (err) {
    console.error('[auth/challenge] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /verify ──────────────────────────────────────────────────────────────
router.post('/verify', (req, res) => {
  try {
    const { event } = req.body || {}
    if (!event || typeof event !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid event object' })
    }

    const pubkey = event.pubkey
    if (!isValidPubkey(pubkey)) {
      return res.status(400).json({ error: 'Invalid pubkey in event' })
    }

    const db = getDb()
    const challengeRow = db.prepare(
      "SELECT * FROM challenges WHERE pubkey_nostr = ? AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1"
    ).get(pubkey)

    if (!challengeRow) {
      return res.status(401).json({ error: 'No valid challenge found — request a new challenge first' })
    }

    // Consume the challenge immediately to prevent replay attacks
    db.prepare('DELETE FROM challenges WHERE id = ?').run(challengeRow.id)

    if (!verifyAuthEvent(event, challengeRow.challenge)) {
      return res.status(401).json({ error: 'Invalid event signature or content mismatch' })
    }

    // Determine admin status: owner_pubkey in config has admin rights
    const ownerPubkey    = getConfig('owner_pubkey') || ''
    const adminPubkeys   = (getConfig('admin_pubkeys') || '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const isAdmin = pubkey === ownerPubkey || adminPubkeys.includes(pubkey) ? 1 : 0

    // Upsert user — on conflict update is_admin in case it changed
    db.prepare(
      `INSERT INTO users (pubkey_nostr, is_admin)
       VALUES (?, ?)
       ON CONFLICT(pubkey_nostr) DO UPDATE SET is_admin = excluded.is_admin`
    ).run(pubkey, isAdmin)

    const user = db.prepare('SELECT * FROM users WHERE pubkey_nostr = ?').get(pubkey)

    const token = sign({
      sub:      user.id,
      pubkey:   user.pubkey_nostr,
      is_admin: user.is_admin === 1,
    })

    return res.json({
      token,
      user: {
        id:         user.id,
        pubkey:     user.pubkey_nostr,
        is_admin:   user.is_admin === 1,
        created_at: user.created_at,
      },
    })
  } catch (err) {
    console.error('[auth/verify] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /profile ──────────────────────────────────────────────────────────────
router.get('/profile', requireAuth, (req, res) => {
  try {
    const db   = getDb()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const stats = {
      total_rentals:  db.prepare('SELECT COUNT(*) as c FROM rentals WHERE user_id = ?').get(user.id).c,
      active_rentals: db.prepare("SELECT COUNT(*) as c FROM rentals WHERE user_id = ? AND status = 'active'").get(user.id).c,
      total_spent_sats: db.prepare(
        "SELECT COALESCE(SUM(total_sats),0) as s FROM rentals WHERE user_id = ? AND status IN ('active','completed')"
      ).get(user.id).s,
    }

    return res.json({
      id:         user.id,
      pubkey:     user.pubkey_nostr,
      is_admin:   user.is_admin === 1,
      created_at: user.created_at,
      stats,
    })
  } catch (err) {
    console.error('[auth/profile] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Middlewares ───────────────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
  const token   = fromHeader(req.headers.authorization)
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' })
  const payload = verify(token)
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' })
  req.userId      = payload.sub
  req.userPubkey  = payload.pubkey
  req.isAdmin     = payload.is_admin === true
  next()
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' })
    next()
  })
}

export default router

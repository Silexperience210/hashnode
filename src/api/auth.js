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

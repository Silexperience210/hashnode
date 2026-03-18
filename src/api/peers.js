/**
 * Peers API — view discovered peers and re-announce this node
 *
 * GET  /api/peers          — combined list (mDNS + Nostr DB records)
 * POST /api/peers/announce — force re-announce on Nostr (admin only)
 */
import { Router } from 'express'
import { getDb } from '../lib/db.js'
import { getLocalPeers } from '../lib/mdns.js'
import { publishNodeAnnouncement } from '../lib/nostr-p2p.js'
import { requireAdmin } from './auth.js'

const router = Router()

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db          = getDb()
    const nostrPeers  = db.prepare('SELECT * FROM peers ORDER BY last_seen DESC LIMIT 100').all()
    const mdnsPeers   = getLocalPeers()

    // Merge: keyed by pubkey; DB records take precedence, mDNS fills in unknowns
    const merged = new Map()

    for (const p of nostrPeers) {
      merged.set(p.id, {
        pubkey:      p.id,
        name:        p.name,
        endpoint:    p.endpoint,
        last_seen:   p.last_seen,
        source:      p.source,
        miners:      safeJson(p.miners_json, []),
      })
    }

    for (const p of mdnsPeers) {
      if (!merged.has(p.pubkey)) {
        merged.set(p.pubkey, {
          pubkey:    p.pubkey,
          name:      p.name || 'HashNode',
          endpoint:  p.endpoint,
          last_seen: p.last_seen,
          source:    'mdns',
          miners:    [],
        })
      }
    }

    return res.json({ peers: Array.from(merged.values()) })
  } catch (err) {
    console.error('[peers/list] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /announce ────────────────────────────────────────────────────────────
router.post('/announce', requireAdmin, async (req, res) => {
  try {
    const db     = getDb()
    const miners = db.prepare("SELECT * FROM miners WHERE status != 'offline'").all()
    await publishNodeAnnouncement(miners)
    return res.json({ ok: true, miners_announced: miners.length })
  } catch (err) {
    console.error('[peers/announce] error:', err)
    return res.status(500).json({ error: 'Announcement failed: ' + err.message })
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJson(str, fallback = {}) {
  try { return JSON.parse(str || JSON.stringify(fallback)) } catch { return fallback }
}

export default router

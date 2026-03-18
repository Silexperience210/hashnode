/**
 * Miners API — public read endpoints + internal stats push
 *
 * GET   /api/miners        — list all non-offline miners (public)
 * GET   /api/miners/:id    — single miner detail (public)
 * PATCH /api/miners/:id/stats — internal: update live stats pushed by Bitaxe
 */
import { Router } from 'express'
import { getDb } from '../lib/db.js'

const router = Router()

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db     = getDb()
    const miners = db.prepare("SELECT * FROM miners WHERE status != 'offline' ORDER BY created_at ASC").all()

    const result = miners.map((m) => {
      const meta        = safeJson(m.metadata)
      const activeRental = db.prepare(
        "SELECT id, end_time FROM rentals WHERE miner_id = ? AND status = 'active'"
      ).get(m.id)

      return {
        id:                m.id,
        name:              m.name,
        model:             meta.model || 'Bitaxe',
        hashrate_ths:      m.hashrate_specs,
        sats_per_minute:   m.sats_per_minute,
        sats_per_hour:     m.sats_per_minute * 60,
        uptime_pct:        parseFloat(m.uptime_pct || 100),
        status:            m.status,
        available:         m.status === 'online' && !activeRental,
        occupied_until:    activeRental?.end_time ?? null,
        // Live stats (null until first push)
        last_hashrate:     meta.last_hashrate ?? null,
        last_temp_c:       meta.last_temp     ?? null,
        last_power_w:      meta.last_power    ?? null,
        updated_at:        m.updated_at,
      }
    })

    return res.json({ miners: result })
  } catch (err) {
    console.error('[miners/list] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id ──────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db    = getDb()
    const miner = db.prepare('SELECT * FROM miners WHERE id = ?').get(req.params.id)
    if (!miner) return res.status(404).json({ error: 'Miner not found' })

    const meta        = safeJson(miner.metadata)
    const activeRental = db.prepare(
      `SELECT r.id, r.end_time, r.duration_minutes, r.start_time
       FROM rentals r WHERE r.miner_id = ? AND r.status = 'active'`
    ).get(miner.id)

    return res.json({
      id:              miner.id,
      name:            miner.name,
      ip_address:      miner.ip_address,
      port:            miner.port,
      model:           meta.model || 'Bitaxe',
      hashrate_ths:    miner.hashrate_specs,
      sats_per_minute: miner.sats_per_minute,
      sats_per_hour:   miner.sats_per_minute * 60,
      uptime_pct:      parseFloat(miner.uptime_pct || 100),
      total_revenue_sats: miner.total_revenue_sats,
      status:          miner.status,
      available:       miner.status === 'online' && !activeRental,
      active_rental:   activeRental ?? null,
      last_hashrate:   meta.last_hashrate ?? null,
      last_temp_c:     meta.last_temp     ?? null,
      last_power_w:    meta.last_power    ?? null,
      created_at:      miner.created_at,
      updated_at:      miner.updated_at,
    })
  } catch (err) {
    console.error('[miners/detail] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /:id/stats ──────────────────────────────────────────────────────────
// Internal route — called by Bitaxe push or a local cron, not authenticated
// but should only be reachable from the local network (enforce in deployment via
// firewall / reverse proxy, not in this layer).
router.patch('/:id/stats', (req, res) => {
  try {
    const db    = getDb()
    const miner = db.prepare('SELECT * FROM miners WHERE id = ?').get(req.params.id)
    if (!miner) return res.status(404).json({ error: 'Miner not found' })

    const { hashrate, temp, power } = req.body || {}

    // Merge into existing metadata JSON
    const meta = safeJson(miner.metadata)
    if (hashrate !== undefined) meta.last_hashrate = parseFloat(hashrate) || null
    if (temp    !== undefined) meta.last_temp      = parseFloat(temp)     || null
    if (power   !== undefined) meta.last_power     = parseFloat(power)    || null

    db.prepare(
      "UPDATE miners SET metadata = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(meta), miner.id)

    return res.json({ ok: true })
  } catch (err) {
    console.error('[miners/stats] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJson(str) {
  try { return JSON.parse(str || '{}') } catch { return {} }
}

export default router

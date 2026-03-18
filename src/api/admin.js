/**
 * Admin API — protected management endpoints
 * All routes require admin JWT (requireAdmin middleware).
 *
 * GET    /api/admin/stats            — aggregate statistics
 * GET    /api/admin/miners           — full miner list with metadata
 * POST   /api/admin/miners           — add miner manually
 * PATCH  /api/admin/miners/:id       — update miner fields
 * DELETE /api/admin/miners/:id       — delete miner (only if no active rentals)
 * POST   /api/admin/health-check     — ping all miners, deactivate expired rentals
 * GET    /api/admin/rentals          — all rentals with user + miner info
 */
import { Router } from 'express'
import { getDb } from '../lib/db.js'
import { requireAdmin } from './auth.js'
import { getBitaxeStats } from '../lib/bitaxe-scanner.js'

const router = Router()

// ── GET /stats ────────────────────────────────────────────────────────────────
router.get('/stats', requireAdmin, (req, res) => {
  try {
    const db = getDb()

    const totalMiners   = db.prepare('SELECT COUNT(*) AS c FROM miners').get().c
    const activeRentals = db.prepare("SELECT COUNT(*) AS c FROM rentals WHERE status = 'active'").get().c
    const pendingRentals = db.prepare("SELECT COUNT(*) AS c FROM rentals WHERE status = 'pending'").get().c
    const totalRevenue  = db.prepare(
      "SELECT COALESCE(SUM(total_sats),0) AS s FROM rentals WHERE status IN ('active','completed')"
    ).get().s

    return res.json({
      total_miners:    totalMiners,
      active_rentals:  activeRentals,
      pending_rentals: pendingRentals,
      total_revenue_sats: totalRevenue,
    })
  } catch (err) {
    console.error('[admin/stats] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /miners ───────────────────────────────────────────────────────────────
router.get('/miners', requireAdmin, (req, res) => {
  try {
    const db     = getDb()
    const miners = db.prepare('SELECT * FROM miners ORDER BY created_at ASC').all()

    const result = miners.map((m) => {
      const meta         = safeJson(m.metadata)
      const activeRental = db.prepare(
        "SELECT id FROM rentals WHERE miner_id = ? AND status = 'active'"
      ).get(m.id)
      return {
        ...m,
        metadata:       meta,
        currently_rented: !!activeRental,
      }
    })

    return res.json({ miners: result })
  } catch (err) {
    console.error('[admin/miners/list] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /miners ──────────────────────────────────────────────────────────────
router.post('/miners', requireAdmin, (req, res) => {
  try {
    const { ip, name, sats_per_minute, hashrate_specs, port, model } = req.body || {}

    if (!ip)             return res.status(400).json({ error: 'ip is required' })
    if (!name)           return res.status(400).json({ error: 'name is required' })
    if (!sats_per_minute) return res.status(400).json({ error: 'sats_per_minute is required' })
    if (!hashrate_specs)  return res.status(400).json({ error: 'hashrate_specs is required' })

    const spm      = parseInt(sats_per_minute, 10)
    const hashrate = parseFloat(hashrate_specs)
    if (!Number.isFinite(spm) || spm < 1)       return res.status(400).json({ error: 'Invalid sats_per_minute' })
    if (!Number.isFinite(hashrate) || hashrate <= 0) return res.status(400).json({ error: 'Invalid hashrate_specs' })

    const meta = JSON.stringify({ model: model || 'Bitaxe' })
    const db   = getDb()
    const info = db.prepare(
      'INSERT INTO miners (name, ip_address, port, hashrate_specs, sats_per_minute, metadata) VALUES (?,?,?,?,?,?)'
    ).run(name.trim(), ip.trim(), parseInt(port, 10) || 80, hashrate, spm, meta)

    const miner = db.prepare('SELECT id FROM miners WHERE rowid = ?').get(info.lastInsertRowid)
    return res.status(201).json({ ok: true, miner_id: miner.id })
  } catch (err) {
    console.error('[admin/miners/add] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /miners/:id ─────────────────────────────────────────────────────────
router.patch('/miners/:id', requireAdmin, (req, res) => {
  try {
    const db    = getDb()
    const miner = db.prepare('SELECT * FROM miners WHERE id = ?').get(req.params.id)
    if (!miner) return res.status(404).json({ error: 'Miner not found' })

    const { name, ip_address, port, hashrate_specs, sats_per_minute, status, metadata } = req.body || {}

    const VALID_STATUSES = ['online', 'offline', 'maintenance']
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
    }

    // Merge metadata objects rather than wholesale replace
    let newMeta = safeJson(miner.metadata)
    if (metadata && typeof metadata === 'object') {
      newMeta = { ...newMeta, ...metadata }
    }

    db.prepare(`
      UPDATE miners SET
        name           = COALESCE(?, name),
        ip_address     = COALESCE(?, ip_address),
        port           = COALESCE(?, port),
        hashrate_specs = COALESCE(?, hashrate_specs),
        sats_per_minute = COALESCE(?, sats_per_minute),
        status         = COALESCE(?, status),
        metadata       = ?,
        updated_at     = datetime('now')
      WHERE id = ?
    `).run(
      name        ? name.trim()              : null,
      ip_address  ? ip_address.trim()        : null,
      port        ? parseInt(port, 10)       : null,
      hashrate_specs ? parseFloat(hashrate_specs) : null,
      sats_per_minute ? parseInt(sats_per_minute, 10) : null,
      status || null,
      JSON.stringify(newMeta),
      miner.id
    )

    return res.json({ ok: true })
  } catch (err) {
    console.error('[admin/miners/update] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── DELETE /miners/:id ────────────────────────────────────────────────────────
router.delete('/miners/:id', requireAdmin, (req, res) => {
  try {
    const db    = getDb()
    const miner = db.prepare('SELECT id FROM miners WHERE id = ?').get(req.params.id)
    if (!miner) return res.status(404).json({ error: 'Miner not found' })

    const active = db.prepare(
      "SELECT id FROM rentals WHERE miner_id = ? AND status IN ('active','pending')"
    ).get(req.params.id)
    if (active) {
      return res.status(409).json({ error: 'Cannot delete a miner that has active or pending rentals' })
    }

    db.prepare('DELETE FROM miners WHERE id = ?').run(req.params.id)
    return res.json({ ok: true })
  } catch (err) {
    console.error('[admin/miners/delete] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /health-check ────────────────────────────────────────────────────────
router.post('/health-check', requireAdmin, async (req, res) => {
  try {
    const db     = getDb()
    const miners = db.prepare('SELECT * FROM miners').all()
    const results = []

    for (const miner of miners) {
      const stats    = await getBitaxeStats(miner.ip_address, miner.port)
      const newStatus = stats ? 'online' : 'offline'
      const meta     = safeJson(miner.metadata)

      if (stats) {
        meta.last_hashrate = stats.hashrate
        meta.last_temp     = stats.temp
        meta.last_power    = stats.power
      }

      db.prepare(
        "UPDATE miners SET status = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newStatus, JSON.stringify(meta), miner.id)

      results.push({ id: miner.id, name: miner.name, status: newStatus, stats: stats || null })
    }

    // Expire overdue active rentals
    const expired = db.prepare(`
      UPDATE rentals
      SET status = 'expired', updated_at = datetime('now')
      WHERE status = 'active' AND end_time < datetime('now')
    `).run()

    return res.json({
      miners_checked:   results.length,
      rentals_expired:  expired.changes,
      results,
    })
  } catch (err) {
    console.error('[admin/health-check] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /rentals ──────────────────────────────────────────────────────────────
router.get('/rentals', requireAdmin, (req, res) => {
  try {
    const db      = getDb()
    const { status, limit = '50', offset = '0' } = req.query

    let query = `
      SELECT r.*,
             m.name          AS miner_name,
             m.ip_address    AS miner_ip,
             m.hashrate_specs,
             u.pubkey_nostr  AS user_pubkey
      FROM   rentals r
      JOIN   miners  m ON m.id = r.miner_id
      JOIN   users   u ON u.id = r.user_id
    `
    const params = []
    if (status) {
      query += ' WHERE r.status = ?'
      params.push(status)
    }
    query += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?'
    params.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0)

    const rentals = db.prepare(query).all(...params)
    const total   = db.prepare(
      status ? 'SELECT COUNT(*) AS c FROM rentals WHERE status = ?' : 'SELECT COUNT(*) AS c FROM rentals'
    ).get(...(status ? [status] : [])).c

    const result = rentals.map((r) => ({
      ...r,
      metadata: safeJson(r.metadata),
    }))

    return res.json({ rentals: result, total })
  } catch (err) {
    console.error('[admin/rentals] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJson(str) {
  try { return JSON.parse(str || '{}') } catch { return {} }
}

export default router

/**
 * Rentals API — create, poll, and list rentals
 *
 * POST /api/rentals           — create a rental (pending, returns invoice)
 * GET  /api/rentals/status/:id — poll payment + activate once paid
 * GET  /api/rentals/my        — list the authenticated user's rentals
 */
import { Router } from 'express'
import { getDb, getConfig } from '../lib/db.js'
import { requireAuth } from './auth.js'
import { makeInvoice, lookupInvoice } from '../lib/nwc.js'
import { configureBitaxe } from '../lib/bitaxe-scanner.js'

const router = Router()

// ── POST / ────────────────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { miner_id, duration_minutes, payout_address, pool_url } = req.body || {}

    // Input validation
    if (!miner_id)         return res.status(400).json({ error: 'miner_id is required' })
    if (!duration_minutes) return res.status(400).json({ error: 'duration_minutes is required' })
    if (!payout_address)   return res.status(400).json({ error: 'payout_address is required' })
    if (!pool_url)         return res.status(400).json({ error: 'pool_url is required' })

    const mins = parseInt(duration_minutes, 10)
    if (!Number.isFinite(mins) || mins < 1 || mins > 1440) {
      return res.status(400).json({ error: 'duration_minutes must be between 1 and 1440' })
    }

    const db    = getDb()
    const miner = db.prepare("SELECT * FROM miners WHERE id = ? AND status = 'online'").get(miner_id)
    if (!miner) return res.status(404).json({ error: 'Miner not found or currently offline' })

    // DB-level unique index also blocks this, but give a friendly error first
    const occupied = db.prepare(
      "SELECT id FROM rentals WHERE miner_id = ? AND status IN ('active','pending')"
    ).get(miner_id)
    if (occupied) return res.status(409).json({ error: 'Miner is already rented or has a pending payment' })

    // Compute cost
    const totalSats = miner.sats_per_minute * mins

    // Create Lightning invoice via NWC
    const nwcStr = getConfig('nwc_connection_string')
    if (!nwcStr) return res.status(500).json({ error: 'Node NWC not configured — contact the node operator' })

    let invoice, paymentHash
    try {
      const result = await makeInvoice(
        nwcStr,
        totalSats,
        `HashNode: ${miner.name} ${mins}m @ ${payout_address.slice(0, 12)}…`
      )
      invoice     = result.invoice
      paymentHash = result.payment_hash
    } catch (e) {
      console.error('[rentals/create] makeInvoice failed:', e.message)
      return res.status(502).json({ error: 'Failed to create Lightning invoice: ' + e.message })
    }

    const now              = new Date()
    const invoiceExpiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString()
    const startTime        = now.toISOString()
    const endTime          = new Date(now.getTime() + mins * 60 * 1000).toISOString()

    const meta = JSON.stringify({
      pool_url,
      payout_address,
      stratum_user: `${payout_address}.hashnode`,
    })

    const info = db.prepare(`
      INSERT INTO rentals
        (miner_id, user_id, status, duration_minutes, sats_per_minute, total_sats,
         invoice_hash, invoice_bolt11, invoice_expires_at, start_time, end_time, metadata)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      miner_id, req.userId, 'pending', mins, miner.sats_per_minute, totalSats,
      paymentHash, invoice, invoiceExpiresAt, startTime, endTime, meta
    )

    // Retrieve the generated UUID
    const rental = db.prepare('SELECT id FROM rentals WHERE rowid = ?').get(info.lastInsertRowid)

    return res.status(201).json({
      rental_id:   rental.id,
      invoice,
      amount_sats: totalSats,
    })
  } catch (err) {
    console.error('[rentals/create] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /status/:id ───────────────────────────────────────────────────────────
router.get('/status/:id', requireAuth, async (req, res) => {
  try {
    const db     = getDb()
    const rental = db.prepare(`
      SELECT r.*,
             m.name        AS miner_name,
             m.hashrate_specs,
             m.ip_address,
             m.port,
             m.metadata    AS miner_meta
      FROM   rentals r
      JOIN   miners  m ON m.id = r.miner_id
      WHERE  r.id = ?
    `).get(req.params.id)

    if (!rental) return res.status(404).json({ error: 'Rental not found' })

    // Only the owner (or admin) can see status
    if (rental.user_id !== req.userId && !req.isAdmin) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // If pending: poll the invoice and activate when paid
    if (rental.status === 'pending' && rental.invoice_hash) {
      const nwcStr = getConfig('nwc_connection_string')
      if (nwcStr) {
        try {
          const { paid } = await lookupInvoice(nwcStr, rental.invoice_hash)
          if (paid) {
            const verifiedAt = new Date().toISOString()
            db.prepare(
              "UPDATE rentals SET status = 'active', payment_verified_at = ?, updated_at = datetime('now') WHERE id = ?"
            ).run(verifiedAt, rental.id)
            rental.status = 'active'
            rental.payment_verified_at = verifiedAt

            // Fire-and-forget: push new pool config to the Bitaxe
            const meta = safeJson(rental.metadata)
            configureBitaxe(rental.ip_address, rental.port, {
              pool_url:    stripStratumPrefix(meta.pool_url || ''),
              pool_port:   meta.pool_port || 3333,
              stratum_user: meta.stratum_user || meta.payout_address,
            }).then((ok) => {
              if (!ok) console.warn(`[rentals] configureBitaxe failed for rental ${rental.id}`)
            }).catch((e) => console.error('[rentals] configureBitaxe error:', e.message))
          }
        } catch (e) {
          // NWC error is non-fatal — return current status
          console.warn('[rentals/status] lookupInvoice error:', e.message)
        }
      }
    }

    const now       = Date.now()
    const endMs     = new Date(rental.end_time).getTime()
    const meta      = safeJson(rental.metadata)
    const minerMeta = safeJson(rental.miner_meta)

    return res.json({
      id:               rental.id,
      status:           rental.status,
      miner: {
        name:          rental.miner_name,
        hashrate_ths:  rental.hashrate_specs,
        last_hashrate: minerMeta.last_hashrate ?? null,
        last_temp_c:   minerMeta.last_temp     ?? null,
        last_power_w:  minerMeta.last_power    ?? null,
      },
      duration_minutes:    rental.duration_minutes,
      start_time:          rental.start_time,
      end_time:            rental.end_time,
      remaining_minutes:   Math.max(0, Math.floor((endMs - now) / 60000)),
      total_sats:          rental.total_sats,
      payment_verified_at: rental.payment_verified_at ?? null,
      // Only expose pool config once payment is confirmed
      mining_config: rental.status === 'active' ? {
        pool_url:       meta.pool_url,
        payout_address: meta.payout_address,
        stratum_user:   meta.stratum_user,
      } : null,
    })
  } catch (err) {
    console.error('[rentals/status] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /my ───────────────────────────────────────────────────────────────────
router.get('/my', requireAuth, (req, res) => {
  try {
    const db      = getDb()
    const rentals = db.prepare(`
      SELECT r.*,
             m.name         AS miner_name,
             m.hashrate_specs
      FROM   rentals r
      JOIN   miners  m ON m.id = r.miner_id
      WHERE  r.user_id = ?
      ORDER  BY r.created_at DESC
    `).all(req.userId)

    const now    = Date.now()
    const result = rentals.map((r) => {
      const meta    = safeJson(r.metadata)
      const endMs   = new Date(r.end_time).getTime()
      return {
        id:                r.id,
        status:            r.status,
        miner_name:        r.miner_name,
        hashrate_ths:      r.hashrate_specs,
        duration_minutes:  r.duration_minutes,
        total_sats:        r.total_sats,
        start_time:        r.start_time,
        end_time:          r.end_time,
        remaining_minutes: r.status === 'active' ? Math.max(0, Math.floor((endMs - now) / 60000)) : 0,
        pool_url:          meta.pool_url   || null,
        payout_address:    meta.payout_address || null,
        created_at:        r.created_at,
      }
    })

    return res.json({ rentals: result })
  } catch (err) {
    console.error('[rentals/my] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeJson(str) {
  try { return JSON.parse(str || '{}') } catch { return {} }
}

function stripStratumPrefix(url) {
  return url.replace(/^stratum\+tcp:\/\//, '')
}

export default router

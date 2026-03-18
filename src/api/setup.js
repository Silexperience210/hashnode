/**
 * Setup API — first-run wizard, blocked after setup is complete
 *
 * GET  /api/setup/status    — current setup state
 * POST /api/setup/init      — store NWC + owner pubkey, generate node identity
 * POST /api/setup/scan      — scan LAN for Bitaxe miners
 * POST /api/setup/add-miner — add a discovered (or manual) miner
 * POST /api/setup/complete  — mark setup as done
 */
import { Router } from 'express'
import crypto from 'crypto'
import { networkInterfaces } from 'os'
import { getDb, setConfig, getConfig, isSetupComplete } from '../lib/db.js'
import { validateNWC, makeInvoice } from '../lib/nwc.js'
import { scanForBitaxe, getBitaxeStats } from '../lib/bitaxe-scanner.js'
import { getNodeKeypair, getNodePubkey } from '../lib/nostr-identity.js'
import { isValidPubkey } from '../lib/nostr-auth.js'

const router = Router()

// ── Guard: block all setup routes once setup is complete ──────────────────────
router.use((req, res, next) => {
  // Allow /status through always so the frontend can check
  if (req.path === '/status') return next()
  if (isSetupComplete()) {
    return res.redirect('/')
  }
  next()
})

// ── GET /status ───────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const complete  = isSetupComplete()
  const hasNwc    = !!getConfig('nwc_connection_string')
  const hasOwner  = !!getConfig('owner_pubkey')

  let step = 'nwc'
  if (hasNwc && !hasOwner) step = 'identity'
  else if (hasNwc && hasOwner) step = 'done'

  return res.json({
    complete,
    step,
    node_pubkey:  getNodePubkey(),
    node_name:    getConfig('node_name') || '',
    public_url:   getConfig('cloudflare_url') || '',
    has_nwc:      hasNwc,
    has_owner:    hasOwner,
  })
})

// ── POST /init ────────────────────────────────────────────────────────────────
router.post('/init', async (req, res) => {
  try {
    const { nwc_string, owner_pubkey, node_name, public_url } = req.body || {}

    if (!nwc_string) return res.status(400).json({ error: 'nwc_string is required' })
    if (!owner_pubkey) return res.status(400).json({ error: 'owner_pubkey is required' })

    if (!validateNWC(nwc_string)) {
      return res.status(400).json({ error: 'Invalid NWC connection string format' })
    }
    if (!isValidPubkey(owner_pubkey)) {
      return res.status(400).json({ error: 'Invalid owner_pubkey — must be 64 lowercase hex chars' })
    }

    // Validate NWC is live: try to create a 1-sat invoice as a connectivity test
    try {
      await makeInvoice(nwc_string, 1, 'HashNode setup test — you may ignore this')
    } catch (e) {
      return res.status(422).json({ error: 'NWC connection test failed: ' + e.message })
    }

    // Persist config
    setConfig('nwc_connection_string', nwc_string.trim())
    setConfig('owner_pubkey', owner_pubkey.trim())
    if (node_name)  setConfig('node_name', node_name.trim())
    if (public_url) setConfig('cloudflare_url', public_url.trim())

    // Generate a stable JWT secret (stored in DB so it survives restarts)
    if (!getConfig('jwt_secret')) {
      setConfig('jwt_secret', crypto.randomBytes(48).toString('hex'))
    }

    // Ensure node Nostr identity exists (getNodeKeypair auto-creates on first call)
    const { pubkey } = getNodeKeypair()

    // Grant admin to owner
    const db = getDb()
    db.prepare(
      `INSERT INTO users (pubkey_nostr, is_admin)
       VALUES (?, 1)
       ON CONFLICT(pubkey_nostr) DO UPDATE SET is_admin = 1`
    ).run(owner_pubkey.trim())

    return res.json({
      ok:          true,
      node_pubkey: pubkey,
    })
  } catch (err) {
    console.error('[setup/init] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /scan ────────────────────────────────────────────────────────────────
router.post('/scan', async (req, res) => {
  try {
    const subnet  = detectSubnet()
    const miners  = await scanForBitaxe(subnet)
    return res.json({ subnet, miners })
  } catch (err) {
    console.error('[setup/scan] error:', err)
    return res.status(500).json({ error: 'Scan failed: ' + err.message })
  }
})

// ── POST /add-miner ───────────────────────────────────────────────────────────
router.post('/add-miner', async (req, res) => {
  try {
    const { ip, name, sats_per_minute } = req.body || {}

    if (!ip)             return res.status(400).json({ error: 'ip is required' })
    if (!name)           return res.status(400).json({ error: 'name is required' })
    if (!sats_per_minute) return res.status(400).json({ error: 'sats_per_minute is required' })

    const spm = parseInt(sats_per_minute, 10)
    if (!Number.isFinite(spm) || spm < 1) {
      return res.status(400).json({ error: 'sats_per_minute must be a positive integer' })
    }

    // Fetch live stats from the device to confirm it's reachable + get hashrate spec
    const stats = await getBitaxeStats(ip)
    if (!stats) {
      return res.status(422).json({ error: `Could not reach Bitaxe at ${ip} — check IP and ensure it is on the same network` })
    }

    const hashrateSpec = stats.hashrate || 0.6  // TH/s

    // Build metadata from live info
    const meta = JSON.stringify({
      model:        'Bitaxe',
      last_hashrate: stats.hashrate,
      last_temp:    stats.temp,
      last_power:   stats.power,
    })

    const db = getDb()
    const info = db.prepare(
      'INSERT INTO miners (name, ip_address, port, hashrate_specs, sats_per_minute, metadata) VALUES (?,?,?,?,?,?)'
    ).run(name.trim(), ip.trim(), 80, hashrateSpec, spm, meta)

    const miner = db.prepare('SELECT id FROM miners WHERE rowid = ?').get(info.lastInsertRowid)

    return res.status(201).json({ ok: true, miner_id: miner.id, hashrate_ths: hashrateSpec })
  } catch (err) {
    console.error('[setup/add-miner] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /complete ────────────────────────────────────────────────────────────
router.post('/complete', (req, res) => {
  try {
    // Require at least NWC + owner pubkey before marking done
    if (!getConfig('nwc_connection_string')) {
      return res.status(422).json({ error: 'NWC not configured — run /init first' })
    }
    if (!getConfig('owner_pubkey')) {
      return res.status(422).json({ error: 'Owner pubkey not set — run /init first' })
    }

    setConfig('setup_complete', '1')
    return res.json({ success: true })
  } catch (err) {
    console.error('[setup/complete] error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectSubnet() {
  const nets = networkInterfaces()
  for (const ifaces of Object.values(nets)) {
    for (const addr of ifaces) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.')
        return `${parts[0]}.${parts[1]}.${parts[2]}`
      }
    }
  }
  return '192.168.1'  // fallback
}

export default router

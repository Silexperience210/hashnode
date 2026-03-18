import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { getDb, isSetupComplete, getConfig } from './src/lib/db.js'
import { startMdnsAdvertise, startMdnsBrowse } from './src/lib/mdns.js'
import { subscribeToNodeAnnouncements, publishNodeAnnouncement } from './src/lib/nostr-p2p.js'

import authRouter from './src/api/auth.js'
import minersRouter from './src/api/miners.js'
import rentalsRouter from './src/api/rentals.js'
import setupRouter from './src/api/setup.js'
import adminRouter from './src/api/admin.js'
import peersRouter from './src/api/peers.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors())
app.use(express.json())
app.use(express.static(join(__dir, 'public')))

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter)
app.use('/api/miners', minersRouter)
app.use('/api/rentals', rentalsRouter)
app.use('/api/setup', setupRouter)
app.use('/api/admin', adminRouter)
app.use('/api/peers', peersRouter)

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }))

// ── Root: redirect to setup if not configured ─────────────────────────────────
app.get('/', (_req, res) => {
  if (!isSetupComplete()) return res.redirect('/setup.html')
  res.sendFile(join(__dir, 'public/index.html'))
})

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[server] unhandled error:', err)
  const status = err.status || err.statusCode || 500
  const message = err.expose ? err.message : 'Internal server error'
  res.status(status).json({ error: message })
})

// ── Startup services ──────────────────────────────────────────────────────────
async function startServices() {
  const { getNodePubkey } = await import('./src/lib/nostr-identity.js')
  const pubkey = getNodePubkey()
  const nodeName = getConfig('node_name') || 'HashNode'

  // mDNS: advertise on LAN and listen for other HashNode peers
  startMdnsAdvertise(PORT, { name: nodeName, pubkey })
  startMdnsBrowse((peer) => {
    try {
      const db = getDb()
      db.prepare(
        'INSERT OR REPLACE INTO peers (id, name, endpoint, last_seen, source) VALUES (?,?,?,?,?)'
      ).run(peer.pubkey, peer.name || 'HashNode', peer.endpoint, peer.last_seen, 'mdns')
    } catch (e) {
      console.warn('[server] mDNS peer upsert failed:', e.message)
    }
  })

  // Nostr P2P: subscribe to remote node announcements
  subscribeToNodeAnnouncements((peer) => {
    try {
      const db = getDb()
      db.prepare(
        'INSERT OR REPLACE INTO peers (id, name, endpoint, last_seen, miners_json, source) VALUES (?,?,?,?,?,?)'
      ).run(
        peer.pubkey,
        peer.name || 'HashNode',
        peer.endpoint,
        peer.last_seen,
        JSON.stringify(peer.miners || []),
        'nostr'
      )
    } catch (e) {
      console.warn('[server] Nostr peer upsert failed:', e.message)
    }
  })

  // Periodically announce this node on Nostr (only when setup is complete)
  const announceNode = async () => {
    if (!isSetupComplete()) return
    try {
      const db = getDb()
      const miners = db.prepare("SELECT * FROM miners WHERE status != 'offline'").all()
      await publishNodeAnnouncement(miners)
    } catch (e) {
      console.warn('[server] announce failed:', e.message)
    }
  }

  // First announce after 5 s (give app time to fully start), then every 30 min
  setTimeout(announceNode, 5000)
  setInterval(announceNode, 30 * 60 * 1000)
}

// ── Listen ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n⚡ HashNode running at http://localhost:${PORT}`)
  console.log(`   Local network: http://hashnode.local:${PORT}`)
  console.log(`   Setup complete: ${isSetupComplete()}\n`)
  startServices().catch((e) => console.error('[server] startServices error:', e))
})

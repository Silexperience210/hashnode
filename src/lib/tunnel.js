/**
 * tunnel.js — Cloudflare Quick Tunnel (no account needed)
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` as a child process,
 * captures the assigned trycloudflare.com URL from its output, persists it in
 * the DB, and restarts automatically on exit.
 *
 * The URL is written to config key 'cloudflare_url' and picked up by:
 *   - /api/setup/status  → displayed in the setup wizard
 *   - nostr-p2p.js       → broadcast to the P2P network
 */
import { spawn } from 'child_process'
import { setConfig, getConfig } from './db.js'

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

let proc = null
let restartTimer = null
let currentUrl = null

/** Called whenever cloudflared emits a line of text. */
function handleOutput(raw) {
  const text = raw.toString()
  const match = text.match(URL_RE)
  if (match && match[0] !== currentUrl) {
    currentUrl = match[0]
    setConfig('cloudflare_url', currentUrl)
    console.log(`\n⚡ [tunnel] Public URL ready: ${currentUrl}\n`)
  }
}

export function startTunnel(port = 3000) {
  // Clear any stale URL from a previous run
  setConfig('cloudflare_url', '')
  currentUrl = null

  try {
    proc = spawn('cloudflared', [
      'tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    proc.stdout.on('data', handleOutput)
    proc.stderr.on('data', handleOutput) // cloudflared logs to stderr

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.log('[tunnel] cloudflared not found — internet access unavailable. Install it with: install.sh')
      } else {
        console.warn('[tunnel] spawn error:', err.message)
      }
    })

    proc.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') return // intentional shutdown
      console.log(`[tunnel] exited (code=${code}) — restarting in 15s`)
      setConfig('cloudflare_url', '')
      currentUrl = null
      restartTimer = setTimeout(() => startTunnel(port), 15000)
    })

    console.log('[tunnel] cloudflared started — waiting for public URL…')
  } catch (err) {
    console.warn('[tunnel] failed to start:', err.message)
  }
}

export function stopTunnel() {
  if (restartTimer) clearTimeout(restartTimer)
  if (proc) { proc.kill('SIGTERM'); proc = null }
}

export function getTunnelUrl() {
  return currentUrl || getConfig('cloudflare_url') || null
}

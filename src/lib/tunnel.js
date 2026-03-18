/**
 * tunnel.js — Cloudflare Tunnel manager
 *
 * Two modes:
 *  1. Named tunnel (PREFERRED for plug & play):
 *     cloudflared tunnel run --token <token>
 *     → permanent subdomain like xxxx.cfargotunnel.com
 *     → URL never changes even after reboot
 *     → token obtained once via Cloudflare dashboard (free account)
 *
 *  2. Quick tunnel (fallback, no account needed):
 *     cloudflared tunnel --url http://localhost:<port>
 *     → random trycloudflare.com URL, changes every restart
 *
 * The active URL is written to config key 'cloudflare_url' and used by:
 *   - /api/setup/status  → displayed in setup wizard
 *   - nostr-p2p.js       → broadcast on Nostr P2P network
 */
import { spawn } from 'child_process'
import { setConfig, getConfig } from './db.js'

const NAMED_URL_RE = /https:\/\/[a-z0-9-]+\.cfargotunnel\.com/
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const ANY_URL_RE   = /https:\/\/[a-z0-9.-]+\.(trycloudflare|cfargotunnel)\.com/

let proc = null
let restartTimer = null
let currentUrl = null
let currentPort = 3000

function handleOutput(raw) {
  const text = raw.toString()
  const match = text.match(ANY_URL_RE)
  if (match && match[0] !== currentUrl) {
    currentUrl = match[0]
    setConfig('cloudflare_url', currentUrl)
    console.log(`\n⚡ [tunnel] Public URL: ${currentUrl}\n`)
  }
}

function spawnTunnel(args) {
  try {
    proc = spawn('cloudflared', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    proc.stdout.on('data', handleOutput)
    proc.stderr.on('data', handleOutput)
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.log('[tunnel] cloudflared not found — skipping internet access')
      } else {
        console.warn('[tunnel] error:', err.message)
      }
    })
    proc.on('exit', (code, signal) => {
      if (signal === 'SIGTERM') return
      console.log(`[tunnel] exited (code=${code}) — restarting in 15s`)
      setConfig('cloudflare_url', '')
      currentUrl = null
      restartTimer = setTimeout(() => startTunnel(currentPort), 15000)
    })
  } catch (err) {
    console.warn('[tunnel] spawn failed:', err.message)
  }
}

export function startTunnel(port = 3000) {
  currentPort = port
  setConfig('cloudflare_url', '')
  currentUrl = null

  const token = getConfig('cloudflare_token')
  if (token) {
    // Mode 1: Named tunnel with token — permanent URL
    console.log('[tunnel] starting named tunnel (permanent URL)…')
    spawnTunnel(['tunnel', 'run', '--token', token, '--no-autoupdate'])
  } else {
    // Mode 2: Quick tunnel — random URL, no account needed
    console.log('[tunnel] starting quick tunnel (URL changes on restart)…')
    spawnTunnel(['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'])
  }
}

export function stopTunnel() {
  if (restartTimer) clearTimeout(restartTimer)
  if (proc) { proc.kill('SIGTERM'); proc = null }
}

export function getTunnelUrl() {
  return currentUrl || getConfig('cloudflare_url') || null
}

export function hasPermanentTunnel() {
  return !!getConfig('cloudflare_token')
}

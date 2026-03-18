/**
 * mDNS — Broadcast and discover HashNode peers on local network
 * Service: _hashnode._tcp.local
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let mdns
try { mdns = require('mdns-js') } catch { mdns = null }

const SERVICE_TYPE = '_hashnode._tcp'
let browser = null
const localPeers = new Map()

export function startMdnsAdvertise(port, nodeInfo) {
  if (!mdns) { console.warn('[mdns] mdns-js not available, skipping'); return }
  try {
    const advertiser = mdns.createAdvertisement(mdns.tcp('hashnode'), port, {
      name: nodeInfo.name || 'HashNode',
      txt: { pubkey: nodeInfo.pubkey, version: '0.1.0' },
    })
    advertiser.start()
    console.log('[mdns] Advertising on local network')
  } catch (e) { console.warn('[mdns] advertise error:', e.message) }
}

export function startMdnsBrowse(onPeerFound) {
  if (!mdns) return
  try {
    browser = mdns.createBrowser(mdns.tcp('hashnode'))
    browser.on('ready', () => browser.discover())
    browser.on('update', (data) => {
      const ip = data.addresses?.[0]
      const port = data.port
      const pubkey = data.txt?.pubkey
      if (!ip || !port || !pubkey) return
      const peer = { pubkey, endpoint: `http://${ip}:${port}`, source: 'mdns', last_seen: new Date().toISOString() }
      localPeers.set(pubkey, peer)
      if (onPeerFound) onPeerFound(peer)
    })
    console.log('[mdns] Browsing for local peers')
  } catch (e) { console.warn('[mdns] browse error:', e.message) }
}

export function getLocalPeers() { return Array.from(localPeers.values()) }

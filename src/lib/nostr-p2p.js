/**
 * Nostr P2P — Global peer discovery via Nostr relays
 * Kind 38383: HashNode announcement event
 */
import { WebSocket } from 'ws'
import { signAsNode, getNodePubkey } from './nostr-identity.js'
import { getConfig } from './db.js'

const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
]

const KIND_HASHNODE = 38383

export async function publishNodeAnnouncement(miners) {
  const pubkey = getNodePubkey()
  const endpoint = getConfig('cloudflare_url') || getConfig('local_url') || ''
  const nodeName = getConfig('node_name') || 'HashNode'

  if (!endpoint) { console.warn('[p2p] No endpoint set, skipping announcement'); return }

  const event = signAsNode({
    kind: KIND_HASHNODE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', pubkey],
      ['n', nodeName],
      ['u', endpoint],
      ['v', '0.1.0'],
    ],
    content: JSON.stringify({
      name: nodeName,
      endpoint,
      pubkey,
      miners: miners.map(m => ({
        id: m.id, name: m.name,
        hashrate: m.hashrate_specs,
        sats_per_minute: m.sats_per_minute,
        status: m.status,
      })),
      ts: Date.now(),
    }),
  })

  let published = 0
  for (const relay of RELAYS) {
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(relay)
        const t = setTimeout(() => { ws.terminate(); resolve() }, 5000)
        ws.on('open', () => ws.send(JSON.stringify(['EVENT', event])))
        ws.on('message', (d) => {
          try {
            const msg = JSON.parse(d.toString())
            if (msg[0] === 'OK') { clearTimeout(t); ws.terminate(); published++; resolve() }
          } catch {}
        })
        ws.on('error', () => { clearTimeout(t); resolve() })
      })
    } catch {}
  }
  console.log(`[p2p] Announced to ${published}/${RELAYS.length} relays`)
}

export function subscribeToNodeAnnouncements(onPeer) {
  for (const relay of RELAYS) {
    try {
      const ws = new WebSocket(relay)
      ws.on('open', () => {
        ws.send(JSON.stringify(['REQ', 'hashnode-peers', {
          kinds: [KIND_HASHNODE],
          since: Math.floor(Date.now() / 1000) - 3600,
          limit: 100,
        }]))
      })
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (msg[0] !== 'EVENT') return
          const event = msg[2]
          const content = JSON.parse(event.content)
          if (content.pubkey && content.endpoint) {
            onPeer({ ...content, source: 'nostr', last_seen: new Date().toISOString() })
          }
        } catch {}
      })
      ws.on('error', () => {})
    } catch {}
  }
}

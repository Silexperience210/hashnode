/**
 * NWC — Nostr Wallet Connect (NIP-47)
 * Connects to user's own Lightning node (Umbrel, Start9, etc.)
 * Connection string format: nostr+walletconnect://<pubkey>?relay=<url>&secret=<hex>
 */
import { nip04, finalizeEvent } from 'nostr-tools'
import WebSocket from 'ws'

function parseNWC(connStr) {
  try {
    const url = new URL(connStr.replace('nostr+walletconnect://', 'https://'))
    return {
      walletPubkey: url.hostname,
      relay: url.searchParams.get('relay'),
      secret: url.searchParams.get('secret'),
    }
  } catch {
    throw new Error('Invalid NWC connection string')
  }
}

async function nwcRequest(connStr, method, params = {}) {
  const { walletPubkey, relay, secret } = parseNWC(connStr)
  const secretBytes = Buffer.from(secret, 'hex')

  const reqEvent = finalizeEvent({
    kind: 23194,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', walletPubkey]],
    content: await nip04.encrypt(secretBytes, walletPubkey, JSON.stringify({ method, params })),
  }, secretBytes)

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relay)
    const timer = setTimeout(() => {
      ws.removeAllListeners(); ws.terminate()
      reject(new Error('NWC timeout after 30s'))
    }, 30000)

    ws.on('error', (err) => {
      clearTimeout(timer); ws.removeAllListeners(); ws.terminate()
      reject(new Error('NWC connection error: ' + err.message))
    })

    ws.on('open', () => {
      ws.send(JSON.stringify(['REQ', 'sub1', { kinds: [23195], '#e': [reqEvent.id], limit: 1 }]))
      ws.send(JSON.stringify(['EVENT', reqEvent]))
    })

    ws.on('message', async (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch (err) { console.warn('[nwc] parse error:', err?.message); return }
      if (!Array.isArray(msg) || msg[0] !== 'EVENT') return
      try {
        const decrypted = await nip04.decrypt(secretBytes, walletPubkey, msg[2].content)
        const resp = JSON.parse(decrypted)
        clearTimeout(timer); ws.removeAllListeners(); ws.terminate()
        if (resp.error) return reject(new Error(resp.error.message || 'NWC error'))
        resolve(resp.result)
      } catch (err) { console.warn('[nwc] decrypt error:', err?.message) }
    })
  })
}

export async function makeInvoice(connStr, amountSats, memo = 'HashNode rental') {
  const result = await nwcRequest(connStr, 'make_invoice', {
    amount: amountSats * 1000,
    description: memo,
    expiry: 600,
  })
  return { invoice: result.invoice, payment_hash: result.payment_hash }
}

export async function lookupInvoice(connStr, paymentHash) {
  const result = await nwcRequest(connStr, 'lookup_invoice', { payment_hash: paymentHash })
  return {
    paid: result.settled_at != null,
    settled_at: result.settled_at,
  }
}

export function validateNWC(connStr) {
  try { parseNWC(connStr); return true } catch { return false }
}

import { verifyEvent } from 'nostr-tools'

export function isValidPubkey(pubkey) {
  return typeof pubkey === 'string' && /^[0-9a-f]{64}$/.test(pubkey)
}

export function verifyAuthEvent(event, challenge) {
  if (!event || event.kind !== 27235) return false
  if (Math.abs(Date.now() / 1000 - event.created_at) > 300) return false
  if (event.content !== challenge) return false
  try { return verifyEvent(event) } catch { return false }
}

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools'
import { getConfig, setConfig } from './db.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

export function getNodeKeypair() {
  let privkeyHex = getConfig('node_privkey')
  if (!privkeyHex) {
    const privkey = generateSecretKey()
    privkeyHex = bytesToHex(privkey)
    setConfig('node_privkey', privkeyHex)
    setConfig('node_pubkey', getPublicKey(privkey))
  }
  return {
    privkey: hexToBytes(privkeyHex),
    pubkey: getConfig('node_pubkey'),
  }
}

export function getNodePubkey() {
  return getNodeKeypair().pubkey
}

// Sign a Nostr event as this node
export function signAsNode(eventTemplate) {
  const { privkey } = getNodeKeypair()
  return finalizeEvent(eventTemplate, privkey)
}

import fetch from 'node-fetch'

// Scan a subnet for Bitaxe miners
// subnet: e.g. '192.168.1' (will scan .1 to .254)
export async function scanForBitaxe(subnet, timeout = 1500) {
  const found = []
  const promises = []

  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`
    promises.push(
      fetch(`http://${ip}/api/system/info`, {
        signal: AbortSignal.timeout(timeout),
      })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data && data.ASICModel) {
            found.push({
              ip,
              name: data.hostname || `Bitaxe ${data.ASICModel}`,
              model: data.ASICModel,
              hashrate_ths: data.hashRate ? data.hashRate / 1000 : 0.6,
              temp: data.temp,
              power: data.power,
              firmware: data.version,
            })
          }
        })
        .catch(() => null)
    )
  }

  await Promise.allSettled(promises)
  return found
}

// Get stats from a specific Bitaxe
export async function getBitaxeStats(ip, port = 80) {
  try {
    const r = await fetch(`http://${ip}:${port}/api/system/info`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!r.ok) return null
    const d = await r.json()
    return {
      hashrate: d.hashRate ? d.hashRate / 1000 : null,  // TH/s
      temp: d.temp || null,
      power: d.power || null,
      uptime: d.uptimeSeconds || null,
      shares_accepted: d.sharesAccepted || null,
    }
  } catch { return null }
}

// Configure a Bitaxe to mine on a specific pool
export async function configureBitaxe(ip, port = 80, config) {
  try {
    const r = await fetch(`http://${ip}:${port}/api/system`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stratumURL: config.pool_url,
        stratumPort: config.pool_port || 3333,
        stratumUser: config.stratum_user,
        stratumPassword: 'x',
      }),
      signal: AbortSignal.timeout(5000),
    })
    return r.ok
  } catch { return false }
}

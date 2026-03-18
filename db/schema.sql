-- HashNode SQLite Schema
-- Runs locally on the Pi, no cloud required

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Nostr keypair + node identity
-- Keys: node_privkey, node_pubkey, node_name, nwc_connection_string,
--       setup_complete, cloudflare_url, local_url

CREATE TABLE IF NOT EXISTS miners (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  port INTEGER DEFAULT 80,
  hashrate_specs REAL NOT NULL,
  sats_per_minute INTEGER NOT NULL,
  status TEXT DEFAULT 'online' CHECK(status IN ('online','offline','maintenance')),
  metadata TEXT DEFAULT '{}',  -- JSON: model, last_hashrate, last_temp, last_power
  uptime_pct REAL DEFAULT 100,
  total_revenue_sats INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pubkey_nostr TEXT UNIQUE NOT NULL,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  challenge TEXT UNIQUE NOT NULL,
  pubkey_nostr TEXT NOT NULL,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rentals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  miner_id TEXT NOT NULL REFERENCES miners(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','completed','cancelled','expired')),
  duration_minutes INTEGER NOT NULL,
  sats_per_minute INTEGER NOT NULL,
  total_sats INTEGER NOT NULL,
  invoice_hash TEXT,
  invoice_bolt11 TEXT,
  invoice_expires_at TEXT,
  start_time TEXT,
  end_time TEXT,
  payment_verified_at TEXT,
  metadata TEXT DEFAULT '{}',  -- JSON: pool_name, pool_url, payout_address
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Prevent double-booking at DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_per_miner
  ON rentals(miner_id) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_per_miner
  ON rentals(miner_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS peers (
  id TEXT PRIMARY KEY,  -- Nostr pubkey of the peer node
  name TEXT,
  endpoint TEXT,        -- https://xxx.trycloudflare.com or .onion
  last_seen TEXT,
  miners_json TEXT DEFAULT '[]',  -- JSON snapshot of their miners
  source TEXT DEFAULT 'nostr' CHECK(source IN ('mdns','nostr'))
);

CREATE INDEX IF NOT EXISTS idx_rentals_user ON rentals(user_id);
CREATE INDEX IF NOT EXISTS idx_rentals_miner ON rentals(miner_id);
CREATE INDEX IF NOT EXISTS idx_challenges_pubkey ON challenges(pubkey_nostr);

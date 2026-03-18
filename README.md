# ⛏ HashNode

Self-hosted Bitcoin miner rental platform for Raspberry Pi.

## What is HashNode?

HashNode lets you run your own Bitcoin miner rental marketplace directly on a Raspberry Pi. Plug in your Bitaxe miners, connect your Lightning node via NWC, and start renting hashrate to anyone on your local network — or to peers across the globe via Nostr. All payments are Lightning-native, all auth is Nostr-based, and all data stays on your hardware.

## Features

- **Auto-detection** of Bitaxe miners on the local network via mDNS
- **NWC Lightning payments** — compatible with Umbrel, Start9, and Alby Hub
- **Nostr NIP-07 authentication** — no accounts, no passwords
- **mDNS peer discovery** — accessible at `hashnode.local` out of the box
- **P2P network** via Nostr kind 38383 — connect with other HashNode operators
- **Setup wizard** — guided first-run configuration from the browser
- **Admin dashboard** — manage miners, view rentals, monitor earnings

## Requirements

- Raspberry Pi 4 or 5 (2 GB+ RAM recommended)
- Node.js 20+
- A Lightning node with NWC support (Umbrel, Start9, or Alby Hub)
- One or more Bitaxe miners on the same local network
- A Nostr browser extension (Alby, nos2x) for user authentication

## Quick Install (Raspberry Pi)

```bash
curl -fsSL https://raw.githubusercontent.com/Silexperience210/hashnode/main/install.sh | bash
```

Then open [http://hashnode.local:3000](http://hashnode.local:3000) to run the setup wizard.

## Manual Install

```bash
git clone https://github.com/Silexperience210/hashnode /opt/hashnode
cd /opt/hashnode
npm install --production
cp .env.example .env
nano .env          # set NWC_STRING, JWT_SECRET, etc.
node server.js
```

## Configuration (.env)

| Variable | Description |
|---|---|
| `PORT` | HTTP port (default: `3000`) |
| `JWT_SECRET` | Random secret for session tokens |
| `NWC_STRING` | Nostr Wallet Connect URI from your Lightning node (Umbrel / Start9 → NWC settings) |
| `NOSTR_RELAY` | WebSocket URL of your preferred Nostr relay (e.g. `wss://relay.damus.io`) |

## Architecture

```
Browser (Nostr NIP-07 auth)
        │
        ▼
  Express HTTP API
        │
   ┌────┴────┐
   │  SQLite  │  ← local data store (/opt/hashnode/data)
   └────┬────┘
        │
   ┌────┴──────────────────────┐
   │  NWC client (Lightning)   │  ← pays invoices via your node
   └───────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │  Nostr P2P (kind 38383)   │  ← peer discovery & announcements
   └───────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │  mDNS (avahi-daemon)      │  ← hashnode.local on LAN
   └───────────────────────────┘
        │
   ┌────┴──────────────────────┐
   │  Bitaxe scanner           │  ← auto-detects miners on network
   └───────────────────────────┘
```

## API

| Endpoint | Description |
|---|---|
| `POST /api/auth/challenge` | Generate Nostr auth challenge |
| `POST /api/auth/verify` | Verify signed challenge, return JWT |
| `GET  /api/miners` | List detected Bitaxe miners |
| `GET  /api/rentals` | List active and past rentals |
| `POST /api/rentals` | Start a rental session |
| `GET  /api/setup/*` | Setup wizard steps |
| `GET  /api/admin/*` | Admin dashboard data |
| `GET  /api/peers` | List known P2P peers |

## BitRent vs HashNode

| Feature | BitRent | HashNode |
|---|---|---|
| Hosting | Vercel (cloud) | Raspberry Pi (self-hosted) |
| Database | Supabase (cloud) | SQLite (local) |
| Discovery | Single marketplace | P2P network |
| Privacy | Centralized | Self-sovereign |
| Payments | Lightning via hosted NWC | Lightning via your own node |
| Auth | Nostr NIP-07 | Nostr NIP-07 |
| Cost | Dependent on cloud provider | Runs on ~$5/month electricity |

## License

MIT

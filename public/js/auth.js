/**
 * auth.js — HashNode Nostr NIP-07 authentication
 * Requires window.nostr (Alby / nos2x / any NIP-07 extension)
 */
window.Auth = (() => {
  const CONFIG = {
    TOKEN_KEY: 'hn_token',
    USER_KEY:  'hn_user',
  }

  const Auth = {
    getToken() { return localStorage.getItem(CONFIG.TOKEN_KEY) },

    getUser() {
      try { return JSON.parse(localStorage.getItem(CONFIG.USER_KEY)) }
      catch { return null }
    },

    /** Check if JWT token is present and not expired */
    isLoggedIn() {
      const token = this.getToken()
      if (!token) return false
      try {
        // Decode JWT payload (base64url) — no crypto needed, just check exp
        const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        const payload = JSON.parse(atob(b64))
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
          this.clearSession()
          return false
        }
      } catch {
        return false
      }
      return true
    },

    isAdmin() { return this.getUser()?.is_admin === true },

    hasNostrExtension() { return !!window.nostr },

    setSession(token, user) {
      localStorage.setItem(CONFIG.TOKEN_KEY, token)
      localStorage.setItem(CONFIG.USER_KEY, JSON.stringify(user))
    },

    clearSession() {
      localStorage.removeItem(CONFIG.TOKEN_KEY)
      localStorage.removeItem(CONFIG.USER_KEY)
    },

    // ── LNURL-auth ─────────────────────────────────────────────────────────────

    /** Request a new LNAUTH challenge. Returns { k1, lnurl }. */
    async startLnauth() {
      return api.get('/api/auth/lnauth/start')
    },

    /**
     * Open an SSE stream and resolve when the Lightning wallet confirms login.
     * @param {string} k1  challenge from startLnauth()
     * @returns {Promise<user>}
     */
    waitLnauth(k1) {
      return new Promise((resolve, reject) => {
        const es = new EventSource(`/api/auth/lnauth/poll/${encodeURIComponent(k1)}`)
        const hard = setTimeout(() => {
          es.close()
          reject(new Error('LNAUTH timed out — please try again.'))
        }, 5 * 60 * 1000)

        es.onmessage = (e) => {
          clearTimeout(hard)
          es.close()
          try {
            const data = JSON.parse(e.data)
            if (data.error) return reject(new Error(data.error === 'timeout' ? 'Login timed out.' : data.error))
            this.setSession(data.token, data.user)
            resolve(data.user)
          } catch { reject(new Error('Unexpected server response.')) }
        }
        es.onerror = () => { clearTimeout(hard); es.close(); reject(new Error('Connection lost.')) }
      })
    },

    // ── NIP-07 login ───────────────────────────────────────────────────────────

    async login() {
      if (!window.nostr) {
        throw new Error(
          'Nostr extension not detected. If you just installed Alby, ' +
          'please refresh this page and try again.'
        )
      }

      let pubkey
      try {
        pubkey = await window.nostr.getPublicKey()
      } catch (e) {
        const detail = e?.message || e?.toString() || ''
        throw new Error(detail
          ? `Extension error: ${detail}`
          : 'Could not get public key. Check your extension settings.'
        )
      }

      if (!pubkey) {
        throw new Error('Extension returned no public key. Try connecting it to this site.')
      }
      if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
        throw new Error(`Invalid public key format: "${pubkey.slice(0, 20)}…"`)
      }
      pubkey = pubkey.toLowerCase()

      // Request challenge from backend
      const { challenge } = await api.post('/api/auth/challenge', { pubkey })

      // Build NIP-98 HTTP Auth event (kind 27235)
      const eventTemplate = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['u', window.location.origin + '/api/auth/verify'],
          ['method', 'POST'],
        ],
        content: challenge,
      }

      let signedEvent
      try {
        signedEvent = await window.nostr.signEvent(eventTemplate)
      } catch {
        throw new Error('Signing was rejected or cancelled.')
      }

      if (!signedEvent?.sig) throw new Error('Extension did not return a signature.')

      // Exchange signed event for JWT
      const { token, user } = await api.post('/api/auth/verify', { event: signedEvent })

      this.setSession(token, user)
      return user
    },

    logout() {
      this.clearSession()
      window.location.href = '/'
    },

    requireAuth() {
      if (!this.isLoggedIn()) {
        window.location.href = '/'
        return false
      }
      return true
    },

    requireAdmin() {
      if (!this.requireAuth()) return false
      if (!this.isAdmin()) {
        window.location.href = '/dashboard.html'
        return false
      }
      return true
    },
  }

  return Auth
})()

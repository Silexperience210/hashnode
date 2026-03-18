/**
 * api.js — HashNode API client
 * IIFE pattern, same-origin relative URLs, 15s timeout, auto-logout on 401
 */
window.api = (() => {
  const TOKEN_KEY = 'hn_token'
  const USER_KEY  = 'hn_user'

  async function request(method, path, body) {
    const url   = path // relative, same origin
    const token = localStorage.getItem(TOKEN_KEY)

    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)

    let res
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      if (err.name === 'AbortError') throw new Error('Request timed out. Check your connection.')
      throw new Error('Network error. Check your connection.')
    } finally {
      clearTimeout(timeout)
    }

    // Auto-logout on 401
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      if (window.location.pathname !== '/') window.location.href = '/'
      throw new Error('Session expired. Please log in again.')
    }

    let data
    try {
      data = await res.json()
    } catch {
      if (!res.ok) throw new Error(`Server error (${res.status})`)
      return {}
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || `Error ${res.status}`)
    }

    return data
  }

  return {
    get:  (path)       => request('GET',    path, null),
    post: (path, body) => request('POST',   path, body),
    patch:(path, body) => request('PATCH',  path, body),
    del:  (path)       => request('DELETE', path, null),
  }
})()

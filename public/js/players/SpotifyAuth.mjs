/**
 * Minimal Spotify Authorization Code + PKCE helper for browser apps.
 * Stores tokens in localStorage.
 */

const STORAGE_KEY = 'polaris.spotifyAuth';
const VERIFIER_KEY = 'polaris.spotifyPkceVerifier';
const STATE_KEY = 'polaris.spotifyAuthState';

function base64UrlEncode(bytes) {
  const bin = Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join('');
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function sha256Base64Url(text) {
  const enc = new TextEncoder();
  const data = enc.encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(digest);
}

function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 16).toString(16)).join('');
}

function nowMs() {
  return Date.now();
}

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function store(obj) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function clearStored() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export class SpotifyAuth {
  constructor({ clientId, redirectUri } = {}) {
    this.clientId = clientId || '';

    const defaultRedirectUri = (() => {
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      // If we're on /index.html (or any .html), use the directory instead.
      if (url.pathname.endsWith('.html')) {
        url.pathname = url.pathname.replace(/[^/]+$/, '');
      }
      // Ensure trailing slash.
      if (!url.pathname.endsWith('/')) {
        url.pathname += '/';
      }
      return url.toString();
    })();

    this.redirectUri = redirectUri || defaultRedirectUri;
    this.scopes = [
      'streaming',
      'user-read-playback-state',
      'user-modify-playback-state'
    ];
  }

  setClientId(clientId) {
    this.clientId = String(clientId || '').trim();
  }

  getClientId() {
    return String(this.clientId || '').trim();
  }

  logout() {
    clearStored();
  }

  getAccessTokenMaybe() {
    const obj = loadStored();
    if (!obj || typeof obj.access_token !== 'string') return '';
    return obj.access_token;
  }

  async getAccessToken() {
    const obj = loadStored();
    if (!obj) throw new Error('Not authenticated with Spotify.');

    const access = obj.access_token;
    const refresh = obj.refresh_token;
    const expiresAt = typeof obj.expires_at_ms === 'number' ? obj.expires_at_ms : 0;

    if (access && expiresAt && nowMs() + 30_000 < expiresAt) {
      return access;
    }

    if (!refresh) throw new Error('Spotify session expired (missing refresh token).');

    const clientId = this.getClientId();
    if (!clientId) throw new Error('Missing Spotify clientId.');

    const body = new URLSearchParams();
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', refresh);
    body.set('client_id', clientId);

    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Spotify token refresh failed (${resp.status}): ${t}`);
    }

    const json = await resp.json();
    const next = {
      ...obj,
      access_token: json.access_token,
      // Spotify may omit refresh_token on refresh
      refresh_token: json.refresh_token || refresh,
      expires_at_ms: nowMs() + (Number(json.expires_in) || 0) * 1000,
      token_type: json.token_type || obj.token_type,
      scope: json.scope || obj.scope,
    };
    store(next);
    return next.access_token;
  }

  async login() {
    const clientId = this.getClientId();
    if (!clientId) throw new Error('Missing Spotify clientId.');

    const verifier = randomString(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomString(16);

    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);

    const params = new URLSearchParams();
    params.set('response_type', 'code');
    params.set('client_id', clientId);
    params.set('redirect_uri', this.redirectUri);
    params.set('code_challenge_method', 'S256');
    params.set('code_challenge', challenge);
    params.set('state', state);
    params.set('scope', this.scopes.join(' '));

    // Redirect for auth.
    window.location.assign(`https://accounts.spotify.com/authorize?${params.toString()}`);
  }

  async handleRedirectCallback() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const error = url.searchParams.get('error') || '';

    if (!code && !error) return false;

    const expectedState = sessionStorage.getItem(STATE_KEY) || '';
    const verifier = sessionStorage.getItem(VERIFIER_KEY) || '';

    // Clean up URL regardless of outcome.
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    try {
      window.history.replaceState({}, document.title, url.toString());
    } catch {
      // ignore
    }

    if (error) {
      throw new Error(`Spotify auth error: ${error}`);
    }
    if (!expectedState || state !== expectedState) {
      throw new Error('Spotify auth state mismatch.');
    }
    if (!verifier) {
      throw new Error('Spotify auth verifier missing.');
    }

    const clientId = this.getClientId();
    if (!clientId) throw new Error('Missing Spotify clientId.');

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', this.redirectUri);
    body.set('client_id', clientId);
    body.set('code_verifier', verifier);

    const resp = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Spotify token exchange failed (${resp.status}): ${t}`);
    }

    const json = await resp.json();
    store({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at_ms: nowMs() + (Number(json.expires_in) || 0) * 1000,
      token_type: json.token_type,
      scope: json.scope,
      obtained_at_ms: nowMs(),
    });

    return true;
  }
}

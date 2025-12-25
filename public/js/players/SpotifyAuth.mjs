/**
 * Minimal Spotify Authorization Code + PKCE helper for browser apps.
 * Stores tokens in localStorage.
 */

const STORAGE_KEY = 'polaris.spotifyAuth';
const VERIFIER_KEY = 'polaris.spotifyPkceVerifier';
const STATE_KEY = 'polaris.spotifyAuthState';

const REQUIRED_SCOPES = [
  // Required for Spotify Web Playback SDK.
  'streaming',
  'user-read-email',
  'user-read-private',

  // Required for controlling playback via Web API.
  'user-read-playback-state',
  'user-modify-playback-state',
];

function hasRequiredScopes(scopeString) {
  const raw = String(scopeString || '').trim();
  if (!raw) return false;
  const set = new Set(raw.split(/\s+/g).filter(Boolean));
  for (const s of REQUIRED_SCOPES) {
    if (!set.has(s)) return false;
  }
  return true;
}

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
    this.scopes = REQUIRED_SCOPES.slice();
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
    if (!hasRequiredScopes(obj.scope)) return '';
    return obj.access_token;
  }

  async getAccessToken() {
    const obj = loadStored();
    if (!obj) throw new Error('Not authenticated with Spotify.');

    // If stored token doesn't include the scopes we currently require, force re-login.
    if (!hasRequiredScopes(obj.scope)) {
      clearStored();
      throw new Error('Spotify session missing required scopes; please log in again.');
    }

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

  async loginWithPopup({ redirectUri, popupName = 'spotify-auth', timeoutMs = 180_000 } = {}) {
    const clientId = this.getClientId();
    if (!clientId) throw new Error('Missing Spotify clientId.');

    const usedRedirectUri = String(redirectUri || this.redirectUri || '').trim();
    if (!usedRedirectUri) throw new Error('Missing Spotify redirectUri.');

    // Open the popup immediately (before any async work) so browsers treat it as user-initiated.
    const popup = window.open(
      'about:blank',
      popupName,
      'popup=yes,width=520,height=720,menubar=no,toolbar=no,location=yes,status=no,scrollbars=yes,resizable=yes'
    );
    if (!popup) throw new Error('Spotify login popup was blocked.');

    let authUrl = '';
    let expectedCallbackOrigin = '';
    try {
      const verifier = randomString(64);
      const challenge = await sha256Base64Url(verifier);
      const state = randomString(16);

      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);

      const params = new URLSearchParams();
      params.set('response_type', 'code');
      params.set('client_id', clientId);
      params.set('redirect_uri', usedRedirectUri);
      params.set('code_challenge_method', 'S256');
      params.set('code_challenge', challenge);
      params.set('state', state);
      params.set('scope', this.scopes.join(' '));

      authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;
      expectedCallbackOrigin = new URL(usedRedirectUri).origin;

      try {
        popup.location.href = authUrl;
        popup.focus();
      } catch {
        // ignore
      }
    } catch (e) {
      try { popup.close(); } catch { /* ignore */ }
      throw e;
    }

    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = nowMs();

      const cleanup = () => {
        window.removeEventListener('message', onMessage);
        clearInterval(pollTimer);
      };

      const settleOk = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onMessage = (event) => {
        try {
          if (!event || typeof event !== 'object') return;
          if (event.origin !== expectedCallbackOrigin) return;

          const data = event.data;
          if (!data || typeof data !== 'object') return;
          if (data.type !== 'spotify-auth-callback') return;

          const code = typeof data.code === 'string' ? data.code : '';
          const gotState = typeof data.state === 'string' ? data.state : '';
          const error = typeof data.error === 'string' ? data.error : '';

          settleOk({ code, state: gotState, error });
        } catch (e) {
          settleErr(e);
        }
      };

      window.addEventListener('message', onMessage);

      const pollTimer = setInterval(() => {
        if (settled) return;
        if (nowMs() - startedAt > timeoutMs) {
          try { popup.close(); } catch { /* ignore */ }
          settleErr(new Error('Spotify login timed out.'));
          return;
        }
        if (popup.closed) {
          settleErr(new Error('Spotify login window was closed.'));
        }
      }, 250);
    });

    if (result && result.error) {
      throw new Error(`Spotify auth error: ${result.error}`);
    }

    const expectedState = sessionStorage.getItem(STATE_KEY) || '';
    const storedVerifier = sessionStorage.getItem(VERIFIER_KEY) || '';

    if (!result || !result.code) throw new Error('Spotify auth callback missing code.');
    if (!expectedState || result.state !== expectedState) throw new Error('Spotify auth state mismatch.');
    if (!storedVerifier) throw new Error('Spotify auth verifier missing.');

    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', result.code);
    body.set('redirect_uri', usedRedirectUri);
    body.set('client_id', clientId);
    body.set('code_verifier', storedVerifier);

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

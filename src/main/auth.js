// Microsoft account sign-in: Microsoft -> Xbox Live -> XSTS -> Minecraft services.
// Tokens are stored encrypted with the OS keychain (Electron safeStorage).
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { BrowserWindow, safeStorage, session } = require('electron');
const config = require('./config');
const { fetchWithTimeout } = require('./net');

const REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';
const AUTHORIZE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
const TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const SCOPE = 'XboxLive.signin offline_access';

class AuthError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function postJson(url, body, headers = {}) {
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, ok: r.ok, json, text };
}

async function postForm(url, form) {
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new AuthError('ms', 'Microsoft sign-in failed: ' + (json.error_description || json.error || r.status));
  return json;
}

/** Opens a Microsoft sign-in window. Resolves with the auth code. */
function interactiveCode(parent) {
  if (!config.MS_CLIENT_ID) {
    throw new AuthError('no-client', 'Microsoft sign-in is not set up in this build yet (no Azure client id).');
  }
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const url = AUTHORIZE + '?' + new URLSearchParams({
    client_id: config.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT,
    scope: SCOPE,
    prompt: 'select_account',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const part = 'msa-' + Date.now(); // in-memory session: every sign-in starts clean
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520, height: 680, parent, modal: !!parent, title: 'Sign in with Microsoft',
      autoHideMenuBar: true, backgroundColor: '#ffffff',
      webPreferences: { partition: part, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    let finished = false;
    const check = (event, target) => {
      if (!target.startsWith(REDIRECT)) return;
      if (event) event.preventDefault();
      const q = new URL(target).searchParams;
      finished = true;
      win.close();
      if (q.get('state') !== state) return reject(new AuthError('state', 'Sign-in was interrupted. Please try again.'));
      if (q.get('error')) return reject(new AuthError('ms', q.get('error_description') || q.get('error')));
      resolve({ code: q.get('code'), verifier });
    };
    win.webContents.on('will-redirect', (e, u) => check(e, u));
    win.webContents.on('will-navigate', (e, u) => check(e, u));
    win.webContents.on('did-redirect-navigation', (e, u) => check(null, u));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      session.fromPartition(part).clearStorageData().catch(() => {});
      if (!finished) reject(new AuthError('cancelled', 'Sign-in window closed.'));
    });
    win.loadURL(url);
  });
}

async function xboxToMinecraft(msAccessToken) {
  const xbl = await postJson('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
    RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT',
  });
  if (!xbl.ok) throw new AuthError('xbl', 'Xbox Live sign-in failed (' + xbl.status + ').');
  const uhs = xbl.json.DisplayClaims.xui[0].uhs;
  const xsts = await postJson('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.json.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT',
  });
  if (!xsts.ok) {
    const x = xsts.json && xsts.json.XErr;
    const msg = {
      2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at minecraft.net, then try again.',
      2148916235: 'Xbox Live is not available in your country.',
      2148916236: 'This account needs adult verification on xbox.com (South Korea).',
      2148916237: 'This account needs adult verification on xbox.com (South Korea).',
      2148916238: 'This is a child account. An adult must add it to a Microsoft Family before it can play.',
    }[x] || 'Xbox sign-in failed (' + (x || xsts.status) + ').';
    throw new AuthError('xsts', msg);
  }
  const mc = await postJson('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.json.Token}`,
  });
  if (mc.status === 403) {
    throw new AuthError('app-not-approved',
      'Mojang has not approved this launcher for Minecraft sign-in yet. Use "Play through the Minecraft Launcher" for now.');
  }
  if (!mc.ok) throw new AuthError('mc', 'Minecraft sign-in failed (' + mc.status + ').');
  const token = mc.json.access_token;
  const prof = await fetchWithTimeout('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (prof.status === 404) throw new AuthError('no-game', 'This Microsoft account does not own Minecraft: Java Edition.');
  if (!prof.ok) throw new AuthError('mc', 'Could not load your Minecraft profile (' + prof.status + ').');
  const p = await prof.json();
  const xuid = (() => {
    try { return JSON.parse(Buffer.from(xsts.json.Token.split('.')[1], 'base64').toString()).xid || ''; } catch { return ''; }
  })();
  return { name: p.name, uuid: p.id, token, expires: Date.now() + (mc.json.expires_in || 86400) * 1000 - 60000, xuid };
}

class Accounts {
  constructor(file) {
    this.file = file;
    this.data = { selected: null, list: [] };
  }
  async load() {
    try {
      const raw = await fsp.readFile(this.file);
      const txt = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString();
      this.data = JSON.parse(txt);
    } catch { this.data = { selected: null, list: [] }; }
    return this;
  }
  async save() {
    const txt = JSON.stringify(this.data);
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt);
    await fsp.writeFile(this.file, buf, { mode: 0o600 });
  }
  /** Public info only (never tokens) for the window. */
  summary() {
    return {
      selected: this.data.selected,
      list: this.data.list.map((a) => ({ uuid: a.uuid, name: a.name })),
      signInAvailable: !!config.MS_CLIENT_ID,
    };
  }
  current() { return this.data.list.find((a) => a.uuid === this.data.selected) || null; }

  async signIn(parent) {
    const { code, verifier } = await interactiveCode(parent);
    const t = await postForm(TOKEN, {
      client_id: config.MS_CLIENT_ID, code, code_verifier: verifier, grant_type: 'authorization_code',
      redirect_uri: REDIRECT, scope: SCOPE,
    });
    const mc = await xboxToMinecraft(t.access_token);
    const acc = { ...mc, refresh: t.refresh_token };
    this.data.list = this.data.list.filter((a) => a.uuid !== acc.uuid);
    this.data.list.push(acc);
    this.data.selected = acc.uuid;
    await this.save();
    return acc;
  }

  /** A valid Minecraft token for the selected account, refreshing when needed. */
  async ready() {
    const acc = this.current();
    if (!acc) throw new AuthError('signed-out', 'Sign in with your Microsoft account first.');
    if (acc.expires > Date.now() + 5 * 60000) return acc;
    let t;
    try {
      t = await postForm(TOKEN, { client_id: config.MS_CLIENT_ID, refresh_token: acc.refresh, grant_type: 'refresh_token', scope: SCOPE });
    } catch (e) {
      throw new AuthError('expired', 'Your sign-in expired. Please sign in again.');
    }
    const mc = await xboxToMinecraft(t.access_token);
    Object.assign(acc, mc, { refresh: t.refresh_token || acc.refresh });
    await this.save();
    return acc;
  }

  async select(uuid) { if (this.data.list.some((a) => a.uuid === uuid)) { this.data.selected = uuid; await this.save(); } }
  async remove(uuid) {
    this.data.list = this.data.list.filter((a) => a.uuid !== uuid);
    if (this.data.selected === uuid) this.data.selected = this.data.list[0] ? this.data.list[0].uuid : null;
    await this.save();
  }
}

module.exports = { Accounts, AuthError };

const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');
const { fetchJson, exists } = require('./net');
const { ensureJava } = require('./java');
const mc = require('./minecraft');
const pack = require('./pack');
const { Accounts, AuthError } = require('./auth');
const official = require('./official');
const { createShortcuts, iconPath } = require('./shortcuts');

app.setName('Create Economy Launcher');
if (process.platform === 'win32') app.setAppUserModelId(config.APP_ID);
Menu.setApplicationMenu(null);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const P = config.paths();
const ROOT = path.join(__dirname, '..', '..');
const ASSET = (...p) => path.join(ROOT, 'assets', ...p);

let splash = null;
let win = null;
let accounts = null;
let settings = null;
let busy = false;
let game = null; // {proc, started}
let lastManifest = null;
const skinCache = new Map();

// ---------- settings ----------
const DEFAULTS = {
  memoryMB: 0, // 0 = recommended
  afterLaunch: 'close', // close | minimize | stay
  autoJoin: true,
  width: 1600, height: 900,
  shortcutsOffered: false,
  firstRun: true,
};
async function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(await fsp.readFile(P.settings, 'utf8')) }; } catch { settings = { ...DEFAULTS }; }
}
async function saveSettings() { await fsp.writeFile(P.settings, JSON.stringify(settings, null, 1)); }
function memoryFor(m) {
  const total = Math.floor(os.totalmem() / 1048576);
  const rec = (m && m.memory && m.memory.recommendedMB) || 6144;
  if (settings.memoryMB) return settings.memoryMB;
  return Math.max(3072, Math.min(rec, Math.floor(total * 0.5 / 512) * 512));
}

// ---------- windows ----------
/** How Windows should start us again from a taskbar pin. */
function relaunchCommand() {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return `"${process.env.PORTABLE_EXECUTABLE_FILE}"`;
  if (app.isPackaged) return `"${process.execPath}"`;
  return `"${process.execPath}" "${app.getAppPath()}"`;
}

/** Icon + relaunch details on the window itself: pinning it always shows the logo and reopens the launcher. */
function taskbarDetails(w) {
  if (process.platform !== 'win32') return;
  try {
    w.setAppDetails({
      appId: config.APP_ID,
      appIconPath: iconPath(),
      appIconIndex: 0,
      relaunchCommand: relaunchCommand(),
      relaunchDisplayName: 'Create Economy',
    });
  } catch { /* older Windows */ }
}
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function createSplash() {
  splash = new BrowserWindow({
    width: 440, height: 440, frame: false, transparent: true, resizable: false, show: false,
    alwaysOnTop: true, skipTaskbar: false, title: 'Create Economy',
    icon: ASSET('img', 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  taskbarDetails(splash);
  splash.loadFile(path.join(ROOT, 'src', 'renderer', 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
}

function createMain() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180, height: 720, minWidth: 960, minHeight: 600, show: false,
    title: 'Create Economy',
    frame: mac, titleBarStyle: mac ? 'hiddenInset' : undefined,
    backgroundColor: '#1d201f',
    icon: ASSET('img', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  taskbarDetails(win);
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { openSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    setTimeout(() => {
      win.show();
      if (splash && !splash.isDestroyed()) splash.close();
    }, 300);
  });
  win.on('maximize', () => send('window', { maximized: true }));
  win.on('unmaximize', () => send('window', { maximized: false }));
}

function openSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') shell.openExternal(url);
  } catch { /* ignore */ }
}

// ---------- self update ----------
let updater = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch { return; }
  updater.autoDownload = process.platform !== 'darwin'; // unsigned mac apps can't self-replace
  updater.on('update-available', (i) => send('update', { state: 'available', version: i.version }));
  updater.on('download-progress', (p) => send('update', { state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => send('update', { state: 'ready', version: i.version }));
  updater.on('error', () => send('update', { state: 'error' }));
  updater.checkForUpdates().catch(() => {});
  setInterval(() => updater.checkForUpdates().catch(() => {}), 3 * 3600 * 1000);
}

// ---------- play ----------
let lastProgressAt = 0;
function progress(p) {
  const now = Date.now();
  if (p.done !== undefined && now - lastProgressAt < 120) return;
  lastProgressAt = now;
  send('progress', p);
}

async function logLine(line) {
  try { await fsp.appendFile(path.join(P.logs, 'launcher.log'), `[${new Date().toISOString()}] ${line}\n`); } catch { /* ignore */ }
}

async function prepare({ repair = false, mcDir = P.minecraft } = {}) {
  await fsp.mkdir(P.logs, { recursive: true });
  progress({ stage: 'pack', text: 'Checking for pack updates' });
  const { manifest, offline } = await pack.fetchManifest(P.cache);
  lastManifest = manifest;
  if (offline) progress({ stage: 'pack', text: 'Offline: using the last downloaded pack' });
  const component = await mc.javaComponentFor(P.minecraft, manifest.minecraft);
  const java = await ensureJava(P.runtime, component, progress);
  if (manifest.loader.type !== 'neoforge') throw new Error('This launcher only supports NeoForge packs');
  const versionId = await mc.ensureNeoForge(mcDir, java.javaConsole, manifest.loader.version, progress, logLine);
  if (!offline || repair) await pack.sync(P.instance, manifest, progress, { repair });
  return { manifest, java, versionId };
}

async function play({ join }) {
  if (busy || game) return { ok: false, error: 'The game is already starting.' };
  busy = true;
  try {
    const devOffline = !app.isPackaged && process.env.CE_OFFLINE_NAME;
    const getAcc = async () => (devOffline
      ? { name: devOffline, uuid: require('crypto').createHash('md5').update('OfflinePlayer:' + devOffline).digest('hex'), token: '0', xuid: '' }
      : accounts.ready());
    await getAcc();
    const { manifest, java, versionId } = await prepare();
    const v = await mc.readVersion(P.minecraft, versionId);
    await mc.ensureGameFiles(P.minecraft, v, progress);
    const fresh = await getAcc();
    const server = manifest.server ? `${manifest.server.address}:${manifest.server.port || 25565}` : null;
    const args = mc.buildCommand(v, {
      mcDir: P.minecraft, gameDir: P.instance,
      account: { ...fresh, clientId: config.MS_CLIENT_ID },
      memoryMB: memoryFor(manifest),
      join: join && settings.autoJoin !== false ? server : null,
      width: settings.width, height: settings.height,
      launcherVersion: app.getVersion(),
      extraJvm: [
        // The game window joins our taskbar icon, and pinning it reopens this launcher.
        ...(process.platform === 'win32' ? [`-Dcelauncher.aumid=${config.APP_ID}`, `-Dcelauncher.relaunch=${relaunchCommand()}`, `-Dcelauncher.icon=${iconPath()}`] : []),
        ...((!app.isPackaged && process.env.CE_EXTRA_JVM) ? process.env.CE_EXTRA_JVM.split(' ') : []),
      ],
    });
    progress({ stage: 'launch', text: 'Starting Minecraft' });
    if (settings.afterLaunch === 'close') return launchAndClose(java.java, args);
    const logFile = fs.createWriteStream(path.join(P.logs, 'game-output.log'));
    const proc = spawn(java.java, args, { cwd: P.instance, detached: false, windowsHide: false });
    game = { proc, started: Date.now(), tail: [] };
    const onData = (b) => {
      logFile.write(b);
      for (const line of b.toString().split(/\r?\n/)) {
        if (!line) continue;
        game.tail.push(line.replace(fresh.token, '<token>'));
        if (game.tail.length > 60) game.tail.shift();
        if (/Setting user:|LWJGL Version|Loading Minecraft/i.test(line)) send('game', { state: 'loading' });
        if (/Sound engine started|Created: \d+x\d+x\d+ minecraft:textures\/atlas/i.test(line)) send('game', { state: 'running' });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    send('game', { state: 'starting' });
    proc.on('spawn', () => {
      setTimeout(() => {
        if (!game || !win) return;
        if (settings.afterLaunch === 'minimize') win.minimize();
        if (settings.afterLaunch === 'close') win.hide();
      }, 4000);
    });
    proc.on('close', (code) => {
      logFile.end();
      const ran = Date.now() - game.started;
      const tail = game.tail.slice(-30);
      game = null;
      if (settings.afterLaunch === 'close' && code === 0) { app.quit(); return; }
      if (win) { win.show(); win.restore(); }
      send('game', { state: 'stopped', code, crashed: code !== 0 && code !== null, ranMs: ran, tail: code ? tail : [] });
    });
    proc.on('error', (e) => send('game', { state: 'stopped', code: -1, crashed: true, tail: [String(e)] }));
    return { ok: true };
  } catch (e) {
    await logLine('play failed: ' + (e.stack || e));
    return { ok: false, error: e.message, code: e.code || null };
  } finally {
    busy = false;
    send('progress', { stage: 'idle' });
  }
}

/**
 * "Close the launcher": start the game as its own process (output straight to the log file, so it
 * doesn't need us), wait until it is really loading, then quit. If it dies straight away, stay open
 * and show why.
 */
function launchAndClose(javaPath, args) {
  const logPath = path.join(P.logs, 'game-output.log');
  const fd = fs.openSync(logPath, 'w');
  const proc = spawn(javaPath, args, { cwd: P.instance, detached: true, windowsHide: false, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  game = { proc, started: Date.now(), tail: [] };
  send('game', { state: 'starting' });
  let exited = null;
  proc.on('exit', (code) => { exited = code; });
  proc.on('error', (e) => { exited = -1; logLine('game failed to start: ' + e); });
  const tail = () => {
    try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-30); } catch { return []; }
  };
  const started = Date.now();
  const timer = setInterval(() => {
    if (exited !== null) {
      clearInterval(timer);
      game = null;
      if (win) { win.show(); win.restore(); }
      send('game', { state: 'stopped', code: exited, crashed: exited !== 0, ranMs: Date.now() - started, tail: tail() });
      return;
    }
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { /* not written yet */ }
    // The game's own loading window is up (or it has clearly been running a while): we're done.
    if (/ImmediateWindowProvider|Loading mods|ModLauncher running/i.test(text) || Date.now() - started > 15000) {
      clearInterval(timer);
      send('game', { state: 'loading' });
      proc.unref();
      setTimeout(() => app.exit(0), 1200);
    }
  }, 500);
  return { ok: true };
}

async function playOfficial() {
  if (busy) return { ok: false, error: 'Busy' };
  busy = true;
  try {
    const dir = official.officialDir();
    if (!(await official.installed())) {
      return { ok: false, code: 'no-official', error: 'The Minecraft Launcher is not installed yet (or has never been opened).' };
    }
    const { manifest, versionId } = await prepare({ mcDir: dir });
    await official.addProfile({
      versionId, gameDir: P.instance, memoryMB: memoryFor(manifest),
      iconPng: await fsp.readFile(ASSET('img', 'icon-128.png')).catch(() => fsp.readFile(ASSET('img', 'icon.png'))),
    });
    await official.openOfficialLauncher();
    return { ok: true };
  } catch (e) {
    await logLine('official failed: ' + (e.stack || e));
    return { ok: false, error: e.message };
  } finally {
    busy = false;
    send('progress', { stage: 'idle' });
  }
}

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...a) => {
    if (!win || e.sender !== win.webContents) throw new Error('denied');
    return fn(...a);
  });
}

function registerIpc() {
  handle('state', async () => {
    const st = await pack.readState(P.instance);
    return {
      launcherVersion: app.getVersion(),
      platform: process.platform,
      settings, totalMemMB: Math.floor(os.totalmem() / 1048576),
      accounts: accounts.summary(),
      installedPack: st.version || null,
      dataDir: P.root,
      server: config.SERVER_ADDRESS,
      website: config.WEBSITE,
      discord: config.DISCORD_INVITE,
      gameRunning: !!game,
    };
  });
  handle('pack', async () => {
    const { manifest, offline } = await pack.fetchManifest(P.cache);
    lastManifest = manifest;
    const st = await pack.readState(P.instance);
    return {
      version: manifest.version, released: manifest.released, notes: manifest.notes, history: manifest.history || [],
      minecraft: manifest.minecraft, loader: manifest.loader, mods: manifest.files.filter((f) => !f.mode).length,
      recommendedMB: memoryFor(manifest), offline, installed: st.version || null,
      update: !!st.version && st.version !== manifest.version,
    };
  });
  handle('live', async () => {
    if (!app.isPackaged && process.env.CE_LIVE_FILE) return JSON.parse(await fsp.readFile(process.env.CE_LIVE_FILE, 'utf8'));
    return fetchJson(config.LIVE_URL, {}, 1).catch(() => null);
  });
  handle('news', async () => {
    const d = await fetchJson(config.NEWS_URL, {}, 1).catch(() => null);
    if (!d || !Array.isArray(d.channels)) return [];
    const want = ['announcement', 'updates', 'modpack-updates'];
    const out = [];
    for (const c of d.channels) {
      if (!want.includes(c.name)) continue;
      for (const m of c.messages || []) {
        out.push({
          channel: c.name, t: m.t, author: (m.author && (m.author.name || m.author.username)) || '',
          content: String(m.content || '').slice(0, 1500),
          image: ((m.attachments || []).find((a) => /\.(png|jpe?g|webp|gif)(\?|$)/i.test(a.url || a.name || '')) || {}).url || null,
        });
      }
    }
    return out.sort((a, b) => (a.t < b.t ? 1 : -1)).slice(0, 20);
  });
  handle('lookup', async (name) => {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(String(name || ''))) return null;
    try {
      const p = await fetchJson('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name), {}, 1);
      return p && p.id ? { name: p.name, uuid: p.id } : null;
    } catch { return null; }
  });
  handle('skin', async (uuid) => {
    uuid = String(uuid || '').replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(uuid)) return null;
    if (skinCache.has(uuid)) return skinCache.get(uuid);
    const result = await loadSkin(uuid);
    skinCache.set(uuid, result);
    return result;
  });
  async function loadSkin(uuid) {
    try {
      const p = await fetchJson('https://sessionserver.mojang.com/session/minecraft/profile/' + encodeURIComponent(uuid), {}, 1);
      const tex = JSON.parse(Buffer.from(p.properties.find((x) => x.name === 'textures').value, 'base64').toString());
      const url = tex.textures && tex.textures.SKIN && tex.textures.SKIN.url;
      if (!url) return null;
      const r = await require('electron').net.fetch(url.replace('http://', 'https://'));
      return 'data:image/png;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
    } catch { return null; }
  }
  handle('signin', async () => {
    try { await accounts.signIn(win); return { ok: true, accounts: accounts.summary() }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });
  handle('account:select', async (uuid) => { await accounts.select(uuid); return accounts.summary(); });
  handle('account:remove', async (uuid) => { await accounts.remove(uuid); return accounts.summary(); });
  handle('play', (opts) => play(opts || {}));
  handle('play:official', () => playOfficial());
  handle('official:get', () => openSafe('https://www.minecraft.net/download'));
  handle('repair', async () => {
    if (busy) return { ok: false, error: 'Busy' };
    busy = true;
    try {
      const { versionId } = await prepare({ repair: true });
      const v = await mc.readVersion(P.minecraft, versionId);
      await mc.ensureGameFiles(P.minecraft, v, progress, true);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; } finally { busy = false; send('progress', { stage: 'idle' }); }
  });
  handle('settings', async (patch) => {
    const allowed = ['memoryMB', 'afterLaunch', 'autoJoin', 'width', 'height', 'shortcutsOffered', 'firstRun', 'officialHintShown', 'playerName', 'playerUuid'];
    for (const k of allowed) if (patch && k in patch) settings[k] = patch[k];
    await saveSettings();
    return settings;
  });
  handle('shortcuts', (auto) => (auto && (!app.isPackaged || process.env.CE_SCREENSHOT) ? [] : createShortcuts()));
  handle('open', async (what) => {
    const map = {
      game: P.instance, logs: P.logs,
      crashes: path.join(P.instance, 'crash-reports'),
      screenshots: path.join(P.instance, 'screenshots'),
      mods: path.join(P.instance, 'mods'),
    };
    const p = map[what];
    if (!p) return;
    await fsp.mkdir(p, { recursive: true });
    shell.openPath(p);
  });
  handle('url', (u) => openSafe(u));
  handle('win', (a) => {
    if (a === 'min') win.minimize();
    if (a === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    if (a === 'close') win.close();
  });
  handle('update:install', () => { if (updater) updater.quitAndInstall(); });
  handle('update:page', () => openSafe('https://github.com/Mrvew/create-economy-launcher/releases/latest'));
  handle('kill', () => { if (game) game.proc.kill(); });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
});

app.whenReady().then(async () => {
  await fsp.mkdir(P.root, { recursive: true });
  createSplash();
  await loadSettings();
  accounts = await new Accounts(P.accounts).load();
  registerIpc();
  createMain();
  setupUpdater();
  if (!app.isPackaged && process.env.CE_AUTOPLAY) {
    win.webContents.once('did-finish-load', async () => {
      const r = process.env.CE_AUTOPLAY === 'official' ? await playOfficial() : await play({ join: process.env.CE_AUTOPLAY === 'join' });
      await logLine('autoplay result ' + JSON.stringify(r));
    });
  }
});

app.on('window-all-closed', () => {
  if (game) return; // keep running in the background while the game is open
  app.quit();
});
app.on('activate', () => { if (win) win.show(); });

// Dev helper: CE_SCREENSHOT=<dir> saves screenshots of each view, then quits.
if (process.env.CE_SCREENSHOT) {
  app.whenReady().then(() => setTimeout(async () => {
    const out = process.env.CE_SCREENSHOT;
    await fsp.mkdir(out, { recursive: true });
    const shots = (process.env.CE_SHOTS || 'home,news,settings,loading,pin').split(',');
    for (const s of shots) {
      const js = {
        home: "document.querySelector('.nav[data-view=home]').click()",
        news: "document.querySelector('.nav[data-view=news]').click()",
        ranks: "document.querySelector('.nav[data-view=ranks]').click()",
        settings: "document.querySelector('.nav[data-view=settings]').click()",
        loading: "document.querySelector('.nav[data-view=home]').click();document.getElementById('loading').hidden=false;document.getElementById('load-tip').innerHTML='Sell what your factory makes at the <b>Shop</b> vendors.';document.getElementById('load-fill').style.width='42%'",
        pin: "document.getElementById('loading').hidden=true;document.getElementById('pin-help').click()",
        menu: "document.getElementById('modal').hidden=true;document.getElementById('play-more').click()",
        belt: "document.getElementById('play-menu').hidden=true;document.getElementById('play-group').hidden=true;document.getElementById('belt').hidden=false;document.getElementById('belt-fill').classList.remove('indeterminate');document.getElementById('belt-fill').style.width='63%';document.getElementById('belt-text').textContent='Downloading pack files (131/216)';document.getElementById('belt-num').textContent='702 MB / 1.11 GB'",
      }[s];
      if (js) await win.webContents.executeJavaScript(js).catch(() => {});
      await new Promise((r) => setTimeout(r, 1800));
      const img = await win.webContents.capturePage();
      await fsp.writeFile(path.join(out, s + '.png'), img.toPNG());
    }
    if (splash && !splash.isDestroyed()) {
      const img = await splash.webContents.capturePage().catch(() => null);
      if (img) await fsp.writeFile(path.join(out, 'splash.png'), img.toPNG());
    }
    app.exit(0);
  }, Number(process.env.CE_SCREENSHOT_WAIT || 6000)));
}

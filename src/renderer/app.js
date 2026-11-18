/* Create Economy Launcher window. Talks to the main process only through window.ce (preload). */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = window.ce;

const BACKGROUNDS = ['everyone_spawn', 'lab_factory', 'north_carrier_side', 'south_mill', 'shop_aerial', 'end_ship', 'north_sunrays', 'lab_flightdeck'];
const TIPS = [
  'Sell what your factory makes at the <b>Shop</b> vendors to earn coins.',
  'Claim your land with the <b>FTB Chunks</b> map so nobody can grief your base.',
  'Vote every day with <b>/vote</b> to climb the ranks and unlock perks.',
  'The live map of every world is on <b>create-economy.net</b>.',
  'Build airships with <b>Create Aeronautics</b> and fly them between your bases.',
  'Stuck? Ask in chat or on the <b>Discord</b>: someone has probably built it before.',
  'Shop plots are bought with a <b>shop token</b>. Run your own store!',
];

let st = null;
let packInfo = null;
let mode = 'join';
let running = false;

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function gb(mb) { return (mb / 1024).toFixed(mb % 1024 ? 1 : 0) + ' GB'; }
function bytes(n) { return n > 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : (n / 1048576).toFixed(0) + ' MB'; }
function ago(t) {
  const d = (Date.now() - new Date(t)) / 1000;
  if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
  if (d < 86400) return Math.round(d / 3600) + ' h ago';
  return Math.round(d / 86400) + ' days ago';
}

/* ---------- background slideshow ---------- */
(function slideshow() {
  const slides = $$('#bg .slide');
  let i = Math.floor(Math.random() * BACKGROUNDS.length);
  let s = 0;
  const show = () => {
    const next = slides[s % 2];
    const prev = slides[(s + 1) % 2];
    next.style.backgroundImage = `url("../../assets/img/bg/${BACKGROUNDS[i % BACKGROUNDS.length]}.jpg")`;
    next.classList.remove('on');
    void next.offsetWidth;
    next.classList.add('on');
    prev.classList.remove('on');
    i++; s++;
  };
  show();
  setInterval(show, 11000);
})();

/* ---------- window chrome ---------- */
$$('[data-win]').forEach((b) => b.addEventListener('click', () => api.win(b.dataset.win)));
$$('.nav[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
function showView(v) {
  $$('.nav[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('on', s.dataset.view === v));
  if (v === 'news') loadNews(true);
}
$$('.nav.ext').forEach((b) => b.addEventListener('click', () => api.url(b.dataset.url === 'discord' ? st.discord : st.website)));

/* ---------- account ---------- */
async function drawHead(canvas, uuid) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#3a3e3c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!uuid) return;
  const data = await api.skin(uuid);
  if (!data) return;
  const img = new Image();
  img.onload = () => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 8, 8, 8, 8, 0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 40, 8, 8, 8, 0, 0, canvas.width, canvas.height);
  };
  img.src = data;
}

/** No Azure app in this build: the official Minecraft Launcher does the sign-in. */
function viaOfficial() { return !st.accounts.signInAvailable; }

function renderAccounts() {
  const a = st.accounts;
  if (viaOfficial()) {
    $('#acc-name').textContent = 'Minecraft Launcher';
    $('#acc-sub').textContent = 'Signs you in';
    $('#acc-group').hidden = true;
    const c = $('#head').getContext('2d');
    const img = new Image();
    img.onload = () => { c.clearRect(0, 0, 32, 32); c.drawImage(img, 0, 0, 32, 32); };
    img.src = '../../assets/img/icon-128.png';
    $('#play-more').hidden = true;
    updatePlayLabel();
    return;
  }
  const cur = a.list.find((x) => x.uuid === a.selected);
  $('#acc-name').textContent = cur ? cur.name : 'Not signed in';
  $('#acc-sub').textContent = cur ? 'Microsoft account' : 'Click to sign in';
  drawHead($('#head'), cur && cur.uuid);
  const list = $('#acc-list');
  list.innerHTML = '';
  for (const x of a.list) {
    const row = document.createElement('div');
    row.className = 'accrow';
    row.innerHTML = `<canvas width="16" height="16"></canvas><span class="grow">${esc(x.name)}</span>
      ${x.uuid === a.selected ? '<span class="tag">Playing as</span>' : '<button class="btn" data-sel>Use</button>'}
      <button class="btn danger" data-rm>Sign out</button>`;
    drawHead($('canvas', row), x.uuid);
    const sel = $('[data-sel]', row);
    if (sel) sel.onclick = async () => { st.accounts = await api.selectAccount(x.uuid); renderAccounts(); };
    $('[data-rm]', row).onclick = async () => { st.accounts = await api.removeAccount(x.uuid); renderAccounts(); };
    list.appendChild(row);
  }
  updatePlayLabel();
}

async function signIn() {
  if (!st.accounts.signInAvailable) return noSignInDialog();
  const r = await api.signIn();
  if (r.ok) { st.accounts = r.accounts; renderAccounts(); return true; }
  if (r.code === 'cancelled') return false;
  if (r.code === 'app-not-approved' || r.code === 'no-client') return noSignInDialog(r.error);
  dialog('Sign-in failed', `<p>${esc(r.error)}</p>`);
  return false;
}
$('#acc').addEventListener('click', () => (viaOfficial() ? dialog('Signing in', '<p>Your Microsoft account is handled by the official Minecraft Launcher. Press <b>Play</b> and it opens with Create Economy selected, using whichever account you are signed in with there.</p>') : st.accounts.list.length ? showView('settings') : signIn()));
$('#add-acc').addEventListener('click', signIn);

/* ---------- server status + pack ---------- */
let live = null;
async function loadLive() {
  const d = await api.live();
  live = d;
  renderBoards();
  const dot = $('#st-dot');
  if (!d || !d.status) {
    dot.className = 'dot';
    $('#st-text').textContent = 'Status unavailable';
    return;
  }
  const s = d.status;
  dot.className = 'dot ' + (s.online ? 'on' : 'off');
  $('#st-text').textContent = s.online ? `Online: ${s.players} / ${s.max} playing` : 'Server offline';
}
$('#copy-addr').addEventListener('click', () => {
  navigator.clipboard.writeText(st.server);
  $('#copy-addr').textContent = 'Copied';
  setTimeout(() => ($('#copy-addr').textContent = 'Copy'), 1500);
});

async function loadPack() {
  try {
    packInfo = await api.pack();
    $('#pk-ver').textContent = `Pack ${packInfo.version}`;
    $('#pk-info').textContent = packInfo.offline
      ? 'Offline: using your saved copy'
      : !packInfo.installed ? `${packInfo.mods} mods to download on first play`
        : packInfo.update ? `Update from ${packInfo.installed}: installs when you press Play`
          : `${packInfo.mods} mods, up to date`;
    $('#ver-line').textContent = `Minecraft ${packInfo.minecraft} · NeoForge ${packInfo.loader.version}`;
    const h = $('#pack-history');
    h.innerHTML = '';
    const rows = [{ version: packInfo.version, released: packInfo.released, notes: packInfo.notes }, ...packInfo.history];
    for (const r of rows) {
      const d = document.createElement('div');
      d.className = 'h';
      d.innerHTML = `<b>${esc(r.version)}</b><span class="muted small">${r.released ? new Date(r.released).toLocaleDateString() : ''}</span><div>${esc(r.notes || '')}</div>`;
      h.appendChild(d);
    }
    if (!st.settings.memoryMB) setMemUi(packInfo.recommendedMB);
  } catch (e) {
    $('#pk-ver').textContent = 'Pack';
    $('#pk-info').textContent = 'Could not check for updates';
  }
}

/* ---------- news ---------- */
let newsCache = null;
async function loadNews(full) {
  if (!newsCache) newsCache = await api.news();
  const items = newsCache || [];
  const peek = $('#home-news');
  peek.innerHTML = '';
  for (const n of items.slice(0, 2)) {
    const d = document.createElement('div');
    d.className = 'peek';
    d.innerHTML = `<div class="ch">#${esc(n.channel)} · ${ago(n.t)}</div><div class="tx">${esc(clean(n.content))}</div>`;
    d.onclick = () => showView('news');
    peek.appendChild(d);
  }
  if (!full) return;
  const list = $('#news-list');
  list.innerHTML = items.length ? '' : '<p class="muted">No news right now.</p>';
  for (const n of items) {
    const a = document.createElement('article');
    a.className = 'news';
    a.innerHTML = `<header><span><b>#${esc(n.channel)}</b> ${esc(n.author)}</span><span>${new Date(n.t).toLocaleString()}</span></header>
      <div class="body">${esc(clean(n.content))}</div>${n.image ? `<img src="${esc(n.image)}" alt="">` : ''}`;
    list.appendChild(a);
  }
}
function clean(s) { return String(s).replace(/<[@#&!]+\d+>/g, '').replace(/\*\*|__|~~/g, '').replace(/<a?:(\w+):\d+>/g, ':$1:').trim(); }

/* ---------- settings ---------- */
function setMemUi(mb) {
  $('#mem').value = mb;
  $('#mem-val').textContent = gb(mb);
}
function initSettings() {
  const s = st.settings;
  const max = Math.max(4096, Math.floor((st.totalMemMB * 0.75) / 512) * 512);
  $('#mem').max = Math.min(16384, max);
  setMemUi(s.memoryMB || 6144);
  $('#mem-hint').textContent = `Recommended: 6 GB. Your computer has ${gb(Math.round(st.totalMemMB / 1024) * 1024)}.`;
  $('#mem').oninput = () => ($('#mem-val').textContent = gb(+$('#mem').value));
  $('#mem').onchange = () => api.setSettings({ memoryMB: +$('#mem').value });
  $('#autojoin').checked = s.autoJoin !== false;
  $('#autojoin').onchange = async () => { st.settings = await api.setSettings({ autoJoin: $('#autojoin').checked }); updatePlayLabel(); };
  $('#after').value = s.afterLaunch;
  $('#after').onchange = () => api.setSettings({ afterLaunch: $('#after').value });
  $('#w').value = s.width; $('#h').value = s.height;
  $('#w').onchange = () => api.setSettings({ width: +$('#w').value || 1600 });
  $('#h').onchange = () => api.setSettings({ height: +$('#h').value || 900 });
  $$('[data-open]').forEach((b) => (b.onclick = () => api.open(b.dataset.open)));
  $('#mk-shortcut').onclick = async () => {
    const made = await api.createShortcuts();
    $('#mk-shortcut').textContent = made.length ? 'Done' : 'Not needed';
  };
  $('#pin-help').onclick = pinDialog;
  $('#repair').onclick = async () => {
    if (running) return;
    setBusy(true, 'Repairing');
    const r = await api.repair();
    setBusy(false);
    dialog(r.ok ? 'All files checked' : 'Repair failed', r.ok ? '<p>Every file was checked and anything broken was downloaded again.</p>' : `<p>${esc(r.error)}</p>`);
  };
  $('#about').textContent = `Create Economy Launcher ${st.launcherVersion} · files in ${st.dataDir}`;
}

/* ---------- play ---------- */
function updatePlayLabel() {
  const signed = !!st.accounts.selected;
  if (running) return;
  if (viaOfficial()) {
    $('#play-label').textContent = 'Play';
    $('#play-sub').textContent = 'Opens in the Minecraft Launcher';
    return;
  }
  $('#play-label').textContent = signed ? 'Play' : 'Sign in';
  $('#play-sub').textContent = !signed ? 'with your Microsoft account'
    : mode === 'menu' ? 'to the main menu'
      : mode === 'official' ? 'through the Minecraft Launcher'
        : (st.settings.autoJoin !== false ? 'Join Create Economy' : 'to the main menu');
}

$('#play-more').addEventListener('click', (e) => { e.stopPropagation(); $('#play-menu').hidden = !$('#play-menu').hidden; });
document.addEventListener('click', () => ($('#play-menu').hidden = true));
$$('#play-menu button').forEach((b) => b.addEventListener('click', () => {
  mode = b.dataset.mode;
  updatePlayLabel();
  $('#play-menu').hidden = true;
  startPlay();
}));
$('#play').addEventListener('click', () => startPlay());

let tipTimer = null;
function setBusy(on, text) {
  running = on;
  $('#play').disabled = on;
  $('#play-more').disabled = on;
  $('#play-group').hidden = on;
  $('#belt').hidden = !on;
  if (on) {
    $('#belt-text').textContent = text || 'Preparing';
    $('#belt-num').textContent = '';
    $('#belt-fill').classList.add('indeterminate');
  } else {
    updatePlayLabel();
  }
}
function showLoading(on) {
  $('#loading').hidden = !on;
  clearInterval(tipTimer);
  if (on) {
    let t = Math.floor(Math.random() * TIPS.length);
    const next = () => { $('#load-tip').innerHTML = TIPS[t++ % TIPS.length]; };
    next();
    tipTimer = setInterval(next, 6000);
  }
}

async function startPlay() {
  if (running) return;
  if (mode === 'official' || viaOfficial()) {
    setBusy(true, 'Getting Create Economy ready');
    const r = await api.playOfficial();
    setBusy(false);
    if (r.ok) {
      $('#belt').hidden = false;
      $('#play-group').hidden = true;
      $('#belt-fill').classList.remove('indeterminate');
      $('#belt-fill').style.width = '100%';
      $('#belt-text').textContent = 'Ready: press PLAY in the Minecraft Launcher';
      $('#belt-num').textContent = '';
      if (st.settings.afterLaunch === 'close') {
        // Hand-off done: the Minecraft Launcher takes it from here.
        setTimeout(() => api.win('close'), 2500);
      } else {
        setTimeout(() => { if (!running) { $('#belt').hidden = true; $('#play-group').hidden = false; } }, 12000);
      }
    } else if (r.code === 'no-official') {
      dialog('Install the Minecraft Launcher first', `
        <p>Create Economy uses the official Minecraft Launcher to sign you in with your Microsoft account.</p>
        <p>Install it from minecraft.net, open it once and sign in, then press Play here again.</p>
        <div class="modal-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="get-official">Get the Minecraft Launcher</button></div>`, false);
      $$('[data-close]').forEach((b) => (b.onclick = closeDialog));
      $('#get-official').onclick = () => { api.getOfficial(); closeDialog(); };
    } else {
      dialog('Could not set it up', `<p>${esc(r.error)}</p><div class="modal-actions"><button class="btn" data-open-logs>Open logs</button></div>`);
      const b = $('[data-open-logs]');
      if (b) b.onclick = () => api.open('logs');
    }
    mode = 'join';
    updatePlayLabel();
    return;
  }
  if (!st.accounts.selected) { await signIn(); return; }
  setBusy(true, 'Preparing');
  showLoading(true);
  $('#load-stage').textContent = 'Getting Create Economy ready';
  const r = await api.play({ join: mode === 'join' });
  mode = 'join';
  if (!r.ok) {
    setBusy(false);
    showLoading(false);
    if (r.code === 'signed-out' || r.code === 'expired') { await signIn(); return; }
    if (r.code === 'app-not-approved') return noSignInDialog(r.error);
    dialog('Could not start the game', `<p>${esc(r.error)}</p><div class="modal-actions"><button class="btn" data-open-logs>Open logs</button></div>`);
    const b = $('[data-open-logs]');
    if (b) b.onclick = () => api.open('logs');
  }
}

api.onProgress((p) => {
  if (p.stage === 'idle') return;
  const fill = $('#belt-fill');
  const lfill = $('#load-fill');
  $('#belt-text').textContent = p.text || '';
  $('#load-stage').textContent = p.text || '';
  if (p.total) {
    const pct = Math.min(100, (p.done / p.total) * 100);
    fill.classList.remove('indeterminate');
    lfill.classList.remove('indeterminate');
    fill.style.width = pct + '%';
    lfill.style.width = pct + '%';
    $('#belt-num').textContent = `${bytes(p.done)} / ${bytes(p.total)}`;
  } else {
    fill.classList.add('indeterminate');
    lfill.classList.add('indeterminate');
    $('#belt-num').textContent = '';
  }
});

api.onGame((g) => {
  if (g.state === 'starting' || g.state === 'loading') {
    setBusy(true, 'Minecraft is loading');
    showLoading(true);
    $('#load-stage').textContent = 'Minecraft is loading the Create Economy pack';
    $('#load-fill').classList.add('indeterminate');
  }
  if (g.state === 'running') {
    showLoading(false);
    $('#belt-text').textContent = 'Playing Create Economy';
    $('#belt-num').innerHTML = '';
  }
  if (g.state === 'stopped') {
    showLoading(false);
    setBusy(false);
    loadPack();
    if (g.crashed && (g.ranMs || 0) < 30 * 60000) {
      dialog('The game closed unexpectedly', `<p>Minecraft stopped with code ${g.code}. The last lines of the log are below. If this keeps happening, try <b>Settings → Repair</b>, or send the crash report on the Discord.</p>
        <pre>${esc((g.tail || []).join('\n'))}</pre>
        <div class="modal-actions"><button class="btn" data-o="crashes">Crash reports</button><button class="btn" data-o="logs">Logs</button></div>`);
      $$('[data-o]').forEach((b) => (b.onclick = () => api.open(b.dataset.o)));
    }
  }
});

/* ---------- launcher updates ---------- */
api.onUpdate((u) => {
  const pill = $('#update-pill');
  if (u.state === 'available') { pill.hidden = false; pill.textContent = `Launcher ${u.version} available`; pill.onclick = () => api.updatePage(); }
  if (u.state === 'downloading') { pill.hidden = false; pill.textContent = `Updating launcher ${u.percent}%`; pill.onclick = null; }
  if (u.state === 'ready') { pill.hidden = false; pill.textContent = `Restart to update to ${u.version}`; pill.onclick = () => api.installUpdate(); }
});

/* ---------- dialogs ---------- */
function dialog(title, html, actions = true) {
  const box = $('#modal-box');
  box.innerHTML = `<h2>${esc(title)}</h2>${html}${actions ? '<div class="modal-actions"><button class="btn primary" data-close>OK</button></div>' : ''}`;
  $('#modal').hidden = false;
  $$('[data-close]', box).forEach((b) => (b.onclick = closeDialog));
}
function closeDialog() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDialog(); });

function noSignInDialog(reason) {
  dialog('Play through the Minecraft Launcher', `
    <p>${reason ? esc(reason) : 'Microsoft sign-in inside this launcher is still waiting for approval from Mojang.'}</p>
    <p>You can still play right now: the launcher sets everything up and adds a <b>Create Economy</b> profile to the official Minecraft Launcher, which signs you in.</p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="go-official">Set it up</button></div>`, false);
  $$('[data-close]').forEach((b) => (b.onclick = closeDialog));
  $('#go-official').onclick = () => { closeDialog(); mode = 'official'; startPlay(); };
}

function pinDialog() {
  const mac = st.platform === 'darwin';
  const steps = mac
    ? `<ol class="steps"><li>While the launcher is open, right-click (or Control-click) its icon in the <b>Dock</b>.</li><li>Choose <b>Options</b> → <b>Keep in Dock</b>.</li></ol>`
    : st.platform === 'win32'
      ? `<ol class="steps"><li>While the launcher is open, right-click its icon on the <b>taskbar</b>.</li><li>Click <b>Pin to taskbar</b>.</li><li>Want it on Start too? Press the Windows key, find <b>Create Economy</b>, right-click → <b>Pin to Start</b>.</li></ol>`
      : `<ol class="steps"><li>Press <b>Create</b> next to "Desktop and Start menu shortcut" first.</li><li>Find <b>Create Economy</b> in your app menu, right-click → <b>Add to favourites</b> / <b>Pin to panel</b>.</li></ol>`;
  dialog(mac ? 'Keep it in your Dock' : 'Pin it to your taskbar', `
    <div class="taskbar-demo">
      <div class="ctx"><div>Create Economy Launcher</div><div class="hl">${mac ? 'Options → Keep in Dock' : 'Pin to taskbar'}</div><div>Close window</div></div>
      <div class="tbar"><i></i><i></i><img src="../../assets/img/icon.png" alt=""><i></i><i></i></div>
    </div>
    ${steps}
    <p class="muted small">${mac ? 'macOS' : 'Windows'} only lets you do this yourself, so it is one click instead of automatic.</p>`);
}

/* ---------- players online + leaderboards ---------- */
const MC_COLORS = { black: '#555', dark_blue: '#3b5bdb', dark_green: '#2f9e44', dark_aqua: '#1098ad', dark_red: '#c92a2a',
  dark_purple: '#9c36b5', gold: '#ffaa00', gray: '#aaa', dark_gray: '#777', blue: '#6b7cff', green: '#55ff55', aqua: '#55ffff',
  red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#fff' };
let voteKey = 'month';
const plain = (u) => String(u || '').replace(/-/g, '').toLowerCase();

/** Who is using this launcher: the signed-in account, or the name they typed. */
function me() {
  const a = st && st.accounts;
  const cur = a && a.list.find((x) => x.uuid === a.selected);
  if (cur) return { name: cur.name, uuid: plain(cur.uuid) };
  if (st && st.settings.playerName) return { name: st.settings.playerName, uuid: plain(st.settings.playerUuid) };
  return null;
}
function isMe(row) {
  const m = me();
  if (!m) return false;
  return (m.uuid && plain(row.uuid) === m.uuid) || String(row.name || '').toLowerCase() === m.name.toLowerCase();
}
function money(n) { return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
function tier(i) {
  const r = live && live.ranks && live.ranks[i];
  return r ? `<span class="tier c-${MC_COLORS[r.color] ? r.color : 'gray'}">${esc(r.name)}</span>` : '';
}
function headCanvas(uuid, size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  drawHead(c, uuid);
  return c;
}
function myPositions() {
  const out = { vote: null, money: null };
  if (!live) return out;
  const vb = (live.leaderboard && live.leaderboard[voteKey]) || [];
  const vi = vb.findIndex(isMe);
  if (vi >= 0) out.vote = { pos: vi + 1, of: vb.length, votes: vb[vi].votes, tier: vb[vi].rank };
  const mb = live.money && live.money.board;
  if (mb) {
    const mi = mb.findIndex(isMe);
    if (mi >= 0) out.money = { pos: mb[mi].position || mi + 1, of: live.money.players || mb.length, balance: mb[mi].balance };
  }
  return out;
}

function renderMeCard() {
  const box = $('#me-card');
  const m = me();
  if (!m) {
    box.innerHTML = `<h4>Your ranks</h4><div class="muted small">Type your Minecraft name to see where you are on the vote and money leaderboards.</div>
      <div class="ask"><input id="ask-name" maxlength="16" spellcheck="false" placeholder="Minecraft name"><button class="btn primary" id="ask-go">Show</button></div>`;
    const go = async () => { if (await saveName($('#ask-name').value)) renderBoards(); };
    $('#ask-go').onclick = go;
    $('#ask-name').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    return;
  }
  const p = myPositions();
  const monthName = voteKey === 'month' ? 'this month' : 'all time';
  const vote = p.vote ? `<span><span class="pos">#${p.vote.pos}</span> in votes ${monthName} · ${p.vote.votes} vote${p.vote.votes === 1 ? '' : 's'}${tier(p.vote.tier)}</span>`
    : `<span class="muted">No votes ${monthName} yet: vote with /vote in game</span>`;
  const cash = !live || !live.money ? '<span class="muted">Money leaderboard starts when Create Economy Money is added</span>'
    : p.money ? `<span><span class="pos">#${p.money.pos}</span> richest of ${p.money.of} · ${money(p.money.balance)}</span>`
      : '<span class="muted">Not on the money leaderboard yet</span>';
  box.innerHTML = `<h4>Your ranks <small><a href="#" id="see-boards" class="link">Leaderboards</a></small></h4>
    <div class="me"><canvas width="16" height="16"></canvas><div class="stats"><b>${esc(m.name)}</b>${vote}${cash}</div></div>`;
  drawHead($('canvas', box), m.uuid);
  $('#see-boards').onclick = (e) => { e.preventDefault(); showView('ranks'); };
}

function renderOnlinePanel() {
  const box = $('#online-panel');
  const list = (live && live.onlinePlayers) || [];
  const online = live && live.status && live.status.online;
  box.innerHTML = `<h4>Online now <small>${online ? `${live.status.players} / ${live.status.max}` : 'offline'}</small></h4>`;
  if (!list.length) {
    box.insertAdjacentHTML('beforeend', `<div class="muted small">${online ? 'Nobody is on right now. Be the first!' : 'The server is offline.'}</div>`);
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'heads';
  for (const pl of list.slice(0, 30)) {
    const chip = document.createElement('div');
    chip.className = 'head-chip' + (isMe(pl) ? ' me-hl' : '');
    chip.appendChild(headCanvas(pl.uuid, 8));
    chip.insertAdjacentHTML('beforeend', `<span>${esc(pl.name)}</span>`);
    wrap.appendChild(chip);
  }
  box.appendChild(wrap);
}

function boardRows(el, rows, value, empty) {
  el.innerHTML = '';
  if (!rows.length) { el.innerHTML = `<div class="empty">${empty}</div>`; return; }
  rows.slice(0, 100).forEach((r, i) => {
    const pos = r.position || i + 1;
    const d = document.createElement('div');
    d.className = 'lrow' + (pos <= 3 ? ' top' + pos : '') + (isMe(r) ? ' me-hl' : '');
    d.innerHTML = `<span class="n">#${pos}</span><span></span><span class="who">${esc(r.name)}${r.rank !== undefined && r.rank !== null && !r.position ? tier(r.rank) : ''}</span><span class="v">${value(r)}</span>`;
    d.replaceChild(headCanvas(r.uuid, 8), d.children[1]);
    el.appendChild(d);
  });
  const mine = rows.findIndex(isMe);
  if (mine >= 100) {
    const r = rows[mine];
    el.insertAdjacentHTML('beforeend', `<div class="lrow me-hl"><span class="n">#${r.position || mine + 1}</span><span></span><span class="who">${esc(r.name)}</span><span class="v">${value(r)}</span></div>`);
  }
}

function renderBoards() {
  renderMeCard();
  renderOnlinePanel();
  if (!live) return;
  const p = myPositions();
  const m = me();
  const strip = $('#me-strip');
  strip.innerHTML = !m ? '<div class="tile"><b>Who are you?</b><span>Add your Minecraft name in Settings to see your ranks</span></div>'
    : `<div class="tile"><b>${p.vote ? '#' + p.vote.pos : '-'}</b><span>${esc(m.name)} in votes ${voteKey === 'month' ? 'this month' : 'all time'}${p.vote ? ` (${p.vote.votes})` : ''}</span></div>
       <div class="tile"><b>${p.money ? '#' + p.money.pos : '-'}</b><span>${live.money ? (p.money ? 'richest · ' + money(p.money.balance) : 'not ranked yet') : 'money leaderboard coming soon'}</span></div>`;
  const vb = (live.leaderboard && live.leaderboard[voteKey]) || [];
  boardRows($('#vote-rows'), vb, (r) => r.votes, voteKey === 'month' ? 'No votes yet this month.' : 'No votes yet.');
  if (live.money) {
    $('#money-total').textContent = `${live.money.players} players · ${money(live.money.total)} in total`;
    boardRows($('#money-rows'), live.money.board || [], (r) => money(r.balance), 'Nobody has any money yet.');
  } else {
    $('#money-total').textContent = '';
    $('#money-rows').innerHTML = '<div class="empty">The money leaderboard turns on by itself once Create Economy Money is on the server. Everyone\'s balance will show here.</div>';
  }
  const ol = live.onlinePlayers || [];
  $('#online-count').textContent = live.status && live.status.online ? `${live.status.players} / ${live.status.max}` : 'offline';
  boardRows($('#online-rows'), ol.map((o) => ({ ...o, position: undefined })), (o) => (o.votes ? o.votes + ' votes' : ''),
    live.status && live.status.online ? 'Nobody is on right now.' : 'The server is offline.');
}
$$('#vote-seg button').forEach((b) => b.addEventListener('click', () => {
  voteKey = b.dataset.k;
  $$('#vote-seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderBoards();
}));

async function saveName(name) {
  name = String(name || '').trim();
  if (!name) { st.settings = await api.setSettings({ playerName: '', playerUuid: '' }); return true; }
  const r = await api.lookup(name);
  if (!r) { dialog('Name not found', `<p>There is no Minecraft: Java Edition player called <b>${esc(name)}</b>. Check the spelling.</p>`); return false; }
  st.settings = await api.setSettings({ playerName: r.name, playerUuid: r.uuid });
  $('#my-name').value = r.name;
  return true;
}
$('#save-name').addEventListener('click', async () => { if (await saveName($('#my-name').value)) { $('#save-name').textContent = 'Saved'; renderBoards(); } });

/* ---------- start ---------- */
(async function init() {
  st = await api.state();
  if (st.platform === 'darwin') document.body.classList.add('mac');
  renderAccounts();
  initSettings();
  $('#my-name').value = st.settings.playerName || '';
  if (st.accounts.selected) $('#name-group').hidden = true;
  loadLive();
  setInterval(loadLive, 60000);
  loadPack();
  loadNews(false);
  if (st.settings.firstRun) {
    await api.setSettings({ firstRun: false });
    if (st.platform !== 'darwin') api.createShortcuts(true);
    setTimeout(pinDialog, 1200);
  }
  if (st.gameRunning) setBusy(true, 'Playing Create Economy');
})();

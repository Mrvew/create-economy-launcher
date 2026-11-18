// Keeps the game folder in line with pack.json from the pack's GitHub repository.
//  - mods: always exactly what the pack lists (checked by SHA-1). Mods the player added themselves are left alone.
//  - "managed" files (config, kubejs, shaders): written when missing, and replaced only when the pack
//    changes that file, so a player's own tweaks survive until the server changes the same file.
//  - "once" files (options.txt, servers.dat): only written on the first install.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { fetchJson, download, pool, exists, sha1File } = require('./net');

const STATE = '.ce-pack-state.json';

function rawBase(ref) {
  if (config.PACK_BASE_URL) return config.PACK_BASE_URL.replace(/\/?$/, '/');
  return `https://raw.githubusercontent.com/${config.PACK_REPO}/${ref}/`;
}

/** Latest manifest. Uses the newest commit id so GitHub's 5-minute raw cache can't serve an old copy. */
async function fetchManifest(cacheDir) {
  const cacheFile = path.join(cacheDir, 'pack.json');
  try {
    let ref = config.PACK_BRANCH;
    if (!config.PACK_BASE_URL) {
      try {
        const c = await fetchJson(`https://api.github.com/repos/${config.PACK_REPO}/commits/${config.PACK_BRANCH}`,
          { headers: { Accept: 'application/vnd.github+json' } }, 1);
        if (c && c.sha) ref = c.sha;
      } catch { /* rate limited: the branch name still works */ }
    }
    const m = await fetchJson(rawBase(ref) + 'pack.json');
    if (!m || m.format !== 1 || !Array.isArray(m.files)) throw new Error('pack.json is not a Create Economy pack');
    m._base = rawBase(ref);
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, JSON.stringify(m));
    return { manifest: m, offline: false };
  } catch (e) {
    if (await exists(cacheFile)) {
      return { manifest: JSON.parse(await fsp.readFile(cacheFile, 'utf8')), offline: true, error: e };
    }
    throw new Error('Could not reach the Create Economy update server and there is no saved copy yet. Check your internet connection.\n(' + e.message + ')');
  }
}

function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Refusing unsafe path in pack: ' + rel);
  return full;
}

async function readState(gameDir) {
  try { return JSON.parse(await fsp.readFile(path.join(gameDir, STATE), 'utf8')); } catch { return { files: {} }; }
}

/** Is the installed pack up to date with this manifest? (Fast check, no hashing.) */
async function needsSync(gameDir, m) {
  const st = await readState(gameDir);
  return st.version !== m.version || st.released !== m.released;
}

async function sync(gameDir, m, progress, { repair = false } = {}) {
  await fsp.mkdir(gameDir, { recursive: true });
  const state = await readState(gameDir);
  const prev = state.files || {};
  const next = {};
  const jobs = [];
  const listed = new Set();

  progress({ stage: 'pack', text: 'Checking the Create Economy pack' });
  for (const f of m.files) {
    const dest = safeJoin(gameDir, f.path);
    listed.add(f.path);
    const urls = [...(f.urls || [])];
    if (f.repo) urls.push(m._base + f.repo.split('/').map(encodeURIComponent).join('/'));
    const job = { urls, dest, sha1: f.sha1, size: f.size, path: f.path };
    const have = await exists(dest);
    const mode = f.mode || 'mod';
    if (mode === 'once') {
      if (!have && !prev[f.path]) jobs.push(job);
      next[f.path] = f.sha1;
      continue;
    }
    if (mode === 'managed') {
      if (!have) jobs.push(job);
      else if (prev[f.path] !== f.sha1) {
        // The pack changed this file: replace it unless the local copy already matches.
        if ((await sha1File(dest)) !== f.sha1) jobs.push(job);
      }
      next[f.path] = f.sha1;
      continue;
    }
    // Mods: must match exactly.
    if (!have) jobs.push(job);
    else {
      const st = await fsp.stat(dest);
      const known = prev[f.path];
      const trusted = !repair && known === f.sha1 && state.sizes && state.sizes[f.path] === st.size
        && state.mtimes && state.mtimes[f.path] === Math.floor(st.mtimeMs);
      if (!trusted && (st.size !== f.size || (await sha1File(dest)) !== f.sha1)) jobs.push(job);
    }
    next[f.path] = f.sha1;
  }

  // Files the pack used to have but dropped.
  for (const [rel, sha] of Object.entries(prev)) {
    if (listed.has(rel)) continue;
    let dest;
    try { dest = safeJoin(gameDir, rel); } catch { continue; }
    if (!(await exists(dest))) continue;
    if (rel.startsWith('mods/') || (await sha1File(dest)) === sha) {
      await fsp.rm(dest, { force: true });
    }
  }

  const total = jobs.reduce((s, j) => s + (j.size || 0), 0);
  let done = 0;
  let count = 0;
  await pool(jobs, 8, async (j) => {
    await download(j, (n) => {
      done += n;
      progress({ stage: 'pack', text: `Downloading pack files (${count}/${jobs.length})`, done, total });
    });
    count++;
  });

  const sizes = {};
  const mtimes = {};
  for (const f of m.files) {
    if (f.mode) continue;
    const st = await fsp.stat(safeJoin(gameDir, f.path));
    sizes[f.path] = st.size;
    mtimes[f.path] = Math.floor(st.mtimeMs);
  }
  await fsp.writeFile(path.join(gameDir, STATE), JSON.stringify({
    version: m.version, released: m.released, files: next, sizes, mtimes,
  }));
  return { downloaded: jobs.length };
}

module.exports = { fetchManifest, sync, needsSync, readState };

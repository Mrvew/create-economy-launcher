// Installs Minecraft + NeoForge (through NeoForge's own installer) and builds the launch command.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { fetchJson, download, pool, exists, sha1File } = require('./net');

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

function rulesAllow(rules, features = {}) {
  if (!rules || !rules.length) return true;
  let allow = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== osName()) match = false;
      if (r.os.arch && !(r.os.arch === 'x86' ? os.arch() === 'ia32' : r.os.arch === os.arch())) match = false;
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allow = r.action === 'allow';
  }
  return allow;
}

function libPath(name) {
  // group:artifact:version[:classifier][@ext]
  let ext = 'jar';
  let n = name;
  const at = n.indexOf('@');
  if (at >= 0) { ext = n.slice(at + 1); n = n.slice(0, at); }
  const [g, a, v, c] = n.split(':');
  return path.join(...g.split('.'), a, v, `${a}-${v}${c ? '-' + c : ''}.${ext}`);
}

async function readVersion(mcDir, id) {
  const file = path.join(mcDir, 'versions', id, id + '.json');
  const v = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!v.inheritsFrom) return v;
  const parent = await readVersion(mcDir, v.inheritsFrom);
  return {
    ...parent,
    ...v,
    id: v.id,
    jarId: parent.jarId || parent.id,
    libraries: [...(v.libraries || []), ...(parent.libraries || [])],
    arguments: {
      game: [...((parent.arguments || {}).game || []), ...((v.arguments || {}).game || [])],
      jvm: [...((parent.arguments || {}).jvm || []), ...((v.arguments || {}).jvm || [])],
    },
    assetIndex: parent.assetIndex,
    assets: parent.assets,
    downloads: parent.downloads,
    logging: parent.logging,
    javaVersion: v.javaVersion || parent.javaVersion,
  };
}

async function ensureVanillaJson(mcDir, mcVersion) {
  const file = path.join(mcDir, 'versions', mcVersion, mcVersion + '.json');
  if (await exists(file)) return;
  const m = await fetchJson(VERSION_MANIFEST);
  const v = m.versions.find((x) => x.id === mcVersion);
  if (!v) throw new Error('Unknown Minecraft version ' + mcVersion);
  await download({ urls: [v.url], dest: file, sha1: v.sha1 });
}

/** Java component needed by a Minecraft version, e.g. java-runtime-delta. */
async function javaComponentFor(mcDir, mcVersion) {
  await ensureVanillaJson(mcDir, mcVersion);
  const v = JSON.parse(await fsp.readFile(path.join(mcDir, 'versions', mcVersion, mcVersion + '.json'), 'utf8'));
  return (v.javaVersion && v.javaVersion.component) || 'java-runtime-delta';
}

/** Runs the official NeoForge installer headless into mcDir (only when that version is missing). */
async function ensureNeoForge(mcDir, javaConsole, neoVersion, progress, log) {
  const id = 'neoforge-' + neoVersion;
  const vjson = path.join(mcDir, 'versions', id, id + '.json');
  if (await exists(vjson)) {
    // Only NeoForge's own libraries: vanilla ones are downloaded later by ensureGameFiles.
    const own = JSON.parse(await fsp.readFile(vjson, 'utf8'));
    if (await librariesPresent(mcDir, own)) return id;
  }
  progress({ stage: 'loader', text: 'Installing NeoForge ' + neoVersion });
  const cache = path.join(mcDir, '.installers');
  const jar = path.join(cache, `neoforge-${neoVersion}-installer.jar`);
  if (!(await exists(jar))) {
    await download({ urls: [`${NEOFORGE_MAVEN}/${neoVersion}/neoforge-${neoVersion}-installer.jar`], dest: jar });
  }
  const profiles = path.join(mcDir, 'launcher_profiles.json');
  if (!(await exists(profiles))) await fsp.writeFile(profiles, JSON.stringify({ profiles: {} }));
  await new Promise((resolve, reject) => {
    const p = spawn(javaConsole, ['-jar', jar, '--install-client', mcDir], { cwd: cache, windowsHide: true });
    let tail = [];
    const onLine = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
        log(line);
        const m = line.match(/^\s*(Downloading library|Considering library|Processor|MainClass|Extracting|Task)[^]*$/i);
        if (m) progress({ stage: 'loader', text: 'Installing NeoForge: ' + line.trim().slice(0, 80) });
      }
    };
    p.stdout.on('data', onLine);
    p.stderr.on('data', onLine);
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('NeoForge installer failed (exit ' + code + '):\n' + tail.slice(-8).join('\n')));
    });
  });
  if (!(await exists(vjson))) throw new Error('NeoForge installer finished but ' + id + ' is missing');
  return id;
}

async function librariesPresent(mcDir, v) {
  for (const lib of v.libraries) {
    if (!rulesAllow(lib.rules)) continue;
    const a = lib.downloads && lib.downloads.artifact;
    const rel = a && a.path ? a.path : libPath(lib.name);
    if (!(await exists(path.join(mcDir, 'libraries', rel)))) return false;
  }
  return true;
}

/** Libraries, client jar, asset index + objects, logging config. `deep` re-hashes everything. */
async function ensureGameFiles(mcDir, v, progress, deep = false) {
  const jobs = [];
  for (const lib of v.libraries) {
    if (!rulesAllow(lib.rules)) continue;
    const a = lib.downloads && lib.downloads.artifact;
    if (!a || !a.url) continue; // made by the installer's processors
    jobs.push({ urls: [a.url], dest: path.join(mcDir, 'libraries', a.path || libPath(lib.name)), sha1: a.sha1, size: a.size });
  }
  const jarId = v.jarId || v.id;
  if (v.downloads && v.downloads.client) {
    const c = v.downloads.client;
    jobs.push({ urls: [c.url], dest: path.join(mcDir, 'versions', jarId, jarId + '.jar'), sha1: c.sha1, size: c.size });
  }
  if (v.logging && v.logging.client && v.logging.client.file) {
    const f = v.logging.client.file;
    jobs.push({ urls: [f.url], dest: path.join(mcDir, 'assets', 'log_configs', f.id), sha1: f.sha1, size: f.size });
  }
  const idxFile = path.join(mcDir, 'assets', 'indexes', v.assetIndex.id + '.json');
  if (!(await exists(idxFile)) || (deep && (await sha1File(idxFile)) !== v.assetIndex.sha1)) {
    await download({ urls: [v.assetIndex.url], dest: idxFile, sha1: v.assetIndex.sha1 });
  }
  const idx = JSON.parse(await fsp.readFile(idxFile, 'utf8'));
  const seen = new Set();
  for (const o of Object.values(idx.objects)) {
    if (seen.has(o.hash)) continue;
    seen.add(o.hash);
    const sub = o.hash.slice(0, 2) + '/' + o.hash;
    jobs.push({ urls: ['https://resources.download.minecraft.net/' + sub], dest: path.join(mcDir, 'assets', 'objects', sub), sha1: o.hash, size: o.size });
  }

  progress({ stage: 'game', text: 'Checking game files' });
  const missing = [];
  await pool(jobs, 32, async (j) => {
    try {
      const st = await fsp.stat(j.dest);
      if (j.size && st.size !== j.size) return missing.push(j);
      if (deep && j.sha1 && (await sha1File(j.dest)) !== j.sha1) return missing.push(j);
    } catch {
      missing.push(j);
    }
  });
  if (!missing.length) return;
  const total = missing.reduce((s, j) => s + (j.size || 0), 0);
  let done = 0;
  let files = 0;
  await pool(missing, 16, async (j) => {
    await download(j, (n) => {
      done += n;
      progress({ stage: 'game', text: `Downloading Minecraft files (${files}/${missing.length})`, done, total });
    });
    files++;
  });
}

function substitute(arg, vars) {
  return arg.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

function collectArgs(list, features, vars) {
  const out = [];
  for (const a of list || []) {
    if (typeof a === 'string') { out.push(substitute(a, vars)); continue; }
    if (!rulesAllow(a.rules, features)) continue;
    const vals = Array.isArray(a.value) ? a.value : [a.value];
    for (const x of vals) out.push(substitute(x, vars));
  }
  return out;
}

/**
 * Build the java command line.
 * opts: {mcDir, gameDir, account:{name, uuid, token, xuid}, memoryMB, join: 'host:port' | null,
 *        width, height, extraJvm: []}
 */
function buildCommand(v, opts) {
  const sep = process.platform === 'win32' ? ';' : ':';
  const libDir = path.join(opts.mcDir, 'libraries');
  const cp = [];
  const seen = new Set();
  for (const lib of v.libraries) {
    if (!rulesAllow(lib.rules)) continue;
    const a = lib.downloads && lib.downloads.artifact;
    const rel = a && a.path ? a.path : libPath(lib.name);
    const full = path.join(libDir, rel);
    // Same library listed twice (NeoForge and vanilla): first one wins.
    const key = lib.name.split(':').slice(0, 2).join(':') + (lib.name.split(':')[3] ? ':' + lib.name.split(':')[3] : '');
    if (seen.has(key)) continue;
    seen.add(key);
    cp.push(full);
  }
  // Loader versions (NeoForge) load Minecraft from their own patched jar in libraries/;
  // the vanilla jar on the classpath would clash with it. Plain versions need it.
  const ownJar = path.join(opts.mcDir, 'versions', v.id, v.id + '.jar');
  if (!v.inheritsFrom) cp.push(path.join(opts.mcDir, 'versions', v.id, v.id + '.jar'));
  else if (fs.existsSync(ownJar) && fs.statSync(ownJar).size > 0) cp.push(ownJar);
  const natives = path.join(opts.mcDir, 'versions', v.id, 'natives');
  fs.mkdirSync(natives, { recursive: true });

  const join = opts.join || null;
  const features = {
    is_demo_user: false,
    has_custom_resolution: !!(opts.width && opts.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: !!join,
    is_quick_play_realms: false,
  };
  const vars = {
    auth_player_name: opts.account.name,
    version_name: v.id,
    game_directory: opts.gameDir,
    assets_root: path.join(opts.mcDir, 'assets'),
    game_assets: path.join(opts.mcDir, 'assets'),
    assets_index_name: v.assetIndex.id,
    auth_uuid: opts.account.uuid,
    auth_access_token: opts.account.token,
    auth_session: opts.account.token,
    clientid: opts.account.clientId || '',
    auth_xuid: opts.account.xuid || '',
    user_type: 'msa',
    user_properties: '{}',
    version_type: 'Create Economy',
    natives_directory: natives,
    launcher_name: 'create-economy-launcher',
    launcher_version: opts.launcherVersion || '1.0.0',
    classpath: cp.join(sep),
    classpath_separator: sep,
    library_directory: libDir,
    resolution_width: String(opts.width || 1280),
    resolution_height: String(opts.height || 720),
    quickPlayMultiplayer: join || '',
    quickPlayPath: 'quickplay/log.json',
  };

  const mem = Math.max(2048, opts.memoryMB | 0);
  const jvm = [
    `-Xmx${mem}M`,
    `-Xms${Math.min(mem, 2048)}M`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:G1NewSizePercent=30',
    '-XX:G1MaxNewSizePercent=40',
    '-XX:G1HeapRegionSize=8M',
    '-XX:G1ReservePercent=20',
    '-Dfml.ignoreInvalidMinecraftCertificates=true',
    '-Dcelauncher.desktop=true',
    ...(opts.extraJvm || []),
  ];
  if (v.arguments && v.arguments.jvm && v.arguments.jvm.length) {
    jvm.push(...collectArgs(v.arguments.jvm, features, vars));
  } else {
    jvm.push(`-Djava.library.path=${natives}`, '-cp', vars.classpath);
  }
  if (v.logging && v.logging.client && v.logging.client.argument) {
    jvm.push(v.logging.client.argument.replace('${path}', path.join(opts.mcDir, 'assets', 'log_configs', v.logging.client.file.id)));
  }
  let game = collectArgs(v.arguments && v.arguments.game, features, vars);
  if (join && !game.includes('--quickPlayMultiplayer')) {
    // Fallback for versions without the quick play rule.
    const [host, port] = join.split(':');
    game.push('--server', host, '--port', port || '25565');
  }
  return [...jvm, v.mainClass, ...game];
}

module.exports = {
  readVersion, ensureVanillaJson, ensureNeoForge, ensureGameFiles, buildCommand, javaComponentFor, rulesAllow,
};

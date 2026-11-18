// Installs Mojang's own Java runtime (the same one the official launcher uses).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { fetchJson, download, pool, exists } = require('./net');

const ALL = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';

function platformKey() {
  const a = os.arch();
  if (process.platform === 'win32') return a === 'arm64' ? 'windows-arm64' : a === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return a === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return a === 'ia32' ? 'linux-i386' : 'linux';
}

function javaBinary(home) {
  if (process.platform === 'win32') return path.join(home, 'bin', 'javaw.exe');
  if (process.platform === 'darwin') return path.join(home, 'jre.bundle', 'Contents', 'Home', 'bin', 'java');
  return path.join(home, 'bin', 'java');
}

/** Console java (for the NeoForge installer: javaw has no stdout on Windows). */
function javaConsoleBinary(home) {
  if (process.platform === 'win32') return path.join(home, 'bin', 'java.exe');
  return javaBinary(home);
}

/**
 * Make sure the runtime `component` (e.g. java-runtime-delta for Java 21) is installed.
 * Returns {java, javaConsole, home}.
 */
async function ensureJava(runtimeDir, component, progress) {
  const home = path.join(runtimeDir, component, platformKey());
  const stamp = path.join(home, '.installed');
  if (await exists(stamp) && await exists(javaBinary(home))) {
    return { java: javaBinary(home), javaConsole: javaConsoleBinary(home), home };
  }
  progress({ stage: 'java', text: 'Getting Java ready' });
  const all = await fetchJson(ALL);
  const entry = (all[platformKey()] || {})[component];
  if (!entry || !entry.length) throw new Error(`Mojang has no ${component} Java for ${platformKey()}`);
  const manifest = await fetchJson(entry[0].manifest.url);
  const files = Object.entries(manifest.files);
  const jobs = [];
  for (const [rel, f] of files) {
    const dest = path.join(home, rel);
    if (f.type === 'directory') { await fsp.mkdir(dest, { recursive: true }); continue; }
    if (f.type === 'file') jobs.push({ rel, f, dest });
  }
  const total = jobs.reduce((s, j) => s + j.f.downloads.raw.size, 0);
  let done = 0;
  await pool(jobs, 8, async (j) => {
    const raw = j.f.downloads.raw;
    if (await exists(j.dest)) {
      const st = await fsp.stat(j.dest);
      if (st.size === raw.size) { done += raw.size; return; }
    }
    await download({ urls: [raw.url], dest: j.dest, sha1: raw.sha1 }, (n) => {
      done += n;
      progress({ stage: 'java', text: 'Downloading Java', done, total });
    });
    if (j.f.executable && process.platform !== 'win32') await fsp.chmod(j.dest, 0o755);
  });
  for (const [rel, f] of files) {
    if (f.type !== 'link' || process.platform === 'win32') continue;
    const dest = path.join(home, rel);
    await fsp.rm(dest, { force: true });
    await fsp.symlink(f.target, dest).catch(() => {});
  }
  await fsp.writeFile(stamp, entry[0].version.name);
  return { java: javaBinary(home), javaConsole: javaConsoleBinary(home), home };
}

module.exports = { ensureJava };

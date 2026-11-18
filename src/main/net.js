// Downloads with SHA-1 checks, retries, mirrors and a small worker pool.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const DEBUG = process.env.CE_DEBUG ? (m) => fs.appendFileSync(process.env.CE_DEBUG, `[${new Date().toISOString()}] ${m}
`) : () => {};
// Electron's net.fetch (Chromium network stack, system proxy aware). Node's own fetch can hang
// inside Electron's main process, so it is only used when running outside Electron (tests).
let netFetch = null;
try { netFetch = require('electron').net.fetch; } catch { /* plain node */ }
const doFetch = (url, opts) => (netFetch ? netFetch(url, opts) : fetch(url, opts));
const UA = 'CreateEconomyLauncher/' + (process.env.npm_package_version || '1');

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await doFetch(url, { ...opts, signal: ctl.signal, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchWithTimeout(url, opts);
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        const err = new Error(`HTTP ${r.status} for ${url}`);
        err.status = r.status;
        err.body = body;
        if (r.status >= 400 && r.status < 500) throw err; // no point retrying
        last = err;
      } else {
        return await r.json();
      }
    } catch (e) {
      last = e;
      if (e.status && e.status < 500) throw e;
    }
    await new Promise((res) => setTimeout(res, 600 * (i + 1)));
  }
  throw last;
}

async function sha1File(file) {
  const h = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

/**
 * Download one file. item: {urls: [..], dest, sha1?, size?}
 * onBytes(n) is called with each chunk length (negative to undo a failed attempt).
 * A transfer that sends nothing for 30 s is aborted and retried (next mirror first).
 */
async function download(item, onBytes = () => {}) {
  const urls = item.urls.filter(Boolean);
  if (!urls.length) throw new Error('No download address for ' + path.basename(item.dest));
  await fsp.mkdir(path.dirname(item.dest), { recursive: true });
  const tmp = item.dest + '.part';
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of urls) {
      let got = 0;
      const ctl = new AbortController();
      let idle = setTimeout(() => ctl.abort(new Error('stalled')), 30000);
      const poke = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(new Error('stalled')), 30000); };
      let fh = null;
      try {
        DEBUG('GET ' + url);
        const r = await doFetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA } });
        DEBUG('HDR ' + r.status + ' ' + url);
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status} for ${url}`);
        const h = crypto.createHash('sha1');
        fh = await fsp.open(tmp, 'w');
        // Per-read timeout, and stop at the expected length.
        const expected = Number(r.headers.get('content-length')) || item.size || 0;
        const reader = r.body.getReader();
        try {
          for (;;) {
            let timer;
            const res = await Promise.race([
              reader.read(),
              new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Download stalled: ' + path.basename(item.dest))), 30000); }),
            ]).finally(() => clearTimeout(timer));
            if (res.done) break;
            poke();
            const buf = Buffer.from(res.value);
            h.update(buf);
            await fh.write(buf);
            got += buf.length;
            onBytes(buf.length);
            if (expected && got >= expected) break;
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        await fh.close();
        fh = null;
        const sum = h.digest('hex');
        if (item.sha1 && sum !== item.sha1.toLowerCase()) throw new Error(`Checksum mismatch for ${path.basename(item.dest)} from ${new URL(url).host}`);
        await fsp.rm(item.dest, { force: true });
        await fsp.rename(tmp, item.dest);
        DEBUG('OK ' + got + ' ' + url);
        return;
      } catch (e) {
        onBytes(-got);
        lastErr = e;
        DEBUG('FAIL ' + url + ' ' + e);
      } finally {
        clearTimeout(idle);
        if (fh) await fh.close().catch(() => {});
      }
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw lastErr;
}

/** Run async jobs with at most n at a time. Stops on the first error. */
async function pool(items, n, worker) {
  let i = 0;
  let failed = null;
  const runners = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (!failed && i < items.length) {
      const it = items[i++];
      try { await worker(it); } catch (e) { failed = failed || e; }
    }
  });
  await Promise.all(runners);
  if (failed) throw failed;
}

module.exports = { fetchWithTimeout, fetchJson, download, pool, sha1File, exists, UA };

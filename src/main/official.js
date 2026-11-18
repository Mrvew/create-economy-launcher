// Sign-in through the official Minecraft Launcher (players are already signed in there, and it is
// approved by Mojang): put a "Create Economy" profile into it, pointing at our game folder,
// select it, and open the launcher. Used whenever this build has no Azure app of its own.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { exists } = require('./net');

function officialDir() {
  if (process.env.CE_OFFICIAL_DIR && !require('electron').app.isPackaged) return process.env.CE_OFFICIAL_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', '.minecraft');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(os.homedir(), '.minecraft');
}

async function addProfile({ versionId, gameDir, memoryMB, iconPng }) {
  const dir = officialDir();
  const file = path.join(dir, 'launcher_profiles.json');
  let data = { profiles: {} };
  if (await exists(file)) {
    try { data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* keep default */ }
    await fsp.copyFile(file, file + '.ce-backup').catch(() => {});
  } else {
    await fsp.mkdir(dir, { recursive: true });
  }
  // A future lastUsed keeps Create Economy selected when the launcher opens.
  data.profiles = data.profiles || {};
  const now = new Date().toISOString();
  data.profiles['create-economy'] = {
    ...(data.profiles['create-economy'] || {}),
    name: 'Create Economy',
    type: 'custom',
    lastVersionId: versionId,
    gameDir,
    icon: 'data:image/png;base64,' + iconPng.toString('base64'),
    javaArgs: `-Xmx${memoryMB}M -Xms2048M -XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=30 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=200`,
    lastUsed: new Date(Date.now() + 60000).toISOString(),
    created: (data.profiles['create-economy'] || {}).created || now,
  };
  data.selectedProfile = 'create-economy'; // older launchers
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
  return dir;
}

/** Is the official Minecraft Launcher installed and used at least once? */
async function installed() {
  return exists(path.join(officialDir(), 'launcher_profiles.json'));
}

async function openOfficialLauncher() {
  if (process.env.CE_NO_OPEN && !require('electron').app.isPackaged) return true;
  if (process.platform === 'win32') {
    // Microsoft Store / Xbox app version, then the old .exe locations.
    const exes = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Minecraft Launcher', 'MinecraftLauncher.exe'),
    ];
    for (const e of exes) if (await exists(e)) { spawn(e, [], { detached: true, stdio: 'ignore' }).unref(); return true; }
    spawn('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (process.platform === 'darwin') {
    spawn('open', ['-a', 'Minecraft'], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  for (const cmd of ['minecraft-launcher', 'minecraft']) {
    try { spawn(cmd, [], { detached: true, stdio: 'ignore' }).unref(); return true; } catch { /* try next */ }
  }
  await shell.openExternal('https://www.minecraft.net/download');
  return false;
}

module.exports = { officialDir, addProfile, openOfficialLauncher, installed };

// Desktop / Start menu shortcuts. Windows and macOS don't let apps pin themselves
// to the taskbar/Dock, so the window shows a short how-to for that part.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, shell } = require('electron');
const config = require('./config');

function iconPath() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..', 'build');
  return path.join(base, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
}

function createShortcuts() {
  const made = [];
  if (process.platform === 'win32') {
    const opts = {
      target: process.execPath,
      description: 'Play on the Create Economy server',
      icon: iconPath(), iconIndex: 0,
      appUserModelId: config.APP_ID,
    };
    if (process.env.PORTABLE_EXECUTABLE_FILE) opts.target = process.env.PORTABLE_EXECUTABLE_FILE;
    const places = [
      path.join(app.getPath('desktop'), 'Create Economy.lnk'),
      path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Create Economy.lnk'),
    ];
    for (const p of places) {
      if (shell.writeShortcutLink(p, fs.existsSync(p) ? 'replace' : 'create', opts)) made.push(p);
    }
  } else if (process.platform === 'linux') {
    const exec = process.env.APPIMAGE || process.execPath;
    const desktop = `[Desktop Entry]\nType=Application\nName=Create Economy\nComment=Play on the Create Economy server\nExec="${exec}" %U\nIcon=${iconPath()}\nTerminal=false\nCategories=Game;\nStartupWMClass=Create Economy Launcher\n`;
    const dir = path.join(os.homedir(), '.local', 'share', 'applications');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'create-economy.desktop');
    fs.writeFileSync(p, desktop, { mode: 0o755 });
    made.push(p);
  }
  // macOS: the .app in Applications is the shortcut; the Dock part is the user's click.
  return made;
}

module.exports = { createShortcuts, iconPath };

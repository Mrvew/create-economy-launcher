// Everything a server owner would change lives here.
const path = require('path');
const os = require('os');
const { app } = require('electron');

const env = process.env;
let baked = {};
try { baked = require('./baked.json'); } catch { /* dev build */ }

module.exports = {
  // Public GitHub repository that holds pack.json (built by ce-pack-repo/tools/build_pack.py).
  PACK_REPO: env.CE_PACK_REPO || 'Mrvew/create-economy-pack',
  PACK_BRANCH: env.CE_PACK_BRANCH || 'main',
  // For testing: a base URL that serves the repository files directly (e.g. http://127.0.0.1:8765/).
  PACK_BASE_URL: (!app.isPackaged && env.CE_PACK_BASE_URL) || '',

  // Microsoft (Azure) app used for "Sign in with Microsoft".
  // It must be a "Personal Microsoft accounts" public client with the redirect URI
  // https://login.microsoftonline.com/common/oauth2/nativeclient and it must be approved
  // by Mojang for the Minecraft API (https://aka.ms/mce-reviewappid).
  MS_CLIENT_ID: env.CE_MS_CLIENT_ID || baked.MS_CLIENT_ID || '',

  WEBSITE: 'https://create-economy.net',
  LIVE_URL: 'https://create-economy.net/data/live.json',
  NEWS_URL: 'https://create-economy.net/data/discord.json',
  DISCORD_INVITE: 'https://discord.gg/nMjPey4Wny',
  SERVER_ADDRESS: 'play.create-economy.net',

  APP_ID: 'net.create-economy.launcher',

  dataDir() {
    const base = env.CE_DATA_DIR || path.join(app.getPath('appData'), 'CreateEconomy');
    return base;
  },
  paths() {
    const root = this.dataDir();
    return {
      root,
      runtime: path.join(root, 'runtime'),
      minecraft: path.join(root, 'minecraft'),   // versions, libraries, assets (shared)
      instance: path.join(root, 'instance'),     // the game folder: mods, config, saves
      cache: path.join(root, 'cache'),
      logs: path.join(root, 'logs'),
      settings: path.join(root, 'launcher-settings.json'),
      accounts: path.join(root, 'accounts.dat'),
    };
  },
  platform() {
    const p = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const arch = os.arch();
    return { os: p, arch };
  },
};

const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('ce', {
  state: call('state'),
  pack: call('pack'),
  live: call('live'),
  news: call('news'),
  skin: call('skin'),
  lookup: call('lookup'),
  signIn: call('signin'),
  selectAccount: call('account:select'),
  removeAccount: call('account:remove'),
  play: call('play'),
  playOfficial: call('play:official'),
  getOfficial: call('official:get'),
  repair: call('repair'),
  setSettings: call('settings'),
  createShortcuts: call('shortcuts'),
  open: call('open'),
  url: call('url'),
  win: call('win'),
  installUpdate: call('update:install'),
  updatePage: call('update:page'),
  kill: call('kill'),
  onProgress: on('progress'),
  onGame: on('game'),
  onUpdate: on('update'),
  onWindow: on('window'),
});

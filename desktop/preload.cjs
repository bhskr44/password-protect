// The only bridge between the window and the system.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  takePending: call('take-pending'),
  pick: call('pick'),
  describe: call('describe'),
  lock: call('lock'),
  unlock: call('unlock'),
  verify: call('verify'),
  extract: call('extract'),
  hash: call('hash'),
  history: call('history'),
  showItem: call('show-item'),
  copy: call('copy'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onOpenPaths: (listener) => ipcRenderer.on('open-paths', (_event, paths) => listener(paths)),
});

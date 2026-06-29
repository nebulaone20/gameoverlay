const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveCalibration: (partial) => ipcRenderer.invoke('save-calibration', partial),
  sendHealthUpdate: (data) => ipcRenderer.send('health-update', data),
});
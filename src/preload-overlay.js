const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onHealthUpdate: (callback) => {
    ipcRenderer.on('health-update', (event, data) => callback(data));
  },
  onAgentUpdate: (callback) => {
    ipcRenderer.on('agent-update', (event, data) => callback(data));
  },
});

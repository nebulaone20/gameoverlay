const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveCalibration: (partial) => ipcRenderer.invoke('save-calibration', partial),
  sendHealthUpdate: (data) => ipcRenderer.send('health-update', data),

  // Agent icon template matching - icons are fetched/cached automatically
  // by main.js at startup (see agentDataFetcher.js); the capture renderer
  // just consumes the cached set.
  sendAgentUpdate: (data) => ipcRenderer.send('agent-update', data),
  listAgentIcons: () => ipcRenderer.invoke('list-agent-icons'),
  loadAgentIcons: () => ipcRenderer.invoke('load-agent-icons'),
  getAgentIconStatus: () => ipcRenderer.invoke('get-agent-icon-status'),
  refreshAgentIcons: () => ipcRenderer.invoke('refresh-agent-icons'),
  saveDebugCrop: (label, dataUrl) => ipcRenderer.invoke('save-debug-crop', { label, dataUrl }),
});

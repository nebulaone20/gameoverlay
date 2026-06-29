const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');

let captureWin;
let overlayWin;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function createCaptureWindow() {
  // Hidden window. It just runs getUserMedia + canvas pixel sampling.
  // Kept as a real window (not headless) because desktopCapturer + getUserMedia
  // needs a renderer with a compositor.
  captureWin = new BrowserWindow({
    width: 1920,
    height: 1080,
    resizable: true,
    maximizable: true,
    show: true, // set to true while calibrating so you can see the calibration overlay; flip to false once tuned
    webPreferences: {
      preload: path.join(__dirname, 'preload-capture.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'capture.html'));
}

function createOverlayWindow() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;

  overlayWin = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false, // prevents it from stealing focus from the game
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true); // click-through
  overlayWin.setAlwaysOnTop(true, 'screen-saver'); // sits above fullscreen exclusive/borderless games
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
}

app.whenReady().then(() => {
  createCaptureWindow();
  createOverlayWindow();
});

// --- IPC ---

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  // thumbnail is a NativeImage - convert to a data URL so it can cross into the renderer
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-calibration', (event, partialConfig) => {
  const cfg = loadConfig();
  Object.assign(cfg, partialConfig);
  saveConfig(cfg);
  return cfg;
});

// Capture window -> relay parsed health data -> overlay window
ipcMain.on('health-update', (event, data) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('health-update', data);
  }
});

app.on('window-all-closed', () => app.quit());
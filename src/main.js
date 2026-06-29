const { app, BrowserWindow, ipcMain, desktopCapturer, screen, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ensureAgentIcons } = require('./agentDataFetcher');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const AGENTS_DIR = path.join(__dirname, '..', 'assets', 'agents');
const DEBUG_DIR = path.join(__dirname, '..', 'debug');

let captureWin;
let overlayWin;
let agentIconStatus = { updated: false, agentNames: [], error: null }; // populated at startup, exposed via IPC

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
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

app.whenReady().then(async () => {
  agentIconStatus = await ensureAgentIcons(AGENTS_DIR);
  if (agentIconStatus.error) {
    console.warn('[agent icons]', agentIconStatus.error);
  }
  console.log(`[agent icons] ${agentIconStatus.agentNames.length} icon(s) ready`, agentIconStatus.updated ? '(freshly fetched)' : '(from cache)');

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

// Capture window -> relay parsed agent-icon data -> overlay window
ipcMain.on('agent-update', (event, data) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('agent-update', data);
  }
});

// --- Agent reference icon library ---
// Icons are fetched automatically from valorant-api.com at startup and
// cached to assets/agents/*.png (see agentDataFetcher.js) - no manual
// cropping/calibration needed for this part.

ipcMain.handle('get-agent-icon-status', () => agentIconStatus);

// Lets the capture window force a fresh pull from valorant-api.com (e.g.
// after a new agent drops) without restarting the whole app.
ipcMain.handle('refresh-agent-icons', async () => {
  agentIconStatus = await ensureAgentIcons(AGENTS_DIR, { force: true });
  return agentIconStatus;
});

ipcMain.handle('list-agent-icons', () => {
  ensureAgentsDir();
  return fs
    .readdirSync(AGENTS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .map((f) => f.replace(/\.png$/i, ''));
});

// Renderer can't read arbitrary files itself (contextIsolation, no fs exposed),
// so main reads each reference icon and hands back raw RGBA pixel data
// the capture renderer can compare against directly.
ipcMain.handle('load-agent-icons', () => {
  ensureAgentsDir();
  const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
  return files.map((f) => {
    const img = nativeImage.createFromPath(path.join(AGENTS_DIR, f));
    const { width, height } = img.getSize();
    const bitmap = img.toBitmap(); // BGRA on most platforms via Electron's NativeImage
    return {
      name: f.replace(/\.png$/i, ''),
      width,
      height,
      // Send as a plain array; preload's contextBridge can structurally clone
      // typed arrays fine, but plain arrays are the safest cross-version bet.
      pixels: Array.from(bitmap),
    };
  });
});

app.on('window-all-closed', () => app.quit());

// --- Debug: dump a captured crop to disk so it can be visually inspected ---
// (e.g. "is the calibrated region actually landing on a face?")
ipcMain.handle('save-debug-crop', (event, { label, dataUrl }) => {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const safe = String(label).replace(/[^a-z0-9_-]/gi, '');
  const dest = path.join(DEBUG_DIR, `${safe}.png`);
  const img = nativeImage.createFromDataURL(dataUrl);
  fs.writeFileSync(dest, img.toPNG());
  return dest;
});

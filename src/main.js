const { app, BrowserWindow, ipcMain, desktopCapturer, screen, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { ensureAgentIcons } = require('./agentDataFetcher');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const AGENTS_DIR  = path.join(__dirname, '..', 'assets', 'agents');
const DEBUG_DIR   = path.join(__dirname, '..', 'debug');

let captureWin, overlayWin;
let agentIconStatus = { updated: false, agentNames: [], error: null };

// --- Tesseract (runs in main process - no WASM/worker-path issues) ---
// Lazy initialise so app startup isn't blocked.
let Tesseract   = null;
let timerWorker = null;
let scoreWorker = null;

async function getTesseract() {
  if (!Tesseract) Tesseract = require('tesseract.js');
  return Tesseract;
}

async function getTimerWorker() {
  if (timerWorker) return timerWorker;
  const T = await getTesseract();
  timerWorker = await T.createWorker('eng');
  await timerWorker.setParameters({
    tessedit_char_whitelist: '0123456789:OT',
    tessedit_pageseg_mode:   '7',
  });
  return timerWorker;
}

async function getScoreWorker() {
  if (scoreWorker) return scoreWorker;
  const T = await getTesseract();
  scoreWorker = await T.createWorker('eng');
  await scoreWorker.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode:   '7',
  });
  return scoreWorker;
}

// Build a thresholded, upscaled PNG buffer from a raw RGBA pixel array.
// This is the same logic that was in capture-renderer.js, now running in main.
function thresholdToPng(pixels, width, height, scale, brightnessThreshold) {
  // pixels is a plain Array of RGBA bytes (from imageData.data sent over IPC).
  const outW = width  * scale;
  const outH = height * scale;

  // Build an upscaled + thresholded raw pixel buffer, then encode via nativeImage.
  // nativeImage.createFromBitmap expects raw BGRA on Windows, RGBA on macOS,
  // but toPNG() handles both - we only need any valid RGBA-like buffer here
  // because we immediately convert to PNG and let Tesseract read that.
  const buf = Buffer.alloc(outW * outH * 4);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      // Nearest-neighbour sample from source.
      const sx  = Math.floor(x / scale);
      const sy  = Math.floor(y / scale);
      const src = (sy * width + sx) * 4;
      const brightness = (pixels[src] + pixels[src+1] + pixels[src+2]) / 3;
      const v   = brightness >= brightnessThreshold ? 255 : 0;
      const dst = (y * outW + x) * 4;
      buf[dst]   = v;   // R
      buf[dst+1] = v;   // G
      buf[dst+2] = v;   // B
      buf[dst+3] = 255; // A
    }
  }

  // nativeImage.createFromBitmap needs { width, height } and treats the buffer
  // as BGRA on Windows - but since all channels are equal (greyscale) that
  // doesn't matter, and toPNG() gives Tesseract a clean lossless file.
  const img = nativeImage.createFromBitmap(buf, { width: outW, height: outH });
  return img.toPNG();
}

// --- IPC: OCR requests from capture renderer ---

let timerBusy = false;
let scoreBusy = false;

ipcMain.handle('ocr-timer', async (_, { pixels, width, height }) => {
  if (timerBusy) return null;
  timerBusy = true;
  try {
    const cfg    = loadConfig();
    const tc     = cfg.roundTimer;
    const png    = thresholdToPng(pixels, width, height, tc.scale || 3, tc.brightnessThreshold ?? 150);
    const worker = await getTimerWorker();
    const { data: { text } } = await worker.recognize(png);
    return { text: text.trim() };
  } catch (e) {
    console.error('[ocr-timer]', e.message);
    return null;
  } finally {
    timerBusy = false;
  }
});

ipcMain.handle('ocr-score', async (_, { defPixels, defW, defH, atkPixels, atkW, atkH }) => {
  if (scoreBusy) return null;
  scoreBusy = true;
  try {
    const cfg    = loadConfig();
    const sc     = cfg.roundScore;
    const scale  = sc.scale || 3;
    const thresh = sc.brightnessThreshold ?? 150;
    const worker = await getScoreWorker();
    const [defRes, atkRes] = await Promise.all([
      worker.recognize(thresholdToPng(defPixels, defW, defH, scale, thresh)),
      worker.recognize(thresholdToPng(atkPixels, atkW, atkH, scale, thresh)),
    ]);
    return {
      defText: defRes.data.text.trim(),
      atkText: atkRes.data.text.trim(),
    };
  } catch (e) {
    console.error('[ocr-score]', e.message);
    return null;
  } finally {
    scoreBusy = false;
  }
});

// --- Warm up workers at startup so first tick doesn't stall ---
app.whenReady().then(async () => {
  agentIconStatus = await ensureAgentIcons(AGENTS_DIR);
  if (agentIconStatus.error) console.warn('[agent icons]', agentIconStatus.error);
  console.log(`[agent icons] ${agentIconStatus.agentNames.length} icon(s) ready`);

  // Fire-and-forget worker init - they'll be ready before the first real tick.
  getTimerWorker().catch(e => console.warn('[tesseract timer init]', e.message));
  getScoreWorker().catch(e => console.warn('[tesseract score init]', e.message));

  createCaptureWindow();
  createOverlayWindow();
});

// --- Window creation ---

function createCaptureWindow() {
  captureWin = new BrowserWindow({
    width: 1920, height: 1080, resizable: true, maximizable: true, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-capture.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  captureWin.loadFile(path.join(__dirname, 'capture.html'));
  // Uncomment to open DevTools for debugging:
  // captureWin.webContents.openDevTools();
}

function createOverlayWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlayWin = new BrowserWindow({
    x: 0, y: 0, width, height,
    frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
}

// --- Standard IPC ---

function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
function ensureAgentsDir() { if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true }); }

function relay(channel) {
  ipcMain.on(channel, (_, data) => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, data);
  });
}

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window','screen'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.handle('get-config',        () => loadConfig());
ipcMain.handle('save-calibration',  (_, p) => { const c = loadConfig(); Object.assign(c, p); saveConfig(c); return c; });
ipcMain.handle('get-agent-icon-status', () => agentIconStatus);
ipcMain.handle('refresh-agent-icons',   async () => { agentIconStatus = await ensureAgentIcons(AGENTS_DIR, { force: true }); return agentIconStatus; });

ipcMain.handle('list-agent-icons', () => {
  ensureAgentsDir();
  return fs.readdirSync(AGENTS_DIR).filter(f => f.toLowerCase().endsWith('.png')).map(f => f.replace(/\.png$/i, ''));
});

ipcMain.handle('load-agent-icons', () => {
  ensureAgentsDir();
  return fs.readdirSync(AGENTS_DIR).filter(f => f.toLowerCase().endsWith('.png')).map(f => {
    const img = nativeImage.createFromPath(path.join(AGENTS_DIR, f));
    const { width, height } = img.getSize();
    return { name: f.replace(/\.png$/i, ''), width, height, pixels: Array.from(img.toBitmap()) };
  });
});

ipcMain.handle('save-debug-crop', (_, { label, dataUrl }) => {
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const safe = String(label).replace(/[^a-z0-9_-]/gi, '');
  const dest = path.join(DEBUG_DIR, `${safe}.png`);
  fs.writeFileSync(dest, nativeImage.createFromDataURL(dataUrl).toPNG());
  return dest;
});

relay('health-update');
relay('agent-update');
relay('timer-update');
relay('score-update');

app.on('window-all-closed', () => app.quit());

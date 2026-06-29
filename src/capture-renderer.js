// Runs inside the hidden capture window's renderer process.

let cfg = null;
let video = document.getElementById('preview');
let statusEl = document.getElementById('status');
let fullCanvas = document.getElementById('full');
let fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });

let videoNativeWidth = 0;
let videoNativeHeight = 0;
let lastMouseFull = { x: 0, y: 0 };

// --- Agent icon matching state ---
let agentRefs = [];
let lastAgentResult = null;

// --- Tesseract: one shared worker, lazy-initialised ---
let tesseractWorker = null;
let tesseractReady = false;
let tesseractBusy = false;

async function getTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;
  tesseractWorker = await Tesseract.createWorker('eng', 1, {
    tessedit_char_whitelist: '0123456789:OT',
    tessedit_pageseg_mode: '7', // single text line
  });
  tesseractReady = true;
  return tesseractWorker;
}

// Separate single-digit worker for score numbers (tighter whitelist, faster).
let scoreWorker = null;
let scoreWorkerReady = false;

async function getScoreWorker() {
  if (scoreWorker) return scoreWorker;
  scoreWorker = await Tesseract.createWorker('eng', 1, {
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: '7',
  });
  scoreWorkerReady = true;
  return scoreWorker;
}

// --- Picker / startup ---

async function showPicker() {
  const sources = await window.bridge.getSources();
  const grid = document.getElementById('sourceGrid');
  grid.innerHTML = '';
  for (const s of sources) {
    const item = document.createElement('div');
    item.className = 'source-item';
    item.innerHTML = `<img src="${s.thumbnail}"><div class="name">${s.name}</div>`;
    item.addEventListener('click', () => selectSource(s.id));
    grid.appendChild(item);
  }
}

async function selectSource(sourceId) {
  document.getElementById('picker').style.display = 'none';
  document.getElementById('status').style.display = 'block';
  document.getElementById('preview').style.display = 'block';
  await start(sourceId);
}

async function start(sourceId) {
  cfg = await window.bridge.getConfig();
  await loadAgentReferences();

  // Warm up both workers in background so first tick doesn't stall.
  getTesseractWorker().catch((e) => console.warn('[tesseract timer]', e));
  getScoreWorker().catch((e) => console.warn('[tesseract score]', e));

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
  });

  video.srcObject = stream;
  await video.play();

  videoNativeWidth = video.videoWidth;
  videoNativeHeight = video.videoHeight;
  fullCanvas.width = videoNativeWidth;
  fullCanvas.height = videoNativeHeight;

  printStatus();
  setInterval(tick, cfg.captureIntervalMs || 200);
}

function printStatus(extra) {
  statusEl.textContent =
    `Capturing ${videoNativeWidth}x${videoNativeHeight}\n` +
    `Hover + press C: log x/y for calibration.\n` +
    `Press R: re-fetch agent icons from valorant-api.com.\n` +
    `Press D: dump debug crops (timer, scores, agent row0) to gameoverlay/debug/.\n` +
    `Loaded ${agentRefs.length} agent reference icon(s) (auto-fetched + cached).\n` +
    (extra ? extra + '\n' : '');
}

// --- Calibration ---

video.addEventListener('mousemove', (e) => {
  const rect = video.getBoundingClientRect();
  lastMouseFull.x = Math.round((e.clientX - rect.left) / rect.width * videoNativeWidth);
  lastMouseFull.y = Math.round((e.clientY - rect.top) / rect.height * videoNativeHeight);
});

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'c') {
    const line = `Calibration point -> x:${lastMouseFull.x} y:${lastMouseFull.y}`;
    console.log(line);
    printStatus(line + '\n(press C again over another point)');
  } else if (key === 'r') {
    refreshAgentIcons();
  } else if (key === 'd') {
    dumpDebugCrops();
  }
});

async function dumpDebugCrops() {
  if (!videoNativeWidth || !cfg) { printStatus('Nothing to dump yet.'); return; }
  fullCtx.drawImage(video, 0, 0, videoNativeWidth, videoNativeHeight);

  async function dump(label, x, y, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(fullCanvas, Math.round(x), Math.round(y), w, h, 0, 0, w, h);
    return window.bridge.saveDebugCrop(label, c.toDataURL('image/png'));
  }

  const tc = cfg.roundTimer;
  const sc = cfg.roundScore;
  const ic = cfg.agentIcons;

  const [t, sl, sr, a] = await Promise.all([
    dump('timer_captured',     tc.x, tc.y, tc.width, tc.height),
    dump('score_def_captured', sc.def.x, sc.def.y, sc.def.width, sc.def.height),
    dump('score_atk_captured', sc.atk.x, sc.atk.y, sc.atk.width, sc.atk.height),
    dump('row0_captured',      ic.x, ic.y, ic.iconWidth, ic.iconHeight),
  ]);

  printStatus(`Debug crops saved:\n  ${t}\n  ${sl}\n  ${sr}\n  ${a}\nCheck timer/score crops: digits should be tightly framed, white on dark.`);
}

async function refreshAgentIcons() {
  printStatus('Refetching agent icons...');
  const status = await window.bridge.refreshAgentIcons();
  await loadAgentReferences();
  printStatus(status.error
    ? `Refresh warning: ${status.error}`
    : `Refreshed: ${status.agentNames.length} icon(s).`);
}

async function loadAgentReferences() {
  const raw = await window.bridge.loadAgentIcons();
  agentRefs = raw.map((r) => ({
    name: r.name,
    width: r.width,
    height: r.height,
    histogram: buildHistogramFromBitmap(r.pixels, r.width, r.height, cfg.agentIcons.histogramBuckets),
  }));
}

// --- Health bar parsing ---

function classifyPixel(r, g, b, det) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;
  if (r - g > det.redDominance && r - b > det.redDominance) return 'fill';
  if (g - r > det.greenDominance && g - b > det.greenDominance) return 'fill';
  if (brightness >= det.fillBrightnessMin && maxc - minc < det.greySaturationMax) return 'fill';
  if (maxc - minc < det.greySaturationMax && brightness >= det.greyBrightnessMin && brightness <= det.greyBrightnessMax) return 'grey';
  return 'other';
}

function readSlotHealth(imageData, det) {
  const { data, width } = imageData;
  const rowY = Math.floor(imageData.height / 2);
  let fillCount = 0, i = 0;
  for (; i < width; i++) {
    const idx = (rowY * width + i) * 4;
    if (classifyPixel(data[idx], data[idx+1], data[idx+2], det) !== 'fill') break;
    fillCount++;
  }
  let greyCount = 0;
  for (; i < width; i++) {
    const idx = (rowY * width + i) * 4;
    if (classifyPixel(data[idx], data[idx+1], data[idx+2], det) === 'grey') greyCount++;
  }
  const recognized = fillCount + greyCount;
  if (recognized < width * det.deadRatioThreshold) return 0;
  return Math.round((fillCount / recognized) * 100);
}

function parseSide(sideKey, sideCfg, det) {
  const { x, y, width, height, slots, gap } = sideCfg;
  const slotWidth = (width - gap * (slots - 1)) / slots;
  return Array.from({ length: slots }, (_, i) => {
    const slotX = Math.round(x + i * (slotWidth + gap));
    const imageData = fullCtx.getImageData(slotX, Math.round(y), Math.round(slotWidth), Math.round(height));
    const pct = readSlotHealth(imageData, det);
    return { side: sideKey, slot: i, health: pct, alive: pct > 2 };
  });
}

// --- OCR helpers ---

// Upscale + threshold a region for Tesseract. White digits on black.
function buildOcrCanvas(x, y, w, h, scale, brightnessThreshold) {
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(fullCanvas, Math.round(x), Math.round(y), w, h, 0, 0, c.width, c.height);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i+1] + d[i+2]) / 3 >= brightnessThreshold ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

// Parse "M:SS" or "MM:SS" or "OT", return null on garbage.
function parseTimerText(raw) {
  const s = raw.replace(/[^0-9:OT]/gi, '').trim();
  if (!s) return null;
  if (/^OT$/i.test(s)) return 'OT';
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const mins = parseInt(m[1], 10), secs = parseInt(m[2], 10);
  if (mins > 9 || secs > 59) return null;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Parse a single score digit (0-13). Returns null on garbage.
function parseScoreText(raw) {
  const s = raw.replace(/\D/g, '').trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  if (isNaN(n) || n < 0 || n > 13) return null;
  return n;
}

// --- Timer OCR (async, non-blocking) ---

let lastTimerResult = null;
let timerBusy = false;

async function parseRoundTimerAsync() {
  if (!tesseractReady || timerBusy) return;
  const tc = cfg.roundTimer;
  timerBusy = true;
  try {
    const canvas = buildOcrCanvas(tc.x, tc.y, tc.width, tc.height, tc.scale || 3, tc.brightnessThreshold ?? 150);
    const worker = await getTesseractWorker();
    const { data: { text } } = await worker.recognize(canvas);
    const parsed = parseTimerText(text);
    if (parsed !== null) lastTimerResult = parsed;
    window.bridge.sendTimerUpdate({ timer: parsed ?? lastTimerResult, raw: text.trim(), ts: Date.now() });
  } catch (e) {
    console.warn('[timer ocr]', e);
  } finally {
    timerBusy = false;
  }
}

// --- Score OCR (async, non-blocking, runs both sides in parallel) ---

let scoreBusy = false;
let lastScoreResult = { def: 0, atk: 0 };

async function parseRoundScoreAsync() {
  if (!scoreWorkerReady || scoreBusy) return;
  const sc = cfg.roundScore;
  scoreBusy = true;
  try {
    const worker = await getScoreWorker();
    const scale = sc.scale || 3;
    const thresh = sc.brightnessThreshold ?? 150;

    // Run both sides in parallel.
    const [defResult, atkResult] = await Promise.all([
      worker.recognize(buildOcrCanvas(sc.def.x, sc.def.y, sc.def.width, sc.def.height, scale, thresh)),
      worker.recognize(buildOcrCanvas(sc.atk.x, sc.atk.y, sc.atk.width, sc.atk.height, scale, thresh)),
    ]);

    const defScore = parseScoreText(defResult.data.text);
    const atkScore = parseScoreText(atkResult.data.text);

    if (defScore !== null) lastScoreResult.def = defScore;
    if (atkScore !== null) lastScoreResult.atk = atkScore;

    window.bridge.sendScoreUpdate({
      def: lastScoreResult.def,
      atk: lastScoreResult.atk,
      ts: Date.now(),
    });
  } catch (e) {
    console.warn('[score ocr]', e);
  } finally {
    scoreBusy = false;
  }
}

// --- Agent icon template matching ---

function buildHistogram(imageData, buckets) {
  return buildHistogramFromBitmap(imageData.data, imageData.width, imageData.height, buckets, true);
}

function buildHistogramFromBitmap(data, width, height, buckets, isRGBA = false) {
  const hist = new Float32Array(buckets * buckets * buckets);
  const step = 256 / buckets;
  let total = 0;
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    let r, g, b, a;
    if (isRGBA) { r = data[idx]; g = data[idx+1]; b = data[idx+2]; a = data[idx+3]; }
    else        { b = data[idx]; g = data[idx+1]; r = data[idx+2]; a = data[idx+3]; }
    if (a < 16) continue;
    const bR = Math.min(buckets-1, Math.floor(r/step));
    const bG = Math.min(buckets-1, Math.floor(g/step));
    const bB = Math.min(buckets-1, Math.floor(b/step));
    hist[bR*buckets*buckets + bG*buckets + bB]++;
    total++;
  }
  if (total > 0) for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return hist;
}

function histogramDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

const DEBUG_AGENT_MATCH = false;
let debugTickCount = 0;

function matchAgent(imageData, buckets, threshold, debugLabel) {
  if (agentRefs.length === 0) return { name: null, confidence: 0 };
  const hist = buildHistogram(imageData, buckets);
  const scored = agentRefs.map((ref) => ({ name: ref.name, dist: histogramDistance(hist, ref.histogram) }));
  scored.sort((a, b) => a.dist - b.dist);
  if (DEBUG_AGENT_MATCH && debugLabel === 'row0' && debugTickCount % 20 === 0) {
    console.log(`[match ${debugLabel}] top3:`, scored.slice(0,3).map(s=>`${s.name}=${s.dist.toFixed(3)}`).join(', '), `| threshold=${threshold}`);
  }
  if (debugLabel === 'row0') debugTickCount++;
  const best = scored[0];
  if (!best || best.dist > threshold) return { name: null, confidence: 0 };
  return { name: best.name, confidence: Math.max(0, 1 - best.dist / threshold) };
}

function regionLooksLikeUI(imageData, minVariance) {
  const { data } = imageData;
  let sum = 0, sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    const b = (data[i*4] + data[i*4+1] + data[i*4+2]) / 3;
    sum += b; sumSq += b * b;
  }
  const mean = sum / n;
  return Math.sqrt(sumSq / n - mean * mean) >= minVariance;
}

function readAgentRows(ic) {
  const x = Math.round(ic.x);
  const results = [];
  for (let row = 0; row < ic.rowsPerTeam; row++) {
    const y = Math.round(ic.y + row * ic.rowGap);
    const imageData = fullCtx.getImageData(x, y, ic.iconWidth, ic.iconHeight);
    const { name, confidence } = matchAgent(imageData, ic.histogramBuckets, ic.matchThreshold, row === 0 ? 'row0' : undefined);
    results.push({ row, team: 'mine', agent: name, confidence });
  }
  const enemyRow0Y = ic.y + (ic.rowsPerTeam - 1) * ic.rowGap + ic.rowGap + ic.blockGapExtra;
  for (let row = 0; row < ic.rowsPerTeam; row++) {
    const y = Math.round(enemyRow0Y + row * ic.rowGap);
    const imageData = fullCtx.getImageData(x, y, ic.iconWidth, ic.iconHeight);
    const { name, confidence } = matchAgent(imageData, ic.histogramBuckets, ic.matchThreshold);
    results.push({ row, team: 'enemy', agent: name, confidence });
  }
  return results;
}

function parseAgentIcons() {
  const ic = cfg.agentIcons;
  const probe = fullCtx.getImageData(Math.round(ic.x), Math.round(ic.y), ic.iconWidth, ic.iconHeight);
  const tabOpen = regionLooksLikeUI(probe, ic.tabOpenMinVariance);
  if (!tabOpen) {
    if (lastAgentResult) return { ...lastAgentResult, tabOpen: false, ts: Date.now() };
    return { rows: [], tabOpen: false, ts: Date.now() };
  }
  const rows = readAgentRows(ic);
  lastAgentResult = { rows, tabOpen: true, ts: Date.now() };
  return lastAgentResult;
}

// --- Main tick ---

function tick() {
  if (!video.videoWidth) return;
  fullCtx.drawImage(video, 0, 0, videoNativeWidth, videoNativeHeight);

  const det = cfg.colors;
  window.bridge.sendHealthUpdate({
    atk: parseSide('atk', cfg.healthBars.atk, det),
    def: parseSide('def', cfg.healthBars.def, det),
    ts: Date.now(),
  });

  window.bridge.sendAgentUpdate(parseAgentIcons());

  // Both OCR calls are async and fire-and-forget.
  // They share no state so running in parallel is safe.
  parseRoundTimerAsync();
  parseRoundScoreAsync();
}

showPicker().catch((err) => {
  statusEl.textContent = 'ERROR: ' + err.message;
  console.error(err);
});

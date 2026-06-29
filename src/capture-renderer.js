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
let agentRefs = []; // [{ name, width, height, histogram: Float32Array }]
let lastAgentResult = null; // latched: { left: [...], right: [...], ts }
const AGENT_SLOTS = 5;

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
    `Hover + press C: log x/y for calibration (health bars, scoreboard region - see README).\n` +
    `Press R: re-fetch agent icons from valorant-api.com (e.g. after a new agent drops).\n` +
    `Press D: dump row0's captured crop to gameoverlay/debug/row0_captured.png for visual inspection.\n` +
    `Loaded ${agentRefs.length} agent reference icon(s) (auto-fetched + cached).\n` +
    (extra ? extra + '\n' : '');
}

// --- Calibration ---
// Map mouse position over the small preview <video> to native screen pixel coords.
video.addEventListener('mousemove', (e) => {
  const rect = video.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / rect.width;
  const yRatio = (e.clientY - rect.top) / rect.height;
  lastMouseFull.x = Math.round(xRatio * videoNativeWidth);
  lastMouseFull.y = Math.round(yRatio * videoNativeHeight);
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

// Dumps row 0's currently-captured icon crop, plus the cached reference PNG
// for the agent it most recently matched (or the first loaded reference if
// none), to gameoverlay/debug/*.png - so you can open both side-by-side and
// see directly whether the calibrated region is landing on a face, and
// whether it visually resembles the API-sourced reference icon style.
async function dumpDebugCrops() {
  if (!videoNativeWidth || !cfg) {
    printStatus('Nothing to dump yet - capture not running.');
    return;
  }
  const { x, y, iconWidth, iconHeight } = cfg.agentIcons;
  fullCtx.drawImage(video, 0, 0, videoNativeWidth, videoNativeHeight);

  const crop = document.createElement('canvas');
  crop.width = iconWidth;
  crop.height = iconHeight;
  crop.getContext('2d').drawImage(fullCanvas, Math.round(x), Math.round(y), iconWidth, iconHeight, 0, 0, iconWidth, iconHeight);
  const cropDataUrl = crop.toDataURL('image/png');
  const cropPath = await window.bridge.saveDebugCrop('row0_captured', cropDataUrl);

  printStatus(`Saved captured crop -> ${cropPath}\nCompare it against any file in assets/agents/*.png (these are the references).`);
}

async function refreshAgentIcons() {
  printStatus('Refetching agent icons from valorant-api.com...');
  const status = await window.bridge.refreshAgentIcons();
  await loadAgentReferences();
  if (status.error) {
    printStatus(`Refresh finished with a warning: ${status.error}`);
  } else {
    printStatus(`Refreshed: ${status.agentNames.length} agent icon(s) loaded.`);
  }
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

// --- Health bar parsing (unchanged) ---

function classifyPixel(r, g, b, det) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;

  if (r - g > det.redDominance && r - b > det.redDominance) return 'fill';
  if (g - r > det.greenDominance && g - b > det.greenDominance) return 'fill';
  if (brightness >= det.fillBrightnessMin && maxc - minc < det.greySaturationMax) return 'fill';
  if (
    maxc - minc < det.greySaturationMax &&
    brightness >= det.greyBrightnessMin &&
    brightness <= det.greyBrightnessMax
  ) {
    return 'grey';
  }
  return 'other';
}

function readSlotHealth(imageData, det) {
  const { data, width } = imageData;
  const rowY = Math.floor(imageData.height / 2);

  let fillCount = 0;
  let i = 0;
  for (; i < width; i++) {
    const idx = (rowY * width + i) * 4;
    const cls = classifyPixel(data[idx], data[idx + 1], data[idx + 2], det);
    if (cls !== 'fill') break;
    fillCount++;
  }

  let greyCount = 0;
  for (; i < width; i++) {
    const idx = (rowY * width + i) * 4;
    const cls = classifyPixel(data[idx], data[idx + 1], data[idx + 2], det);
    if (cls === 'grey') greyCount++;
  }

  const recognized = fillCount + greyCount;
  if (recognized < width * det.deadRatioThreshold) return 0;
  return Math.round((fillCount / recognized) * 100);
}

function parseSide(sideKey, sideCfg, det) {
  const results = [];
  const { x, y, width, height, slots, gap } = sideCfg;
  const slotWidth = (width - gap * (slots - 1)) / slots;

  for (let i = 0; i < slots; i++) {
    const slotX = Math.round(x + i * (slotWidth + gap));
    const imageData = fullCtx.getImageData(slotX, Math.round(y), Math.round(slotWidth), Math.round(height));
    const pct = readSlotHealth(imageData, det);
    results.push({ side: sideKey, slot: i, health: pct, alive: pct > 2 });
  }
  return results;
}

// --- Agent icon template matching ---

// Buckets RGB into a small NxNxN grid and returns a normalized histogram.
// Tolerant of minor scaling/compression noise compared to raw pixel diffing,
// while still distinguishing 24 visually-distinct agent icons cleanly.
function buildHistogram(imageData, buckets) {
  return buildHistogramFromBitmap(imageData.data, imageData.width, imageData.height, buckets, true);
}

// isRGBA: true for canvas ImageData (RGBA byte order).
// false for Electron NativeImage bitmaps, which are BGRA on Windows/most platforms.
// Pixels with alpha=0 are skipped entirely (not bucketed as "black") - this
// matters because the API-sourced reference icons have transparent
// backgrounds, while captured scoreboard regions are always fully opaque.
// Counting transparent pixels as black would give every reference icon a
// fake shared "black background" spike that real captures don't have,
// diluting how distinguishable agents are from each other.
function buildHistogramFromBitmap(data, width, height, buckets, isRGBA = false) {
  const hist = new Float32Array(buckets * buckets * buckets);
  const step = 256 / buckets;
  let total = 0;

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    let r, g, b, a;
    if (isRGBA) {
      r = data[idx];
      g = data[idx + 1];
      b = data[idx + 2];
      a = data[idx + 3];
    } else {
      // BGRA
      b = data[idx];
      g = data[idx + 1];
      r = data[idx + 2];
      a = data[idx + 3];
    }
    if (a < 16) continue; // skip (near-)transparent pixels

    const bucketR = Math.min(buckets - 1, Math.floor(r / step));
    const bucketG = Math.min(buckets - 1, Math.floor(g / step));
    const bucketB = Math.min(buckets - 1, Math.floor(b / step));
    hist[bucketR * buckets * buckets + bucketG * buckets + bucketB]++;
    total++;
  }

  if (total > 0) {
    for (let i = 0; i < hist.length; i++) hist[i] /= total;
  }
  return hist;
}

// Sum of absolute differences between two normalized histograms.
// Range: 0 (identical distribution) to 2 (completely disjoint).
function histogramDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

// Set true temporarily to log the top-3 closest matches + distances for
// row 0 on every tick to the devtools console (Ctrl+Shift+I in the capture
// window) - useful for diagnosing why matching picks the wrong / same
// agent repeatedly. Turn back off once things look right; it's noisy.
const DEBUG_AGENT_MATCH = true;
let debugTickCount = 0;

function matchAgent(imageData, buckets, threshold, debugLabel) {
  if (agentRefs.length === 0) return { name: null, confidence: 0 };
  const hist = buildHistogram(imageData, buckets);

  const scored = agentRefs.map((ref) => ({
    name: ref.name,
    dist: histogramDistance(hist, ref.histogram),
  }));
  scored.sort((a, b) => a.dist - b.dist);

  if (DEBUG_AGENT_MATCH && debugLabel === 'row0' && debugTickCount % 20 === 0) {
    console.log(
      `[match ${debugLabel}] top3:`,
      scored.slice(0, 3).map((s) => `${s.name}=${s.dist.toFixed(3)}`).join(', '),
      `| threshold=${threshold}`
    );
  }
  if (debugLabel === 'row0') debugTickCount++;

  const best = scored[0];
  if (!best || best.dist > threshold) return { name: null, confidence: 0 };
  const confidence = Math.max(0, 1 - best.dist / threshold);
  return { name: best.name, confidence };
}

// Crude "is the scoreboard actually open" check: sample variance across the
// whole scoreboard region. A closed scoreboard shows either the game world
// (low-structure compared to a dense UI) or nothing in that exact spot -
// in practice this is tuned via agentIcons.tabOpenMinVariance in config,
// same way health-bar thresholds are tuned via colors.* in config.
function regionLooksLikeUI(imageData, minVariance) {
  const { data } = imageData;
  let sum = 0;
  let sumSq = 0;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    const idx = i * 4;
    const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    sum += brightness;
    sumSq += brightness * brightness;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  return Math.sqrt(variance) >= minVariance;
}

// Reads all 10 rows from a single vertical list: rows 0-4 are your team,
// rows 5-9 are the enemy team, separated by the DEF/ATK divider bar.
// (Calibrated against a real 1920x1080 Tab-scoreboard screenshot - this is
// ONE column of 10 stacked rows, not two side-by-side team columns.)
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

  // Probe just the first row's box as the "is Tab open" check - cheap, and
  // if row 1 isn't showing UI, the rest of the list almost certainly isn't either.
  const probe = fullCtx.getImageData(Math.round(ic.x), Math.round(ic.y), ic.iconWidth, ic.iconHeight);
  const tabOpen = regionLooksLikeUI(probe, ic.tabOpenMinVariance);

  if (!tabOpen) {
    // Latch: return the last known good result unchanged, flagged as stale,
    // rather than guessing or blanking the overlay while Tab is released.
    if (lastAgentResult) {
      return { ...lastAgentResult, tabOpen: false, ts: Date.now() };
    }
    return { rows: [], tabOpen: false, ts: Date.now() };
  }

  const rows = readAgentRows(ic);
  const result = { rows, tabOpen: true, ts: Date.now() };
  lastAgentResult = result;
  return result;
}

// --- Main tick ---

function tick() {
  if (!video.videoWidth) return;
  fullCtx.drawImage(video, 0, 0, videoNativeWidth, videoNativeHeight);

  const det = cfg.colors;
  const atk = parseSide('atk', cfg.healthBars.atk, det);
  const def = parseSide('def', cfg.healthBars.def, det);
  window.bridge.sendHealthUpdate({ atk, def, ts: Date.now() });

  const agentData = parseAgentIcons();
  window.bridge.sendAgentUpdate(agentData);
}

showPicker().catch((err) => {
  statusEl.textContent = 'ERROR: ' + err.message;
  console.error(err);
});

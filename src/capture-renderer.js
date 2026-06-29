// Runs inside the hidden capture window's renderer process.

let cfg = null;
let video = document.getElementById('preview');
let statusEl = document.getElementById('status');
let fullCanvas = document.getElementById('full');
let fullCtx = fullCanvas.getContext('2d', { willReadFrequently: true });

let videoNativeWidth = 0;
let videoNativeHeight = 0;
let lastMouseFull = { x: 0, y: 0 };

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

  statusEl.textContent =
    `Capturing ${videoNativeWidth}x${videoNativeHeight}\n` +
    `Hover over the preview video and press C to log calibration coords.\n` +
    `Find: left edge / right edge / top / bottom of the ATK health-bar strip,\n` +
    `then repeat for the DEF strip. Coords print below and to devtools console.`;

  setInterval(tick, cfg.captureIntervalMs || 200);
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
  if (e.key.toLowerCase() === 'c') {
    const line = `Calibration point -> x:${lastMouseFull.x} y:${lastMouseFull.y}`;
    console.log(line);
    statusEl.textContent = line + '\n(press C again over another point)';
  }
});

// --- Health bar parsing ---

// Classifies a pixel as:
//   'fill'  - health present, either bright/white OR reddish (any darkness - covers
//             the critical-health red even as it darkens further)
//   'grey'  - the empty/missing-health track
//   'other' - background, border, or anything unrecognized
function classifyPixel(r, g, b, det) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const brightness = (r + g + b) / 3;

  // Red health
  if (
    r - g > det.redDominance &&
    r - b > det.redDominance
  ) {
    return 'fill';
  }

  // Green healing effect
  if (
    g - r > det.greenDominance &&
    g - b > det.greenDominance
  ) {
    return 'fill';
  }

  // White health
  if (
    brightness >= det.fillBrightnessMin &&
    maxc - minc < det.greySaturationMax
  ) {
    return 'fill';
  }

  // Grey empty bar
  if (
    maxc - minc < det.greySaturationMax &&
    brightness >= det.greyBrightnessMin &&
    brightness <= det.greyBrightnessMax
  ) {
    return 'grey';
  }

  return 'other';
}

// Scans one slot's pixel row left-to-right.
// fillCount = contiguous 'fill' pixels from the left edge (current health).
// greyCount = 'grey' pixels found after that point (missing health track).
// If most of the row is unrecognized ('other'), the bar isn't drawn at all - dead.
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
  if (recognized < width * det.deadRatioThreshold) {
    return 0; // bar isn't drawn at all - agent is dead
  }
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
    results.push({
      side: sideKey,
      slot: i,
      health: pct,
      alive: pct > 2,
    });
  }
  return results;
}

function tick() {
  if (!video.videoWidth) return;
  fullCtx.drawImage(video, 0, 0, videoNativeWidth, videoNativeHeight);

  const det = cfg.colors;
  const atk = parseSide('atk', cfg.healthBars.atk, det);
  const def = parseSide('def', cfg.healthBars.def, det);

  window.bridge.sendHealthUpdate({ atk, def, ts: Date.now() });
}

showPicker().catch((err) => {
  statusEl.textContent = 'ERROR: ' + err.message;
  console.error(err);
});
// ============================================================================
// NASA SPHEREx Sky Time-Series & Differential Analyzer (custom.js v2)
// Fixes & Upgrades:
//  1. Persistent IndexedDB storage: Uploaded Python PNG cutouts NEVER disappear on page reload!
//  2. Smart separation of 00_STACKED_SUM.png & 00_DIFFERENCE_SUBTRACT.png from blink frames.
//  3. Live Infrared Sky Map powered by CDS HiPS2FITS + Canvas WCS Overlay (100% working on local file://!).
//  4. Changing RA/Dec, FOV slider, or Bandpass in the sidebar immediately updates BOTH panels!
// ============================================================================

const TARGET_PRESETS = [
  {
    name: "Barnard's Star",
    ra: 269.45208,
    dec: 4.69339,
    fov: 0.08,
    band: "SPHEREx-D2",
    type: "moving",
    dxPerEpoch: -3.2,
    dyPerEpoch: 7.5,
    fluxScale: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
  },
  {
    name: "WISE 0855-0714",
    ra: 133.79513,
    dec: -7.24515,
    fov: 0.08,
    band: "SPHEREx-D5",
    type: "moving",
    dxPerEpoch: -6.8,
    dyPerEpoch: 1.4,
    fluxScale: [1.1, 1.1, 1.1, 1.1, 1.1, 1.1]
  },
  {
    name: "Epsilon Indi B",
    ra: 331.06810,
    dec: -56.78249,
    fov: 0.10,
    band: "SPHEREx-D3",
    type: "moving",
    dxPerEpoch: 4.8,
    dyPerEpoch: -3.6,
    fluxScale: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
  },
  {
    name: "RW Aurigae",
    ra: 76.95653,
    dec: 30.40144,
    fov: 0.12,
    band: "SPHEREx-D3",
    type: "variable",
    dxPerEpoch: 0.0,
    dyPerEpoch: 0.0,
    fluxScale: [0.45, 0.70, 1.15, 1.55, 0.85, 0.35]
  },
  {
    name: "R Draconis",
    ra: 248.17936,
    dec: 66.75417,
    fov: 0.12,
    band: "SPHEREx-D4",
    type: "variable",
    dxPerEpoch: 0.0,
    dyPerEpoch: 0.0,
    fluxScale: [0.30, 0.65, 1.35, 1.80, 1.20, 0.50]
  },
  {
    name: "M101 Galaxy (IRSA Cutout Field)",
    ra: 210.80227,
    dec: 54.34895,
    fov: 0.10,
    band: "SPHEREx-D2",
    type: "moving",
    dxPerEpoch: 0.0,
    dyPerEpoch: 0.0,
    fluxScale: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
  }
];

const EPOCH_DATES = [
  "2025-06-15",
  "2025-12-18",
  "2026-06-20",
  "2026-12-22",
  "2027-06-24",
  "2027-12-26"
];

const BAND_WAVELENGTHS = {
  "SPHEREx-D1": { label: "0.75 - 1.11 um", min: 0.75, max: 1.11 },
  "SPHEREx-D2": { label: "1.11 - 1.64 um", min: 1.11, max: 1.64 },
  "SPHEREx-D3": { label: "1.64 - 2.42 um", min: 1.64, max: 2.42 },
  "SPHEREx-D4": { label: "2.42 - 3.82 um", min: 2.42, max: 3.82 },
  "SPHEREx-D5": { label: "3.82 - 4.42 um", min: 3.82, max: 4.42 },
  "SPHEREx-D6": { label: "4.42 - 5.00 um", min: 4.42, max: 5.00 }
};

let currentCardIndex = 0;
let currentMode = "blink";
let currentEpoch = 0;
let isPlaying = true;
let blinkTimer = null;
let blinkIntervalMs = 500;
let currentSurvey = "CDS/P/allWISE/color";

// Uploaded Python images state
let userLoadedImages = [];       // Individual cutout frames (cutout_001...png)
let precomputedSumImg = null;    // 00_STACKED_SUM.png if uploaded
let precomputedDiffImg = null;   // 00_DIFFERENCE_SUBTRACT.png if uploaded
let cutoutSourceMode = "live";   // "uploaded" | "live"

let currentState = {
  name: TARGET_PRESETS[0].name,
  ra: TARGET_PRESETS[0].ra,
  dec: TARGET_PRESETS[0].dec,
  fov: TARGET_PRESETS[0].fov,
  band: TARGET_PRESETS[0].band,
  presetIndex: 0
};

let fieldStars = [];
function generateFieldStars(seed) {
  fieldStars = [];
  let s = Math.floor(Math.abs(seed * 10000)) % 2147483647 || 12345;
  function rand() {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  }
  for (let i = 0; i < 65; i++) {
    fieldStars.push({
      x: 20 + rand() * 420,
      y: 20 + rand() * 420,
      flux: 0.15 + Math.pow(rand(), 3) * 1.4,
      sigma: 1.4 + rand() * 1.6
    });
  }
}

// ============================================================================
// 1. PERSISTENT BROWSER DATABASE (IndexedDB) SO IMAGES NEVER DISAPPEAR ON RELOAD
// ============================================================================
const DB_NAME = "SPHERExCutoutsDB";
const STORE_NAME = "cutouts";

function openCutoutsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveFilesToIndexedDB(records) {
  try {
    const db = await openCutoutsDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    records.forEach((rec) => store.put(rec));
  } catch (err) {
    console.warn("IndexedDB save warning:", err);
  }
}

async function restoreFilesFromIndexedDB() {
  try {
    const db = await openCutoutsDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch (err) {
    return [];
  }
}

async function clearSavedCutouts() {
  try {
    const db = await openCutoutsDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
  } catch (e) {}
  userLoadedImages = [];
  precomputedSumImg = null;
  precomputedDiffImg = null;
  cutoutSourceMode = "live";
  document.getElementById("sourceToggleRow").style.display = "none";
  document.getElementById("savedFilesStatus").textContent = "Select PNG cutouts from your Python script (saved automatically across reloads):";
  document.getElementById("epochSlider").max = 5;
  currentEpoch = 0;
  renderSpherexCanvas();
}

// ============================================================================
// 2. LIVE INTERACTIVE SKY MAP (CDS HiPS2FITS + Interactive Drag & Scroll Zoom)
// Works 100% locally on file:// without black screen!
// ============================================================================
let skyMapDebounce = null;

function updateLiveSkyMap() {
  const imgEl = document.getElementById("liveSkyImg");
  const badgeEl = document.getElementById("skyLoadingBadge");
  if (!imgEl) return;

  drawSkyMapOverlay();

  if (skyMapDebounce) clearTimeout(skyMapDebounce);
  skyMapDebounce = setTimeout(() => {
    const ra = currentState.ra.toFixed(6);
    const dec = currentState.dec.toFixed(6);
    const fov = Math.max(0.015, Math.min(2.0, currentState.fov)).toFixed(4);
    const hips = encodeURIComponent(currentSurvey);

    const url = `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=${hips}&width=460&height=460&fov=${fov}&projection=TAN&coordsys=icrs&ra=${ra}&dec=${dec}&format=jpg`;

    if (badgeEl) badgeEl.style.display = "block";
    imgEl.onload = () => {
      if (badgeEl) badgeEl.style.display = "none";
      drawSkyMapOverlay();
    };
    imgEl.onerror = () => {
      if (badgeEl) badgeEl.style.display = "none";
      drawSkyMapOverlay(true);
    };
    imgEl.src = url;
  }, 120);
}

function drawSkyMapOverlay(networkFallback = false) {
  const canvas = document.getElementById("skyOverlayCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  if (networkFallback) {
    ctx.fillStyle = "#060913";
    ctx.fillRect(0, 0, w, h);
    for (let s of fieldStars) {
      ctx.fillStyle = "rgba(255, 220, 175, 0.85)";
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(1.2, s.sigma * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(110, 155, 255, 0.22)";
  ctx.lineWidth = 1;
  for (let step = 1; step <= 3; step++) {
    const pos = (w / 4) * step;
    ctx.beginPath();
    ctx.moveTo(pos, 0); ctx.lineTo(pos, h);
    ctx.moveTo(0, pos); ctx.lineTo(w, pos);
    ctx.stroke();
  }

  ctx.strokeStyle = "#4df0a6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 18, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(w / 2 - 28, h / 2); ctx.lineTo(w / 2 - 8, h / 2);
  ctx.moveTo(w / 2 + 8, h / 2);  ctx.lineTo(w / 2 + 28, h / 2);
  ctx.moveTo(w / 2, h / 2 - 28); ctx.lineTo(w / 2, h / 2 - 8);
  ctx.moveTo(w / 2, h / 2 + 8);  ctx.lineTo(w / 2, h / 2 + 28);
  ctx.stroke();

  ctx.fillStyle = "rgba(8, 11, 22, 0.82)";
  ctx.fillRect(0, h - 32, w, 32);
  ctx.fillStyle = "#9ab0ff";
  ctx.font = "12px monospace";
  ctx.fillText(
    `ICRS Center: RA ${currentState.ra.toFixed(4)}° | Dec ${currentState.dec.toFixed(4)}° | FOV ${currentState.fov.toFixed(2)}°`,
    12,
    h - 11
  );
}

function setupSkyMapInteractions() {
  const box = document.getElementById("skyMapContainer");
  if (!box) return;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  box.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    const degPerPixel = currentState.fov / 460.0;
    const cosDec = Math.max(0.1, Math.cos((currentState.dec * Math.PI) / 180.0));
    currentState.ra = (currentState.ra - (dx * degPerPixel) / cosDec + 360.0) % 360.0;
    currentState.dec = Math.max(-89.9, Math.min(89.9, currentState.dec + dy * degPerPixel));
    currentState.presetIndex = -1;
    currentState.name = `Custom Sky Target (${currentState.ra.toFixed(3)}, ${currentState.dec.toFixed(3)})`;

    document.getElementById("raInput").value = currentState.ra.toFixed(5);
    document.getElementById("decInput").value = currentState.dec.toFixed(5);

    generateFieldStars(currentState.ra * 13.7 + currentState.dec * 7.3);
    updateAnalyzerHeaderAndUrl();
    updateLiveSkyMap();
    renderSpherexCanvas();
  });

  box.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.88;
    const newFov = Math.max(0.02, Math.min(0.50, currentState.fov * factor));
    currentState.fov = newFov;
    document.getElementById("fovInput").value = newFov.toFixed(2);
    document.getElementById("fovVal").textContent = newFov.toFixed(2);
    updateAnalyzerHeaderAndUrl();
    updateLiveSkyMap();
    renderSpherexCanvas();
  }, { passive: false });
}

function changeSkySurvey(surveyId) {
  currentSurvey = surveyId;
  updateLiveSkyMap();
}

// ============================================================================
// 3. COORDINATE PARSING & SIDEBAR CONTROLS
// ============================================================================
function parseRA(input) {
  const str = String(input).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.replace(/[hms:]/gi, " ").trim().split(/\s+/).map(Number);
  if (parts.length >= 3 && !parts.some(isNaN)) {
    return (parts[0] + parts[1] / 60 + parts[2] / 3600) * 15.0;
  }
  return parseFloat(str) || 0;
}

function parseDec(input) {
  const str = String(input).trim();
  if (/^[+-]?\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const sign = str.startsWith("-") ? -1 : 1;
  const clean = str.replace(/^[+-]/, "").replace(/[dms'"\u00b0:]/gi, " ").trim();
  const parts = clean.split(/\s+/).map(Number);
  if (parts.length >= 3 && !parts.some(isNaN)) {
    return sign * (parts[0] + parts[1] / 60 + parts[2] / 3600);
  }
  return parseFloat(str) || 0;
}

function onFovSliderInput(val) {
  const fov = parseFloat(val) || 0.10;
  document.getElementById("fovVal").textContent = fov.toFixed(2);
  currentState.fov = fov;
  updateAnalyzerHeaderAndUrl();
  updateLiveSkyMap();
  renderSpherexCanvas();
}

function switchView(viewName) {
  const carouselEl = document.getElementById("carouselView");
  const analyzerEl = document.getElementById("analyzerView");
  const navCarousel = document.getElementById("navCarousel");
  const navAnalyzer = document.getElementById("navAnalyzer");

  if (viewName === "carousel") {
    carouselEl.classList.add("active");
    analyzerEl.classList.remove("active");
    navCarousel.classList.add("active");
    navAnalyzer.classList.remove("active");
  } else {
    carouselEl.classList.remove("active");
    analyzerEl.classList.add("active");
    navCarousel.classList.remove("active");
    navAnalyzer.classList.add("active");
    updateLiveSkyMap();
    renderSpherexCanvas();
  }
}

function updateCarousel(newIndex) {
  const cards = document.querySelectorAll(".card");
  const dots = document.querySelectorAll(".dot");
  const total = cards.length;
  currentCardIndex = (newIndex + total) % total;

  cards.forEach((card, i) => {
    card.classList.remove("active", "left-1", "left-2", "right-1", "right-2");
    const diff = (i - currentCardIndex + total) % total;
    if (diff === 0) card.classList.add("active");
    else if (diff === 1) card.classList.add("right-1");
    else if (diff === 2) card.classList.add("right-2");
    else if (diff === total - 1) card.classList.add("left-1");
    else if (diff === total - 2) card.classList.add("left-2");
  });

  dots.forEach((dot, i) => {
    dot.classList.toggle("active", i === currentCardIndex);
  });

  document.getElementById("targetSelect").value = String(currentCardIndex);
  loadPresetIntoInputs(currentCardIndex);
}

function handleCardClick(index) {
  if (index !== currentCardIndex) {
    updateCarousel(index);
  } else {
    openSelectedTargetInAnalyzer();
  }
}

function openSelectedTargetInAnalyzer() {
  selectPresetTarget(currentCardIndex);
  switchView("analyzer");
}

function loadPresetIntoInputs(idx) {
  const preset = TARGET_PRESETS[idx];
  if (!preset) return;
  document.getElementById("raInput").value = preset.ra.toFixed(5);
  document.getElementById("decInput").value = preset.dec.toFixed(5);
  document.getElementById("fovInput").value = preset.fov.toFixed(2);
  document.getElementById("fovVal").textContent = preset.fov.toFixed(2);
  document.getElementById("bandSelect").value = preset.band;
}

function selectPresetTarget(idx) {
  const index = parseInt(idx, 10);
  const preset = TARGET_PRESETS[index];
  if (!preset) return;
  if (index < 5) currentCardIndex = index;
  loadPresetIntoInputs(index);

  currentState = {
    name: preset.name,
    ra: preset.ra,
    dec: preset.dec,
    fov: preset.fov,
    band: preset.band,
    presetIndex: index
  };

  if (index === 5 && userLoadedImages.length > 0) {
    setCutoutSource("uploaded");
  } else {
    setCutoutSource("live");
  }

  generateFieldStars(preset.ra + preset.dec);
  updateAnalyzerHeaderAndUrl();
  updateLiveSkyMap();
  renderSpherexCanvas();
}

function applyCoordinates(event) {
  if (event) event.preventDefault();
  const ra = parseRA(document.getElementById("raInput").value);
  const dec = parseDec(document.getElementById("decInput").value);
  const fov = parseFloat(document.getElementById("fovInput").value) || 0.1;
  const band = document.getElementById("bandSelect").value;

  let matchedPreset = -1;
  TARGET_PRESETS.forEach((p, idx) => {
    if (Math.hypot(p.ra - ra, p.dec - dec) < 0.08) {
      matchedPreset = idx;
    }
  });

  currentState = {
    name: matchedPreset >= 0 ? TARGET_PRESETS[matchedPreset].name : `Custom Sky Target (${ra.toFixed(3)}, ${dec.toFixed(3)})`,
    ra: ra,
    dec: dec,
    fov: fov,
    band: band,
    presetIndex: matchedPreset
  };

  const isM101 = Math.hypot(ra - 210.80227, dec - 54.34895) < 0.25;
  if (!isM101) {
    setCutoutSource("live");
  }

  generateFieldStars(ra * 13.7 + dec * 7.3);
  switchView("analyzer");
  updateAnalyzerHeaderAndUrl();
  updateLiveSkyMap();
  renderSpherexCanvas();
}

function updateBandpass() {
  currentState.band = document.getElementById("bandSelect").value;
  updateAnalyzerHeaderAndUrl();
  renderSpherexCanvas();
}

function setCutoutSource(mode) {
  cutoutSourceMode = mode;
  const upBtn = document.getElementById("useUploadedBtn");
  const liveBtn = document.getElementById("useLiveSimBtn");
  if (upBtn && liveBtn) {
    upBtn.classList.toggle("active", mode === "uploaded");
    liveBtn.classList.toggle("active", mode === "live");
  }
  const slider = document.getElementById("epochSlider");
  if (mode === "uploaded" && userLoadedImages.length > 0) {
    slider.max = Math.max(0, userLoadedImages.length - 1);
  } else {
    slider.max = 5;
  }
  currentEpoch = 0;
  slider.value = 0;
  renderSpherexCanvas();
}

// ============================================================================
// 4. SPHEREX CUTOUT ENGINE (SUPPORTS BOTH UPLOADED PNGS & LIVE COORDINATES)
// ============================================================================
function computeEpochMatrix(epochIndex, width, height) {
  const matrix = new Float32Array(width * height);
  const preset = currentState.presetIndex >= 0 ? TARGET_PRESETS[currentState.presetIndex] : {
    type: "moving",
    dxPerEpoch: -3.5,
    dyPerEpoch: 4.5,
    fluxScale: [1, 1, 1, 1, 1, 1]
  };

  const zoomFactor = 0.10 / Math.max(0.02, currentState.fov);

  for (let s of fieldStars) {
    const sx = width / 2 + (s.x - width / 2) * zoomFactor;
    const sy = height / 2 + (s.y - height / 2) * zoomFactor;
    if (sx < -10 || sx >= width + 10 || sy < -10 || sy >= height + 10) continue;

    const sigma = s.sigma * Math.min(1.6, Math.max(0.7, Math.sqrt(zoomFactor)));
    const r = Math.ceil(sigma * 3.5);
    const x0 = Math.round(sx);
    const y0 = Math.round(sy);
    for (let dy = -r; dy <= r; dy++) {
      const py = y0 + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -r; dx <= r; dx++) {
        const px = x0 + dx;
        if (px < 0 || px >= width) continue;
        const dist2 = dx * dx + dy * dy;
        matrix[py * width + px] += s.flux * Math.exp(-dist2 / (2 * sigma * sigma));
      }
    }
  }

  const cx = width / 2 + (epochIndex - 2.5) * preset.dxPerEpoch * zoomFactor;
  const cy = height / 2 + (epochIndex - 2.5) * preset.dyPerEpoch * zoomFactor;
  const bandBoost = currentState.band === "SPHEREx-D5" ? 1.35 : 1.0;
  const targetFlux = 2.6 * (preset.fluxScale[epochIndex] || 1.0) * bandBoost;
  const targetSigma = 3.2 * Math.min(1.6, Math.max(0.8, Math.sqrt(zoomFactor)));
  const tr = Math.ceil(targetSigma * 4);

  for (let dy = -tr; dy <= tr; dy++) {
    const py = Math.round(cy) + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = -tr; dx <= tr; dx++) {
      const px = Math.round(cx) + dx;
      if (px < 0 || px >= width) continue;
      const dist2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      matrix[py * width + px] += targetFlux * Math.exp(-dist2 / (2 * targetSigma * targetSigma));
    }
  }

  let noiseSeed = (epochIndex + 1) * 98765;
  for (let i = 0; i < matrix.length; i++) {
    noiseSeed = (noiseSeed * 16807) % 2147483647;
    const n = ((noiseSeed / 2147483647) - 0.5) * 0.06;
    matrix[i] += n;
  }

  return matrix;
}

function renderSpherexCanvas() {
  const canvas = document.getElementById("spherexCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  if (cutoutSourceMode === "uploaded" && userLoadedImages.length > 0) {
    renderUserLoadedCutouts(ctx, w, h);
    return;
  }

  const imgData = ctx.createImageData(w, h);
  const data = imgData.data;
  const bandInfo = BAND_WAVELENGTHS[currentState.band] || BAND_WAVELENGTHS["SPHEREx-D2"];

  if (currentMode === "blink") {
    const mat = computeEpochMatrix(currentEpoch, w, h);
    for (let i = 0; i < mat.length; i++) {
      const v = Math.max(0, Math.min(1, Math.log10(1 + mat[i] * 8) / 1.05));
      const idx = i * 4;
      data[idx] = Math.min(255, v * 275);
      data[idx + 1] = Math.min(255, v * 210);
      data[idx + 2] = Math.min(255, v * 150);
      data[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    drawHudOverlay(ctx, w, h, `Epoch ${currentEpoch + 1}/6 (${EPOCH_DATES[currentEpoch]}) | ${bandInfo.label}`);
    document.getElementById("frameBadge").textContent = `Epoch ${currentEpoch + 1} / 6`;
  } else if (currentMode === "subtract") {
    const earlyMat = computeEpochMatrix(0, w, h);
    const lateMat = computeEpochMatrix(5, w, h);
    for (let i = 0; i < earlyMat.length; i++) {
      const diff = lateMat[i] - earlyMat[i];
      const idx = i * 4;
      if (diff >= 0) {
        const p = Math.min(1, diff * 1.2);
        data[idx] = Math.floor(20 + p * 235);
        data[idx + 1] = Math.floor(20 + p * 140);
        data[idx + 2] = Math.floor(25 + p * 30);
      } else {
        const n = Math.min(1, -diff * 1.2);
        data[idx] = Math.floor(20 + n * 20);
        data[idx + 1] = Math.floor(20 + n * 150);
        data[idx + 2] = Math.floor(25 + n * 230);
      }
      data[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    drawHudOverlay(ctx, w, h, `SUBTRACTION: Epoch 6 (${EPOCH_DATES[5]}) - Epoch 1 (${EPOCH_DATES[0]})`);
    document.getElementById("frameBadge").textContent = "Diff (B - A)";
  } else if (currentMode === "add") {
    const sumMat = new Float32Array(w * h);
    for (let e = 0; e < 6; e++) {
      const m = computeEpochMatrix(e, w, h);
      for (let i = 0; i < m.length; i++) sumMat[i] += m[i] / 6.0;
    }
    for (let i = 0; i < sumMat.length; i++) {
      const v = Math.max(0, Math.min(1, Math.log10(1 + sumMat[i] * 10) / 1.05));
      const idx = i * 4;
      data[idx] = Math.min(255, v * 265);
      data[idx + 1] = Math.min(255, v * 230);
      data[idx + 2] = Math.min(255, v * 195);
      data[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    drawHudOverlay(ctx, w, h, `CO-ADDED STACK (Sum of 6 Epochs) — SNR Boosted 2.45x`);
    document.getElementById("frameBadge").textContent = "Stacked (A + B)";
  }
}

function drawImageWithFovZoom(ctx, img, w, h) {
  const zoom = Math.max(0.4, Math.min(3.5, 0.10 / Math.max(0.02, currentState.fov)));
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, w, h);
  const dw = w * zoom;
  const dh = h * zoom;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

function renderUserLoadedCutouts(ctx, w, h) {
  const total = userLoadedImages.length;
  if (total === 0) return;

  if (currentMode === "blink") {
    const idx = currentEpoch % total;
    drawImageWithFovZoom(ctx, userLoadedImages[idx].img, w, h);
    drawHudOverlay(ctx, w, h, `FITS Cutout (${idx + 1}/${total}): ${userLoadedImages[idx].name} | FOV: ${currentState.fov.toFixed(2)}°`);
    document.getElementById("frameBadge").textContent = `Cutout ${idx + 1} / ${total}`;
  } else if (currentMode === "subtract") {
    if (precomputedDiffImg) {
      drawImageWithFovZoom(ctx, precomputedDiffImg.img, w, h);
      drawHudOverlay(ctx, w, h, `PYTHON FITS DIFFERENCE (00_DIFFERENCE_SUBTRACT.png) | FOV: ${currentState.fov.toFixed(2)}°`);
      document.getElementById("frameBadge").textContent = "Python Diff (B - A)";
      return;
    }
    const offA = document.createElement("canvas");
    offA.width = w; offA.height = h;
    const ctxA = offA.getContext("2d");
    drawImageWithFovZoom(ctxA, userLoadedImages[0].img, w, h);
    const dataA = ctxA.getImageData(0, 0, w, h).data;
    drawImageWithFovZoom(ctxA, userLoadedImages[total - 1].img, w, h);
    const dataB = ctxA.getImageData(0, 0, w, h).data;

    const out = ctx.createImageData(w, h);
    for (let i = 0; i < dataA.length; i += 4) {
      const diff = dataB[i] - dataA[i];
      if (diff >= 0) {
        out.data[i] = Math.min(255, 20 + diff * 1.4);
        out.data[i + 1] = Math.min(255, 20 + diff * 0.75);
        out.data[i + 2] = 25;
      } else {
        out.data[i] = 20;
        out.data[i + 1] = Math.min(255, 20 + (-diff) * 0.85);
        out.data[i + 2] = Math.min(255, 25 + (-diff) * 1.4);
      }
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    drawHudOverlay(ctx, w, h, `SUBTRACTION: ${userLoadedImages[total - 1].name} - ${userLoadedImages[0].name}`);
    document.getElementById("frameBadge").textContent = "Diff (Last - First)";
  } else if (currentMode === "add") {
    if (precomputedSumImg) {
      drawImageWithFovZoom(ctx, precomputedSumImg.img, w, h);
      drawHudOverlay(ctx, w, h, `PYTHON STACKED SUM (${total} Cutouts Combined) | FOV: ${currentState.fov.toFixed(2)}°`);
      document.getElementById("frameBadge").textContent = `Sum (${total} frames)`;
      return;
    }
    const offA = document.createElement("canvas");
    offA.width = w; offA.height = h;
    const ctxA = offA.getContext("2d");
    const accum = new Float32Array(w * h * 3);
    userLoadedImages.forEach((item) => {
      drawImageWithFovZoom(ctxA, item.img, w, h);
      const d = ctxA.getImageData(0, 0, w, h).data;
      for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
        accum[j] += d[i] / total;
        accum[j + 1] += d[i + 1] / total;
        accum[j + 2] += d[i + 2] / total;
      }
    });
    const out = ctx.createImageData(w, h);
    for (let i = 0, j = 0; i < out.data.length; i += 4, j += 3) {
      out.data[i] = Math.min(255, accum[j]);
      out.data[i + 1] = Math.min(255, accum[j + 1]);
      out.data[i + 2] = Math.min(255, accum[j + 2]);
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    drawHudOverlay(ctx, w, h, `STACKED SUM of ${total} SPHEREx Cutouts`);
    document.getElementById("frameBadge").textContent = `Sum (${total} frames)`;
  }
}

function drawHudOverlay(ctx, w, h, labelText) {
  ctx.strokeStyle = "rgba(110, 168, 255, 0.65)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 26, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(8, 11, 22, 0.82)";
  ctx.fillRect(0, h - 32, w, 32);
  ctx.fillStyle = "#d8e2ff";
  ctx.font = "12px monospace";
  ctx.fillText(labelText, 12, h - 11);
}

// ============================================================================
// 5. LOADING & RESTORING PYTHON PNG CUTOUTS
// ============================================================================
function hydrateCutoutRecords(records, switchToAnalyzer = false) {
  userLoadedImages = [];
  precomputedSumImg = null;
  precomputedDiffImg = null;

  if (!records || records.length === 0) return;

  let loaded = 0;
  records.forEach((rec) => {
    const img = new Image();
    img.onload = () => {
      const upper = rec.name.toUpperCase();
      if (upper.includes("STACKED_SUM")) {
        precomputedSumImg = { name: rec.name, img: img };
      } else if (upper.includes("DIFFERENCE_SUBTRACT")) {
        precomputedDiffImg = { name: rec.name, img: img };
      } else {
        userLoadedImages.push({ name: rec.name, img: img });
      }
      loaded++;
      if (loaded === records.length) {
        userLoadedImages.sort((a, b) => a.name.localeCompare(b.name));
        document.getElementById("sourceToggleRow").style.display = "flex";
        document.getElementById("savedFilesStatus").textContent =
          `Saved in browser: ${userLoadedImages.length} cutouts (persists across reloads!)`;
        setCutoutSource("uploaded");
        if (switchToAnalyzer) {
          currentState.name = "M101 Galaxy (Python IRSA Cutouts)";
          currentState.ra = 210.80227;
          currentState.dec = 54.34895;
          document.getElementById("raInput").value = "210.80227";
          document.getElementById("decInput").value = "54.34895";
          document.getElementById("targetSelect").value = "5";
          updateAnalyzerHeaderAndUrl();
          switchView("analyzer");
        } else {
          renderSpherexCanvas();
        }
      }
    };
    img.src = rec.dataUrl;
  });
}

function loadUserCutouts(fileList) {
  if (!fileList || fileList.length === 0) return;
  const filesArray = Array.from(fileList).sort((a, b) => a.name.localeCompare(b.name));
  const records = [];
  let readCount = 0;

  filesArray.forEach((file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      records.push({ name: file.name, dataUrl: e.target.result });
      readCount++;
      if (readCount === filesArray.length) {
        records.sort((a, b) => a.name.localeCompare(b.name));
        saveFilesToIndexedDB(records);
        hydrateCutoutRecords(records, true);
      }
    };
    reader.readAsDataURL(file);
  });
}

function renderCarouselCardPreviews() {
  for (let idx = 0; idx < 5; idx++) {
    const preset = TARGET_PRESETS[idx];
    const c = document.getElementById(`previewCanvas${idx}`);
    if (!c) continue;
    const ctx = c.getContext("2d");
    const w = c.width;
    const h = c.height;
    generateFieldStars(preset.ra + preset.dec);
    const savedIndex = currentState.presetIndex;
    currentState.presetIndex = idx;
    const m = computeEpochMatrix(2, w, h);
    currentState.presetIndex = savedIndex;

    const imgData = ctx.createImageData(w, h);
    for (let i = 0; i < m.length; i++) {
      const v = Math.max(0, Math.min(1, Math.log10(1 + m[i] * 8) / 1.05));
      const p = i * 4;
      imgData.data[p] = Math.min(255, v * 270);
      imgData.data[p + 1] = Math.min(255, v * 200);
      imgData.data[p + 2] = Math.min(255, v * 140);
      imgData.data[p + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
  }
  const activePreset = TARGET_PRESETS[currentState.presetIndex >= 0 ? currentState.presetIndex : 0];
  generateFieldStars(activePreset.ra + activePreset.dec);
}

function setProcessingMode(mode) {
  currentMode = mode;
  document.getElementById("modeBlinkBtn").classList.toggle("active", mode === "blink");
  document.getElementById("modeSubBtn").classList.toggle("active", mode === "subtract");
  document.getElementById("modeAddBtn").classList.toggle("active", mode === "add");

  const exp = document.getElementById("mathExplanation");
  if (mode === "blink") {
    exp.innerHTML = "<strong>Mode: Time-Series Blink.</strong> Animating sequential SPHEREx epochs to reveal proper motion and brightness changes.";
  } else if (mode === "subtract") {
    exp.innerHTML = "<strong>Mode: Image Subtraction (B &minus; A).</strong> Static background stars cancel to zero (dark). Moving objects appear as a <span style='color:#4da6ff'>Blue (Early)</span> &rarr; <span style='color:#ff944d'>Orange (Late)</span> dipole; variable stars leave a bright central residual.";
  } else if (mode === "add") {
    exp.innerHTML = "<strong>Mode: Co-Added Stack (&Sigma; Frames).</strong> Averages all epochs together to suppress noise and highlight faint infrared galaxies &amp; brown dwarfs.";
  }

  updateAnalyzerHeaderAndUrl();
  renderSpherexCanvas();
}

function startBlinkTimer() {
  if (blinkTimer) clearInterval(blinkTimer);
  blinkTimer = setInterval(() => {
    if (!isPlaying || currentMode !== "blink") return;
    const maxFrames = (cutoutSourceMode === "uploaded" && userLoadedImages.length > 0) ? userLoadedImages.length : 6;
    currentEpoch = (currentEpoch + 1) % maxFrames;
    document.getElementById("epochSlider").value = currentEpoch;
    renderSpherexCanvas();
  }, blinkIntervalMs);
}

function togglePlay() {
  isPlaying = !isPlaying;
  document.getElementById("playPauseBtn").innerHTML = isPlaying ? "&#10074;&#10074; Pause" : "&#9654; Play";
}

function onEpochSliderChange(val) {
  currentEpoch = parseInt(val, 10) || 0;
  if (currentMode !== "blink") setProcessingMode("blink");
  renderSpherexCanvas();
}

function changeBlinkSpeed(ms) {
  blinkIntervalMs = parseInt(ms, 10) || 500;
  startBlinkTimer();
}

function updateAnalyzerHeaderAndUrl() {
  document.getElementById("activeTargetTitle").textContent = `${currentState.name} — SPHEREx Time-Series Analyzer`;
  document.getElementById("activeTargetMeta").textContent =
    `RA: ${currentState.ra.toFixed(5)}° | Dec: ${currentState.dec.toFixed(5)}° | FOV: ${currentState.fov.toFixed(2)}° | Band: ${currentState.band}`;

  const params = new URLSearchParams();
  params.set("ra", currentState.ra.toFixed(5));
  params.set("dec", currentState.dec.toFixed(5));
  params.set("fov", currentState.fov.toFixed(2));
  params.set("band", currentState.band);
  params.set("mode", currentMode);

  const newUrl = `${window.location.origin}${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, "", `?${params.toString()}`);

  const embedInput = document.getElementById("embedCodeInput");
  if (embedInput) {
    embedInput.value = `<iframe src="${newUrl}" width="100%" height="720" frameborder="0"></iframe>`;
  }
}

function copyShareUrl() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const status = document.getElementById("copyStatus");
    status.textContent = "Link copied to clipboard!";
    setTimeout(() => { status.textContent = ""; }, 3000);
  });
}

function initFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("ra") || !params.has("dec")) return false;

  const ra = parseRA(params.get("ra"));
  const dec = parseDec(params.get("dec"));
  const fov = parseFloat(params.get("fov")) || 0.10;
  const band = params.get("band") || "SPHEREx-D2";
  const mode = params.get("mode") || "blink";

  document.getElementById("raInput").value = ra.toFixed(5);
  document.getElementById("decInput").value = dec.toFixed(5);
  document.getElementById("fovInput").value = fov.toFixed(2);
  document.getElementById("fovVal").textContent = fov.toFixed(2);
  document.getElementById("bandSelect").value = band;

  applyCoordinates(null);
  setProcessingMode(mode);
  return true;
}

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("sidebarToggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
  });

  document.getElementById("prevCardBtn").addEventListener("click", () => {
    updateCarousel(currentCardIndex - 1);
  });
  document.getElementById("nextCardBtn").addEventListener("click", () => {
    updateCarousel(currentCardIndex + 1);
  });

  setupSkyMapInteractions();
  renderCarouselCardPreviews();
  startBlinkTimer();

  const openedViaUrl = initFromUrlParams();
  if (!openedViaUrl) {
    updateCarousel(0);
    updateAnalyzerHeaderAndUrl();
    updateLiveSkyMap();
  }

  // Automatically restore any previously uploaded Python cutouts from IndexedDB!
  const savedRecords = await restoreFilesFromIndexedDB();
  if (savedRecords && savedRecords.length > 0) {
    hydrateCutoutRecords(savedRecords, false);
  }
});

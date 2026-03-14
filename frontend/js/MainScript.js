import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import { detectObjectContour, extractPoints } from './ObjectDetection.js';
import { initTestRunner } from './TestRunner.js';

// Letter paper dimensions in millimetres (8.5" × 11")
const PAPER_WIDTH_MM = 215.9;
const PAPER_HEIGHT_MM = 279.4;

// Downscale images larger than this to keep processing fast
const MAX_DIMENSION = 1280;

const COLOR_THEME_KEY = 'gridfinium:color-theme';

const SAMPLES = [
  { id: 'mouse',   label: 'Mouse',   src: 'frontend/test-images/mouse.png.jpeg' },
  { id: 'remote',  label: 'Remote',  src: 'frontend/test-images/remote.png.jpeg' },
  { id: 'coaster', label: 'Coaster', src: 'frontend/test-images/coaster-top.png.jpeg' },
];

let cvReady = null;

boot();

async function boot() {
  setupThemeToggle();
  setupSampleButtons();
  setupFileUpload();
  initTestRunner();

  setStatus('Loading OpenCV…', '');
  cvReady = waitForOpenCv();
  await cvReady;

  // Auto-process the first sample so the page is immediately useful
  await processUrl(SAMPLES[0].src, SAMPLES[0].id);
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function setupSampleButtons() {
  document.querySelectorAll('[data-image-src]').forEach((btn) => {
    btn.addEventListener('click', () => {
      processUrl(btn.dataset.imageSrc, btn.dataset.imageId);
    });
  });
}

function setupFileUpload() {
  const input = document.getElementById('file-upload');
  if (!input) return;
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setActiveSample(null);
    const url = URL.createObjectURL(file);
    try {
      await processUrl(url, null);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

// ---------------------------------------------------------------------------
// Main processing pipeline
// ---------------------------------------------------------------------------

async function processUrl(src, sampleId) {
  setActiveSample(sampleId);
  setStatus('Loading image…', 'processing');

  let img;
  try {
    img = await loadImage(src);
  } catch {
    setStatus('Could not load image.', 'error');
    return;
  }

  // Compute display dimensions (cap at MAX_DIMENSION)
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  if (w > MAX_DIMENSION || h > MAX_DIMENSION) {
    const scale = MAX_DIMENSION / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  // Draw to an offscreen canvas so OpenCV can read the pixel data
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  offscreen.getContext('2d').drawImage(img, 0, 0, w, h);

  setStatus('Detecting paper and object…', 'processing');
  await cvReady;

  const srcMat = cv.imread(offscreen);
  let paperPoints = null;
  let objectPoints = null;

  try {
    // Paper detection (noop for showStep since we don't display processing steps)
    const paperContour = detectPaperContour(srcMat, () => {});
    if (paperContour) {
      paperPoints = extractContourPoints(paperContour);

      const objContour = detectObjectContour(srcMat, paperContour);
      if (objContour) {
        objectPoints = extractPoints(objContour);
        objContour.delete();
      }
      paperContour.delete();
    }
  } finally {
    srcMat.delete();
  }

  // Render image + overlays onto the visible canvas
  const canvas = document.getElementById('output-canvas');
  canvas.width = w;
  canvas.height = h;
  drawOverlays(canvas, img, w, h, paperPoints, objectPoints);
  canvas.style.display = 'block';

  updateResults(paperPoints, objectPoints);
}

// ---------------------------------------------------------------------------
// Canvas drawing
// ---------------------------------------------------------------------------

function drawOverlays(canvas, img, w, h, paperPoints, objectPoints) {
  const ctx = canvas.getContext('2d');

  // Original image
  ctx.drawImage(img, 0, 0, w, h);

  const lw = Math.max(2, w / 500);

  // Paper outline — semi-transparent blue fill + solid border
  if (paperPoints?.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(paperPoints[0].x, paperPoints[0].y);
    for (let i = 1; i < paperPoints.length; i++) {
      ctx.lineTo(paperPoints[i].x, paperPoints[i].y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(59,130,246,0.10)';
    ctx.fill();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Object contour — red outline
  if (objectPoints?.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(objectPoints[0].x, objectPoints[0].y);
    for (let i = 1; i < objectPoints.length; i++) {
      ctx.lineTo(objectPoints[i].x, objectPoints[i].y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Dimension calculation
// ---------------------------------------------------------------------------

// Sort 4 corner points into [TL, TR, BR, BL] order
function sortCorners(pts) {
  const byY = [...pts].sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);
  const bot = byY.slice(2).sort((a, b) => a.x - b.x);
  return [top[0], top[1], bot[1], bot[0]]; // TL, TR, BR, BL
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function updateResults(paperPoints, objectPoints) {
  const container = document.getElementById('results');
  if (!container) return;

  if (!paperPoints || paperPoints.length < 4) {
    setStatus('Could not detect paper. Make sure the full sheet is visible.', 'error');
    container.innerHTML = '';
    return;
  }

  const [tl, tr, br, bl] = sortCorners(paperPoints);
  const avgPaperW = (dist(tl, tr) + dist(bl, br)) / 2;
  const avgPaperH = (dist(tl, bl) + dist(tr, br)) / 2;

  // Determine whether the paper is portrait or landscape
  let mmPerPxX, mmPerPxY;
  if (avgPaperW > avgPaperH) {
    // Landscape: the wider pixel dimension corresponds to the 11" side
    mmPerPxX = PAPER_HEIGHT_MM / avgPaperW;
    mmPerPxY = PAPER_WIDTH_MM / avgPaperH;
  } else {
    // Portrait: the taller pixel dimension corresponds to the 11" side
    mmPerPxX = PAPER_WIDTH_MM / avgPaperW;
    mmPerPxY = PAPER_HEIGHT_MM / avgPaperH;
  }

  if (!objectPoints || objectPoints.length < 3) {
    setStatus('Paper detected. No object found inside the paper region.', 'error');
    container.innerHTML = '';
    return;
  }

  const xs = objectPoints.map((p) => p.x);
  const ys = objectPoints.map((p) => p.y);
  const objWpx = Math.max(...xs) - Math.min(...xs);
  const objHpx = Math.max(...ys) - Math.min(...ys);
  const objWmm = objWpx * mmPerPxX;
  const objHmm = objHpx * mmPerPxY;

  setStatus('Paper and object detected.', 'success');

  container.innerHTML = `
    <div class="result-row">
      <div class="result-card">
        <h3>Object width</h3>
        <p>${objWmm.toFixed(1)}&thinsp;mm
          <span class="result-unit">(${(objWmm / 25.4).toFixed(2)}&thinsp;")</span>
        </p>
      </div>
      <div class="result-card">
        <h3>Object depth</h3>
        <p>${objHmm.toFixed(1)}&thinsp;mm
          <span class="result-unit">(${(objHmm / 25.4).toFixed(2)}&thinsp;")</span>
        </p>
      </div>
    </div>
    <p class="result-note">
      Measured from the contour bounding box using letter paper (8.5&Prime;&thinsp;&times;&thinsp;11&Prime;) as the scale reference.
      Place the object flat and ensure the full sheet is in frame.
    </p>
  `;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setActiveSample(id) {
  document.querySelectorAll('[data-image-id]').forEach((btn) => {
    btn.classList.toggle('sample-btn--active', btn.dataset.imageId === id);
  });
}

function setStatus(text, state) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (state ? ` status--${state}` : '');
}

// ---------------------------------------------------------------------------
// OpenCV readiness
// ---------------------------------------------------------------------------

function waitForOpenCv() {
  return new Promise((resolve) => {
    if (typeof cv !== 'undefined' && cv.Mat) {
      resolve();
      return;
    }
    const t = setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        clearInterval(t);
        resolve();
      }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// Image loader
// ---------------------------------------------------------------------------

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

function setupThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  const root = document.documentElement;
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

  const apply = (theme) => {
    const dark = theme === 'dark';
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.classList.toggle('theme-toggle--dark', dark);
  };

  const stored = localStorage.getItem(COLOR_THEME_KEY);
  let theme = stored === 'dark' || stored === 'light' ? stored : (mq?.matches ? 'dark' : 'light');
  let followSystem = !stored;
  apply(theme);

  if (followSystem && mq) {
    const onChange = (e) => {
      if (!followSystem) return;
      theme = e.matches ? 'dark' : 'light';
      apply(theme);
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
    } else {
      mq.addListener?.(onChange);
    }
  }

  btn.addEventListener('click', () => {
    followSystem = false;
    theme = theme === 'dark' ? 'light' : 'dark';
    apply(theme);
    try { localStorage.setItem(COLOR_THEME_KEY, theme); } catch (_) { /* storage unavailable */ }
  });
}

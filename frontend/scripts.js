// IDs for the upload input and the area where we show the result.
const DOM_IDS = {
  input: 'file-upload',
  preview: 'preview',
};

const DEFAULT_IMAGE_PATH = 'example_coaster.jpeg';

const TAB_DATA_ATTRIBUTE = 'data-tab-target';
const STL_DEFAULT_DIMENSIONS = Object.freeze({
  width: 4,
  depth: 6,
  height: 3,
});
const INCH_TO_MM = 25.4;
const THREE_CDN_SOURCES = Object.freeze([
  'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.min.js',
  'https://unpkg.com/three@0.161.0/build/three.min.js',
]);
let threeLoaderPromise = null;
const OVERLAY_COORDINATE_SCALE = 1000;

const HINT_TUNING_DEFAULTS = Object.freeze({
  cannyLowThreshold: 60,
  cannyHighThreshold: 180,
  kernelSize: 3,
  minAreaRatio: 0.0002,
  showProcessingSteps: true,
});

const HINT_TUNING_INPUT_IDS = Object.freeze({
  low: 'hint-threshold-low',
  high: 'hint-threshold-high',
  kernel: 'hint-kernel-size',
  minArea: 'hint-min-area',
  showSteps: 'hint-show-steps',
});

const POLL_INTERVAL_MS = 50;
// Only keep the top three contours so we avoid rendering dozens of shapes.
const MAX_DISPLAY_CONTOURS = 3;
// Keep preview canvases to a mobile-friendly size so zooming never tries to render
// the original multi-megapixel image at full resolution.
const MAX_DISPLAY_DIMENSION = 1280;
let processingStepsIdCounter = 0;
let hintTuningState = { ...HINT_TUNING_DEFAULTS };

// Grab the upload input and preview container once the page loads.
const fileInput = document.getElementById(DOM_IDS.input);
const previewContainer = document.getElementById(DOM_IDS.preview);
// Start preparing OpenCV right away so we can await it later.
const cvReady = waitForOpenCv();
let activePreviewToken = 0;
let activeImageMat = null;
let activeOverlayElement = null;
let activePaperProcessingSteps = null;
let activeHintProcessingSteps = null;
const overlayStateMap = new WeakMap();
const overlayResetButtonMap = new WeakMap();

// Only hook up the change handler when the key DOM nodes exist.
if (fileInput && previewContainer) {
  fileInput.addEventListener('change', handleFileSelection);
  loadDefaultPreview(DEFAULT_IMAGE_PATH);
} else {
  console.warn('GridFinium: required DOM elements not found.');
}

setupTabs();
setupHintTuningControls();

const stlDesignerOptions = {
  viewerId: 'stl-viewer',
  widthInputId: 'stl-width',
  depthInputId: 'stl-depth',
  heightInputId: 'stl-height',
  summaryId: 'stl-summary',
  downloadButtonId: 'stl-download',
  resetButtonId: 'stl-reset',
};

ensureThreeJs()
  .then(() => {
    initStlDesigner(stlDesignerOptions);
  })
  .catch((error) => {
    console.error('GridFinium: unable to load Three.js from any CDN source. Falling back to canvas renderer.', error);
    initStlDesigner(stlDesignerOptions);
  });

async function handleFileSelection(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  const objectUrl = URL.createObjectURL(file);

  try {
    await processImageFromSource(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function processImageFromSource(imageSrc) {
  if (!previewContainer) return;

  const sessionId = ++activePreviewToken;

  previewContainer.replaceChildren();
  activeOverlayElement = null;
  activePaperProcessingSteps = null;
  activeHintProcessingSteps = null;

  const {
    heading: resultHeading,
    canvas: resultCanvas,
    overlay: resultOverlay,
  } = createPreviewResultSection(previewContainer);

  const imageElement = new Image();
  const paperSteps = createStepRenderer(previewContainer, { titleText: 'Paper Processing Steps' });
  activePaperProcessingSteps = paperSteps;
  activeHintProcessingSteps = createStepRenderer(previewContainer, {
    titleText: 'Hint Processing Steps',
    hideWhenEmpty: true,
    startExpanded: true,
  });
  syncProcessingStepsVisibility();
  const renderStep = (label, mat, modifier, renderOptions) => {
    if (sessionId !== activePreviewToken) return;
    if (modifier === 'step-outlined') {
      resultHeading.textContent = label;
      renderMatOnCanvas(mat, resultCanvas, renderOptions);
      if (sessionId !== activePreviewToken) return;
    }
    paperSteps.renderStep(label, mat, modifier);
  };

  await loadImage(imageElement, imageSrc);
  if (sessionId !== activePreviewToken) return;

  await cvReady;
  if (sessionId !== activePreviewToken) return;

  const src = cv.imread(imageElement);
  if (sessionId !== activePreviewToken) {
    src.delete();
    return;
  }

  setActiveImageMat(src);
  try {
    renderStep('Original Photo', src, 'step-original');

    const paperContour = detectPaperContour(src, renderStep);

    let finalDisplay = src;
    let finalOptions;

    if (paperContour) {
      const corners = extractContourPoints(paperContour);
      finalDisplay = src.clone();
      const outline = new cv.MatVector();
      outline.push_back(paperContour);
      cv.drawContours(finalDisplay, outline, 0, new cv.Scalar(0, 255, 0, 255), 6, cv.LINE_AA);
      outline.delete();
      finalOptions = {
        onRender: (info) => attachPaperOverlay(resultOverlay, corners, info),
      };
      paperContour.delete();
    } else {
      finalOptions = {
        onRender: (info) => attachPaperOverlay(resultOverlay, null, info),
      };
    }

    renderStep('Outlined Paper', finalDisplay, 'step-outlined', finalOptions);

    if (finalDisplay !== src) {
      finalDisplay.delete();
    }
  } finally {
    src.delete();
  }
}

function createPreviewResultSection(container) {
  ensureProcessingStyles();

  const section = document.createElement('section');
  section.className = 'preview-result';

  const heading = document.createElement('h3');
  heading.className = 'preview-result__heading';
  heading.textContent = 'Detected Outline';

  const canvasWrapper = document.createElement('div');
  canvasWrapper.className = 'preview-result__canvas-wrapper';

  const canvas = document.createElement('canvas');
  canvas.className = 'preview-result__canvas';

  const overlay = document.createElement('div');
  overlay.className = 'preview-result__overlay';

  canvasWrapper.appendChild(canvas);
  canvasWrapper.appendChild(overlay);
  section.appendChild(heading);
  section.appendChild(canvasWrapper);

  const controls = document.createElement('div');
  controls.className = 'preview-result__controls';

  const resetHintsButton = document.createElement('button');
  resetHintsButton.type = 'button';
  resetHintsButton.className = 'preview-result__button';
  resetHintsButton.textContent = 'Reset hints';
  resetHintsButton.disabled = true;
  resetHintsButton.addEventListener('click', () => {
    const state = overlayStateMap.get(overlay);
    if (!state) return;
    clearHintPoints(state);
    clearSelectionHighlight(state);
  });

  controls.appendChild(resetHintsButton);
  section.appendChild(controls);
  overlayResetButtonMap.set(overlay, resetHintsButton);
  container.appendChild(section);

  return { heading, canvas, overlay };
}

function loadDefaultPreview(imageSrc) {
  processImageFromSource(imageSrc).catch((error) => {
    console.error('GridFinium: failed to load default preview image.', error);
  });
}

function loadImage(imageElement, src) {
  // Promises let us pause until the picture data is ready.
  return new Promise((resolve, reject) => {
    imageElement.onload = () => resolve();
    imageElement.onerror = reject;
    imageElement.src = src;
  });
}

function waitForOpenCv() {
  // OpenCV loads asynchronously, so we wait until its Mat class exists.
  if (window.cv && window.cv.Mat) return Promise.resolve();

  return new Promise((resolve) => {
    const settle = () => resolve();

    const bindRuntime = () => {
      if (!window.cv) return false;
      if (window.cv.Mat) {
        settle();
      } else {
        // If OpenCV is mid-load, let it call the settle function later.
        window.cv.onRuntimeInitialized = settle;
      }
      return true;
    };

    if (bindRuntime()) return;

    const timer = setInterval(() => {
      if (bindRuntime()) clearInterval(timer);
    }, POLL_INTERVAL_MS);
  });
}

function ensureThreeJs() {
  if (typeof THREE !== 'undefined') return Promise.resolve();
  if (threeLoaderPromise) return threeLoaderPromise;

  threeLoaderPromise = new Promise((resolve, reject) => {
    const trySource = (index) => {
      if (typeof THREE !== 'undefined') {
        resolve();
        return;
      }

      if (index >= THREE_CDN_SOURCES.length) {
        reject(new Error('Three.js failed to load'));
        return;
      }

      const script = document.createElement('script');
      script.src = THREE_CDN_SOURCES[index];
      script.async = true;
      script.crossOrigin = 'anonymous';

      const cleanup = () => {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      };

      const handleLoad = () => {
        cleanup();
        if (typeof THREE !== 'undefined') {
          resolve();
        } else {
          script.remove();
          trySource(index + 1);
        }
      };

      const handleError = () => {
        cleanup();
        script.remove();
        trySource(index + 1);
      };

      script.addEventListener('load', handleLoad);
      script.addEventListener('error', handleError);
      document.head.appendChild(script);
    };

    trySource(0);
  }).then(
    () => {
      return undefined;
    },
    (error) => {
      threeLoaderPromise = null;
      throw error;
    },
  );

  return threeLoaderPromise;
}

function initStlDesigner(options) {
  if (typeof THREE !== 'undefined') {
    return initThreeStlDesigner(options);
  }

  return initCanvasStlDesigner(options);
}

function detectPaperContour(src, showStep) {
  // Step 1: create helper mats that will hold grayscale, blur, and edge data.
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Step 1a: grayscale image so color changes do not distract the edge detector.
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  showStep('Grayscale - cv.cvtColor()', gray, 'step-gray');
  // Step 1b: blur slightly to hide tiny specks of noise.
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  showStep('Blurred - cv.GaussianBlur()', blurred, 'step-blurred');
  // Step 1c: highlight strong edges that could form the paper outline.
  cv.Canny(blurred, edges, 30, 90);
  showStep('Edge Map - cv.Canny()', edges, 'step-edges-raw');

  // Step 1d: morphological cleanup pass to close gaps in the paper outline.
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U);
  // Step 1d-i: inflate (dilate) the edges so breaks get filled in.
  cv.dilate(edges, edges, kernel);
  showStep('Dilated Edges - cv.dilate()', edges, 'step-edges-dilated');
  // Step 1d-ii: shrink (erode) them back down so the line is narrow again.
  // cv.erode(edges, edges, kernel);
  kernel.delete();
  // showStep('Cleaned Edges - cv.erode()', edges, 'step-edges-cleaned');

  // Step 2: collect every outline the algorithm discovers.
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const minArea = src.rows * src.cols * 0.15;
  const topContours = [];
  let paper = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const perimeter = cv.arcLength(contour, true);

    if (perimeter < 100) {
      // Skip shapes that are too small to be the sheet.
      contour.delete();
      continue;
    }

    const area = cv.contourArea(contour);

    insertTopContour(topContours, contour, area, perimeter);

    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

    const approxArea = cv.contourArea(approx);
    if (approx.rows === 4 && approxArea > bestArea && approxArea > minArea) {
      // Step 3: keep the largest four-sided shape we have seen so far.
      bestArea = approxArea;
      if (paper) paper.delete();
      paper = approx;
    } else {
      approx.delete();
    }

    contour.delete();
  }

  topContours.forEach((entry, index) => {
    const display = cv.Mat.zeros(src.rows, src.cols, cv.CV_8UC3);
    const single = new cv.MatVector();
    single.push_back(entry.mat);
    cv.drawContours(display, single, -1, new cv.Scalar(255, 87, 34, 255), 2, cv.LINE_AA);
    single.delete();
    const caption = `Top Contour ${index + 1}\nPerimeter: ${entry.perimeter.toFixed(1)} px\nArea: ${entry.area.toFixed(1)} px²`;
    showStep(caption, display, 'step-contour');
    display.delete();
    entry.mat.delete();
  });

  gray.delete();
  blurred.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  // Return the chosen contour (or null) so the caller can decide what to draw.
  return paper;
}

function createStepRenderer(container, options = {}) {
  ensureProcessingStyles();

  const {
    titleText = 'Paper Processing Steps',
    hideWhenEmpty = false,
    startExpanded = false,
  } = options;

  const section = document.createElement('section');
  section.className = 'processing-steps';
  if (hideWhenEmpty) {
    section.hidden = true;
  }

  const header = document.createElement('div');
  header.className = 'processing-steps__header';

  const title = document.createElement('h3');
  title.className = 'processing-steps__title';
  title.textContent = titleText;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'processing-steps__toggle';
  toggle.textContent = 'Show details';

  header.appendChild(title);
  header.appendChild(toggle);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'processing-steps__list';
  const listId = `processing-steps-${processingStepsIdCounter += 1}`;
  list.id = listId;
  section.appendChild(list);
  toggle.setAttribute('aria-controls', listId);

  container.appendChild(section);

  let expanded = Boolean(startExpanded);
  let visible = true;

  const updateSectionVisibility = () => {
    if (hideWhenEmpty && list.childElementCount === 0) {
      section.hidden = true;
    } else {
      section.hidden = false;
    }
  };

  const syncListStyles = () => {
    if (!visible) {
      list.dataset.expanded = 'false';
      list.setAttribute('aria-hidden', 'true');
      list.style.maxHeight = '0px';
      return;
    }

    list.dataset.expanded = expanded ? 'true' : 'false';
    list.setAttribute('aria-hidden', String(!expanded));

    if (expanded) {
      list.style.maxHeight = `${list.scrollHeight}px`;
    } else {
      list.style.maxHeight = '0px';
    }
  };

  const syncToggleState = () => {
    toggle.setAttribute('aria-expanded', String(visible && expanded));
    toggle.textContent = visible && expanded ? 'Hide details' : 'Show details';
    syncListStyles();
  };

  toggle.addEventListener('click', () => {
    if (!visible) return;
    expanded = !expanded;
    syncToggleState();
  });

  syncToggleState();
  updateSectionVisibility();

  const renderStep = (label, mat, modifier, stepOptions = {}) => {
    const wrapper = document.createElement('figure');
    wrapper.className = 'processing-step';
    if (modifier) wrapper.classList.add(modifier);

    const canvas = document.createElement('canvas');
    canvas.className = 'processing-canvas';

    const caption = document.createElement('figcaption');
    caption.textContent = label;

    wrapper.appendChild(canvas);
    wrapper.appendChild(caption);
    list.appendChild(wrapper);

    renderMatOnCanvas(mat, canvas);

    if (Array.isArray(stepOptions.overlayPolygon) && stepOptions.overlayPolygon.length >= 3) {
      drawNormalizedPolygonOnCanvas(canvas, stepOptions.overlayPolygon, {
        fillStyle: stepOptions.overlayFill,
        strokeStyle: stepOptions.overlayStroke,
        lineWidth: stepOptions.overlayLineWidth,
      });
    }

    if (Array.isArray(stepOptions.overlayPoints) && stepOptions.overlayPoints.length > 0) {
      drawNormalizedPointsOnCanvas(canvas, stepOptions.overlayPoints, stepOptions.overlayPointStyle);
    }

    updateSectionVisibility();
    syncListStyles();

    if (visible && expanded) {
      // Keep the transition smooth as new steps are added.
      requestAnimationFrame(syncListStyles);
    }
  };

  return {
    renderStep,
    reset: () => {
      list.replaceChildren();
      if (!visible) {
        list.style.display = 'none';
      } else {
        list.style.display = '';
      }
      updateSectionVisibility();
      syncListStyles();
    },
    setVisible: (visible) => {
      const nextVisible = Boolean(visible);
      toggle.disabled = !nextVisible;
      section.classList.toggle('processing-steps--disabled', !nextVisible);
      if (!nextVisible) {
        expanded = false;
        list.style.display = 'none';
      } else {
        list.style.display = '';
        requestAnimationFrame(syncListStyles);
      }
      visible = nextVisible;
      syncToggleState();
      updateSectionVisibility();
    },
    setExpanded: (nextExpanded) => {
      expanded = Boolean(nextExpanded);
      syncToggleState();
    },
  };
}

function renderMatOnCanvas(mat, canvas, options = {}) {
  const { displayMat, cleanup, originalWidth, originalHeight, displayWidth, displayHeight } =
    buildDisplayMat(mat);
  try {
    cv.imshow(canvas, displayMat);
  } finally {
    cleanup();
  }

  if (typeof options.onRender === 'function') {
    options.onRender({
      originalWidth,
      originalHeight,
      displayWidth,
      displayHeight,
    });
  }
}

function buildDisplayMat(mat) {
  const owned = [];
  let display = mat;
  const originalWidth = mat.cols;
  const originalHeight = mat.rows;

  if (display.type() === cv.CV_8UC1) {
    const rgba = new cv.Mat();
    cv.cvtColor(display, rgba, cv.COLOR_GRAY2RGBA);
    owned.push(rgba);
    display = rgba;
  }

  const maxDimension = Math.max(display.cols, display.rows);
  if (maxDimension > MAX_DISPLAY_DIMENSION) {
    const scale = MAX_DISPLAY_DIMENSION / maxDimension;
    const width = Math.max(1, Math.round(display.cols * scale));
    const height = Math.max(1, Math.round(display.rows * scale));
    const resized = new cv.Mat();
    cv.resize(display, resized, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    owned.push(resized);
    display = resized;
  }

  return {
    displayMat: display,
    cleanup: () => {
      owned.forEach((item) => item.delete());
    },
    originalWidth,
    originalHeight,
    displayWidth: display.cols,
    displayHeight: display.rows,
  };
}

function ensureProcessingStyles() {
  if (document.getElementById('processing-step-styles')) return;
  const style = document.createElement('style');
  style.id = 'processing-step-styles';
  style.textContent = `
    .preview-result {
      display: grid;
      gap: 12px;
    }
    .preview-result__heading {
      margin: 0;
      font-size: 1.25rem;
    }
    .preview-result__canvas-wrapper {
      position: relative;
      display: inline-block;
      max-width: 100%;
    }
    .preview-result__canvas {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
    }
    .preview-result__overlay {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      cursor: crosshair;
    }
    .preview-result__hint-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .preview-result__svg {
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .preview-result__outline {
      fill: rgba(79, 70, 229, 0.12);
      stroke: #4f46e5;
      stroke-width: 3;
      vector-effect: non-scaling-stroke;
    }
    .preview-result__selection {
      fill: rgba(236, 72, 153, 0.26);
      stroke: #ec4899;
      stroke-width: 4;
      vector-effect: non-scaling-stroke;
      opacity: 0;
      transition: opacity 0.2s ease;
      pointer-events: none;
    }
    .preview-result__selection[data-visible="true"] {
      opacity: 1;
    }
    .preview-result__hint-point {
      position: absolute;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 2px solid #ffffff;
      background: #ec4899;
      box-shadow: 0 8px 20px rgba(236, 72, 153, 0.4);
      transform: translate(-50%, -50%) scale(0.85);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.18s ease, opacity 0.18s ease;
    }
    .preview-result__hint-point[data-visible="true"] {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
    .preview-result__controls {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
    }
    .preview-result__button {
      border: none;
      border-radius: 8px;
      padding: 8px 14px;
      background: #e0e7ff;
      color: #312e81;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s ease, transform 0.15s ease;
    }
    .preview-result__button:hover:not(:disabled) {
      background: #c7d2fe;
      transform: translateY(-1px);
    }
    .preview-result__button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .preview-result__handle {
      position: absolute;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #312e81;
      background: #ffffff;
      box-shadow: 0 4px 10px rgba(15, 23, 42, 0.18);
      transform: translate(-50%, -50%);
      pointer-events: auto;
      cursor: grab;
      touch-action: none;
      padding: 0;
      transition: transform 0.15s ease, box-shadow 0.2s ease;
    }
    .preview-result__handle:active {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(1.05);
      box-shadow: 0 6px 14px rgba(15, 23, 42, 0.24);
    }
    .processing-steps {
      margin-top: 16px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: #fff;
      overflow: hidden;
    }
    .processing-steps__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: linear-gradient(135deg, #eef2ff, #f8fafc);
    }
    .processing-steps__title {
      margin: 0;
      font-size: clamp(1.35rem, 2.5vw, 1.6rem);
      font-weight: 700;
    }
    .processing-steps__toggle {
      border: none;
      background: #4f46e5;
      color: #fff;
      padding: 6px 14px;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.2s ease;
    }
    .processing-steps__toggle:hover {
      background: #4338ca;
    }
    .processing-steps--disabled .processing-steps__toggle {
      opacity: 0.6;
      cursor: not-allowed;
      background: #9ca3af;
    }
    .processing-steps--disabled .processing-steps__toggle:hover {
      background: #9ca3af;
    }
    .processing-steps__list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      padding: 0 16px;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease, padding 0.2s ease;
    }
    .processing-steps__list[data-expanded="true"] {
      padding: 16px;
    }
    .processing-step {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: center;
      text-align: center;
    }
    .processing-step--pinned {
      grid-column: 1 / -1;
    }
    .processing-step figcaption {
      margin: 0;
      font-size: 0.85rem;
    }
    .processing-step .processing-canvas {
      width: 100%;
      height: auto;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #f9f9f9;
    }
    .processing-step.step-original .processing-canvas { border-color: #4caf50; }
    .processing-step.step-gray .processing-canvas { border-color: #607d8b; }
    .processing-step.step-blurred .processing-canvas { border-color: #8e24aa; }
    .processing-step.step-edges-raw .processing-canvas { border-color: #1e88e5; }
    .processing-step.step-edges-dilated .processing-canvas { border-color: #fb8c00; }
    .processing-step.step-edges-cleaned .processing-canvas { border-color: #f4511e; }
    .processing-step.step-contour .processing-canvas { border-color: #ff7043; }
    .processing-step.step-outlined .processing-canvas { border-color: #2e7d32; }
    .processing-step.step-hint-selection .processing-canvas { border-color: #ec4899; }
  `;
  document.head.appendChild(style);
}

function extractContourPoints(contour) {
  const data = contour.data32S;
  const points = [];
  for (let i = 0; i < data.length; i += 2) {
    points.push({ x: data[i], y: data[i + 1] });
  }
  return points;
}

function attachPaperOverlay(overlay, corners, renderInfo) {
  if (!overlay) return;
  overlay.replaceChildren();

  const state = {
    displayInfo: renderInfo || null,
    selectionPath: null,
    resetButton: overlayResetButtonMap.get(overlay) || null,
  };
  overlayStateMap.set(overlay, state);
  activeOverlayElement = overlay;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('preview-result__svg');
  svg.setAttribute('viewBox', `0 0 ${OVERLAY_COORDINATE_SCALE} ${OVERLAY_COORDINATE_SCALE}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  let normalizedCorners = null;
  let polygon = null;
  const handles = [];
  let refreshOverlay = null;

  if (corners && corners.length >= 4 && renderInfo) {
    normalizedCorners = corners.map((corner) => ({
      x: clamp(corner.x / renderInfo.originalWidth, 0, 1),
      y: clamp(corner.y / renderInfo.originalHeight, 0, 1),
    }));

    polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.classList.add('preview-result__outline');
    svg.appendChild(polygon);

    refreshOverlay = () => {
      const pointString = normalizedCorners
        .map((corner) => `${(corner.x * OVERLAY_COORDINATE_SCALE).toFixed(2)},${(corner.y * OVERLAY_COORDINATE_SCALE).toFixed(2)}`)
        .join(' ');
      polygon.setAttribute('points', pointString);
      handles.forEach((handle, index) => {
        const { x, y } = normalizedCorners[index];
        handle.style.left = `${(x * 100).toFixed(2)}%`;
        handle.style.top = `${(y * 100).toFixed(2)}%`;
      });
    };
  }

  const selection = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  selection.classList.add('preview-result__selection');
  selection.dataset.visible = 'false';
  selection.setAttribute('points', '');
  svg.appendChild(selection);
  state.selectionPath = selection;

  overlay.appendChild(svg);

  const hintLayer = document.createElement('div');
  hintLayer.className = 'preview-result__hint-layer';
  overlay.appendChild(hintLayer);
  state.hintLayer = hintLayer;
  state.hintPoints = [];
  state.lastHintPixel = null;
  if (state.resetButton) {
    state.resetButton.disabled = true;
  }

  if (normalizedCorners && refreshOverlay) {
    normalizedCorners.forEach((_corner, index) => {
      const handle = createOverlayHandle(overlay, normalizedCorners, index, refreshOverlay);
      handle.setAttribute('aria-label', `Drag corner ${index + 1}`);
      handle.setAttribute('title', 'Drag to adjust the detected outline');
      handles.push(handle);
      overlay.appendChild(handle);
    });

    refreshOverlay();
  }

  clearSelectionHighlight(state);

  overlay.removeEventListener('click', handleOverlayClick);
  overlay.addEventListener('click', handleOverlayClick);
}

function createOverlayHandle(overlay, corners, index, refresh) {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'preview-result__handle';

  handle.addEventListener('click', (event) => {
    event.stopPropagation();
  });

  handle.addEventListener('pointerdown', (event) => {
    event.stopPropagation();
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);

    const updateFromPointer = (moveEvent) => {
      const bounds = overlay.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;

      const normalizedX = clamp((moveEvent.clientX - bounds.left) / bounds.width, 0, 1);
      const normalizedY = clamp((moveEvent.clientY - bounds.top) / bounds.height, 0, 1);

      corners[index].x = normalizedX;
      corners[index].y = normalizedY;
      refresh();
    };

    updateFromPointer(event);

    const stopTracking = (endEvent) => {
      if (handle.hasPointerCapture(endEvent.pointerId)) {
        handle.releasePointerCapture(endEvent.pointerId);
      }
      handle.removeEventListener('pointermove', updateFromPointer);
      handle.removeEventListener('pointerup', stopTracking);
      handle.removeEventListener('pointercancel', stopTracking);
    };

    handle.addEventListener('pointermove', updateFromPointer);
    handle.addEventListener('pointerup', stopTracking);
    handle.addEventListener('pointercancel', stopTracking);
  });

  return handle;
}

function handleOverlayClick(event) {
  if (event.button !== 0) return;

  const overlay = event.currentTarget;
  const state = overlayStateMap.get(overlay);
  if (!state) return;

  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const normalizedX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  const normalizedY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);

  addHintPoint(state, normalizedX, normalizedY);

  if (!state.displayInfo || !activeImageMat) {
    clearSelectionHighlight(state);
    return;
  }

  const { displayWidth, displayHeight, originalWidth, originalHeight } = state.displayInfo;
  if (!displayWidth || !displayHeight || !originalWidth || !originalHeight) {
    clearSelectionHighlight(state);
    return;
  }

  const displayX = normalizedX * displayWidth;
  const displayY = normalizedY * displayHeight;
  const scaleX = originalWidth / displayWidth;
  const scaleY = originalHeight / displayHeight;

  const targetPoint = {
    x: clamp(Math.round(displayX * scaleX), 0, Math.max(0, originalWidth - 1)),
    y: clamp(Math.round(displayY * scaleY), 0, Math.max(0, originalHeight - 1)),
  };

  state.lastHintPixel = { ...targetPoint };
  runHintSelection(state);
}

function addHintPoint(state, normalizedX, normalizedY) {
  if (!state?.hintLayer) return;

  const hintPoint = document.createElement('span');
  hintPoint.className = 'preview-result__hint-point';
  hintPoint.setAttribute('aria-hidden', 'true');
  hintPoint.style.left = `${(normalizedX * 100).toFixed(2)}%`;
  hintPoint.style.top = `${(normalizedY * 100).toFixed(2)}%`;
  hintPoint.dataset.visible = 'true';
  state.hintLayer.appendChild(hintPoint);
  state.hintPoints.push(hintPoint);

  if (state.resetButton) {
    state.resetButton.disabled = false;
  }
}

function clearHintPoints(state) {
  if (!state?.hintLayer) return;

  state.hintLayer.replaceChildren();
  state.hintPoints = [];
  state.lastHintPixel = null;

  if (state.resetButton) {
    state.resetButton.disabled = true;
  }
}

function clearSelectionHighlight(state) {
  if (!state?.selectionPath) return;
  state.selectionPath.dataset.visible = 'false';
  state.selectionPath.setAttribute('points', '');
}

function updateSelectionHighlight(state, contour, renderInfo, normalizedOverride) {
  if (!state?.selectionPath) {
    if (contour) contour.delete();
    return;
  }

  let normalizedPoints = Array.isArray(normalizedOverride) ? normalizedOverride : null;

  if ((!normalizedPoints || normalizedPoints.length < 3) && contour && renderInfo) {
    normalizedPoints = normalizedPointsFromContour(contour, renderInfo);
  }

  if (contour) {
    contour.delete();
  }

  if (!normalizedPoints || normalizedPoints.length < 3) {
    clearSelectionHighlight(state);
    return;
  }

  const pointString = normalizedPoints
    .map((point) => {
      const x = clamp(point.x, 0, 1) * OVERLAY_COORDINATE_SCALE;
      const y = clamp(point.y, 0, 1) * OVERLAY_COORDINATE_SCALE;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  state.selectionPath.setAttribute('points', pointString);
  state.selectionPath.dataset.visible = 'true';
}

function normalizedPointsFromContour(contour, dimensions) {
  if (!contour || !dimensions) return [];

  const width = Number.isFinite(dimensions.originalWidth) && dimensions.originalWidth > 0
    ? dimensions.originalWidth
    : (Number.isFinite(dimensions.displayWidth) && dimensions.displayWidth > 0 ? dimensions.displayWidth : null);
  const height = Number.isFinite(dimensions.originalHeight) && dimensions.originalHeight > 0
    ? dimensions.originalHeight
    : (Number.isFinite(dimensions.displayHeight) && dimensions.displayHeight > 0 ? dimensions.displayHeight : null);

  if (!width || !height) return [];

  const coords = contour.data32S;
  const points = [];
  for (let i = 0; i < coords.length; i += 2) {
    const x = clamp(coords[i] / width, 0, 1);
    const y = clamp(coords[i + 1] / height, 0, 1);
    points.push({ x, y });
  }
  return points;
}

function normalizedPointFromPixel(point, dimensions) {
  if (!point || !dimensions) return null;

  const width = Number.isFinite(dimensions.originalWidth) && dimensions.originalWidth > 0
    ? dimensions.originalWidth
    : (Number.isFinite(dimensions.displayWidth) && dimensions.displayWidth > 0 ? dimensions.displayWidth : null);
  const height = Number.isFinite(dimensions.originalHeight) && dimensions.originalHeight > 0
    ? dimensions.originalHeight
    : (Number.isFinite(dimensions.displayHeight) && dimensions.displayHeight > 0 ? dimensions.displayHeight : null);

  if (!width || !height) return null;

  return {
    x: clamp(point.x / width, 0, 1),
    y: clamp(point.y / height, 0, 1),
  };
}

function drawNormalizedPolygonOnCanvas(canvas, polygon, options = {}) {
  if (!canvas || !Array.isArray(polygon) || polygon.length < 3) return;

  const context = canvas.getContext('2d');
  if (!context) return;

  const fillStyle = options.fillStyle ?? 'rgba(236, 72, 153, 0.26)';
  const strokeStyle = options.strokeStyle ?? '#ec4899';
  const lineWidth = Number.isFinite(options.lineWidth) ? options.lineWidth : 4;

  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return;

  context.save();
  context.beginPath();
  polygon.forEach((point, index) => {
    const x = clamp(point.x, 0, 1) * width;
    const y = clamp(point.y, 0, 1) * height;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });
  context.closePath();

  if (fillStyle) {
    context.fillStyle = fillStyle;
    context.fill();
  }

  if (strokeStyle && lineWidth > 0) {
    context.lineWidth = lineWidth;
    context.strokeStyle = strokeStyle;
    context.stroke();
  }

  context.restore();
}

function drawNormalizedPointsOnCanvas(canvas, points, style = {}) {
  if (!canvas || !Array.isArray(points) || points.length === 0) return;

  const context = canvas.getContext('2d');
  if (!context) return;

  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) return;

  // Mirror the styling of the interactive hint marker so the debug view stays familiar.
  const radius = Number.isFinite(style.radius) ? style.radius : 5;
  const fillStyle = typeof style.fillStyle === 'string' ? style.fillStyle : '#ec4899';
  const strokeStyle = typeof style.strokeStyle === 'string' ? style.strokeStyle : '#ffffff';
  const lineWidth = Number.isFinite(style.lineWidth) ? style.lineWidth : 2;

  context.save();
  context.fillStyle = fillStyle;
  context.strokeStyle = strokeStyle;
  context.lineWidth = lineWidth;

  points.forEach((point) => {
    if (!point) return;
    const x = clamp(point.x, 0, 1) * width;
    const y = clamp(point.y, 0, 1) * height;

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    if (fillStyle) context.fill();
    if (strokeStyle && lineWidth > 0) context.stroke();
  });

  context.restore();
}

function prepareHintStepRenderer() {
  // Reset and expose the hint processing renderer so we can document each pass.
  if (!activeHintProcessingSteps) return null;

  if (typeof activeHintProcessingSteps.reset === 'function') {
    activeHintProcessingSteps.reset();
  }

  activeHintProcessingSteps.setVisible(Boolean(hintTuningState.showProcessingSteps));
  if (hintTuningState.showProcessingSteps && typeof activeHintProcessingSteps.setExpanded === 'function') {
    // Automatically expand the panel so the freshly generated hint steps are visible.
    activeHintProcessingSteps.setExpanded(true);
  }

  return (label, mat, modifier, stepOptions) => {
    activeHintProcessingSteps.renderStep(label, mat, modifier, stepOptions);
  };
}

function runHintSelection(state) {
  // Re-run the hint contour search and update both the overlay and debug steps.
  if (!state || !state.displayInfo || !state.lastHintPixel || !activeImageMat) return;

  const showStep = prepareHintStepRenderer();
  const result = findContourAtPoint(activeImageMat, state.lastHintPixel, showStep, state.displayInfo);
  if (!result) {
    updateSelectionHighlight(state, null, state.displayInfo);
    return;
  }

  const { contour, normalizedPoints } = result;
  updateSelectionHighlight(state, contour, state.displayInfo, normalizedPoints);
}

function findContourAtPoint(sourceMat, point, showStep, displayInfo) {
  if (!sourceMat) return null;

  const renderStep = typeof showStep === 'function' ? showStep : null;
  const normalizedHint = normalizedPointFromPixel(point, displayInfo)
    || normalizedPointFromPixel(point, {
      originalWidth: sourceMat.cols,
      originalHeight: sourceMat.rows,
    });
  const baseStepOptions = normalizedHint ? { overlayPoints: [normalizedHint] } : undefined;

  let sourceForDisplay = sourceMat;
  let cleanupSourceDisplay = null;

  if (renderStep && normalizedHint) {
    sourceForDisplay = sourceMat.clone();

    const hintLocation = new cv.Point(point.x, point.y);
    const scaleEstimate = (() => {
      if (displayInfo && displayInfo.originalWidth && displayInfo.displayWidth) {
        const scaleX = displayInfo.originalWidth / displayInfo.displayWidth;
        const scaleY = displayInfo.originalHeight / displayInfo.displayHeight;
        if (Number.isFinite(scaleX) && Number.isFinite(scaleY) && scaleX > 0 && scaleY > 0) {
          return Math.max(scaleX, scaleY);
        }
      }
      const maxDimension = Math.max(sourceMat.cols, sourceMat.rows);
      if (!maxDimension) return 1;
      const ratio = maxDimension / MAX_DISPLAY_DIMENSION;
      return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    })();

    const baseRadius = 5;
    const outerRadius = Math.max(4, Math.round(baseRadius * scaleEstimate));
    const innerRadius = Math.max(2, outerRadius - 3);
    const coreRadius = Math.max(1, Math.round(innerRadius * 0.4));

    // Recreate the layered white/pink/white target used for the interactive hint marker.
    cv.circle(sourceForDisplay, hintLocation, outerRadius, new cv.Scalar(255, 255, 255, 255), -1, cv.LINE_AA);
    cv.circle(sourceForDisplay, hintLocation, innerRadius, new cv.Scalar(153, 72, 236, 255), -1, cv.LINE_AA);
    if (coreRadius < innerRadius) {
      cv.circle(sourceForDisplay, hintLocation, coreRadius, new cv.Scalar(255, 255, 255, 255), -1, cv.LINE_AA);
    }

    cleanupSourceDisplay = () => {
      sourceForDisplay.delete();
    };
  }

  if (renderStep) {
    renderStep('Hint Source - Original Photo', sourceForDisplay, 'step-original', baseStepOptions);
  }

  if (cleanupSourceDisplay) {
    cleanupSourceDisplay();
  }
  const tuning = getHintTuningConfig();
  const gray = new cv.Mat();
  cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
  if (renderStep) {
    renderStep('Hint Grayscale - cv.cvtColor()', gray, 'step-gray', baseStepOptions);
  }

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  if (renderStep) {
    renderStep('Hint Blurred - cv.GaussianBlur()', blurred, 'step-blurred', baseStepOptions);
  }

  const edges = new cv.Mat();
  // When users drop a hint we do a separate pass to highlight the shape around
  // that point. The thresholds and morphology settings are sourced from the
  // interactive tuning panel so you can steer which edges survive long enough
  // to form a contour.
  cv.Canny(blurred, edges, tuning.cannyLowThreshold, tuning.cannyHighThreshold);
  if (renderStep) {
    renderStep('Hint Edge Map - cv.Canny()', edges, 'step-edges-raw', baseStepOptions);
  }

  const kernel = cv.Mat.ones(tuning.kernelSize, tuning.kernelSize, cv.CV_8U);
  cv.dilate(edges, edges, kernel);
  if (renderStep) {
    renderStep('Hint Dilated Edges - cv.dilate()', edges, 'step-edges-dilated', baseStepOptions);
  }
  cv.erode(edges, edges, kernel);
  if (renderStep) {
    renderStep('Hint Refined Edges - cv.erode()', edges, 'step-edges-cleaned', baseStepOptions);
  }
  kernel.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const minArea = sourceMat.rows * sourceMat.cols * tuning.minAreaRatio;
  const testPoint = new cv.Point(point.x, point.y);
  let insideContour = null;
  let insideArea = Number.POSITIVE_INFINITY;
  let fallbackContour = null;
  let fallbackDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);
    if (area < minArea) {
      contour.delete();
      continue;
    }

    const distance = cv.pointPolygonTest(contour, testPoint, true);

    if (distance >= 0 && area < insideArea) {
      if (insideContour) insideContour.delete();
      insideContour = contour.clone();
      insideArea = area;
    } else if (distance < 0 && !insideContour) {
      const absDistance = Math.abs(distance);
      if (absDistance < fallbackDistance) {
        if (fallbackContour) fallbackContour.delete();
        fallbackContour = contour.clone();
        fallbackDistance = absDistance;
      }
    }

    contour.delete();
  }

  let selected = insideContour || fallbackContour;
  if (selected) {
    const perimeter = cv.arcLength(selected, true);
    const epsilon = Math.max(2, perimeter * 0.02);
    const approx = new cv.Mat();
    cv.approxPolyDP(selected, approx, epsilon, true);
    if (selected === insideContour) {
      insideContour.delete();
      insideContour = null;
    }
    if (selected === fallbackContour) {
      fallbackContour.delete();
      fallbackContour = null;
    }
    selected = approx;
  }

  let normalizedPoints = [];
  if (selected) {
    normalizedPoints = normalizedPointsFromContour(selected, displayInfo || {
      originalWidth: sourceMat.cols,
      originalHeight: sourceMat.rows,
    });
  }

  if (renderStep && selected) {
    const selectionDisplay = sourceMat.clone();
    const selectionVector = new cv.MatVector();
    selectionVector.push_back(selected);
    cv.drawContours(selectionDisplay, selectionVector, -1, new cv.Scalar(236, 72, 153, 255), 4, cv.LINE_AA);
    selectionVector.delete();
    const selectionOptions = {
      overlayPolygon: normalizedPoints,
      overlayFill: 'rgba(236, 72, 153, 0.26)',
      overlayStroke: '#ec4899',
      overlayLineWidth: 4,
    };
    if (normalizedHint) {
      selectionOptions.overlayPoints = [normalizedHint];
    }
    renderStep('Hint Selection Outline', selectionDisplay, 'step-hint-selection', selectionOptions);
    selectionDisplay.delete();
  }

  if (insideContour) insideContour.delete();
  if (fallbackContour) fallbackContour.delete();

  gray.delete();
  blurred.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  if (!selected) return null;

  return { contour: selected, normalizedPoints };
}

function getHintTuningConfig() {
  const lowRaw = Math.round(hintTuningState.cannyLowThreshold);
  const highRaw = Math.round(hintTuningState.cannyHighThreshold);
  const low = clamp(Number.isFinite(lowRaw) ? lowRaw : HINT_TUNING_DEFAULTS.cannyLowThreshold, 0, 255);
  const highCandidate = clamp(Number.isFinite(highRaw) ? highRaw : HINT_TUNING_DEFAULTS.cannyHighThreshold, 0, 255);
  const high = Math.max(low, highCandidate);

  let kernelCandidate = Math.round(hintTuningState.kernelSize);
  if (!Number.isFinite(kernelCandidate)) kernelCandidate = HINT_TUNING_DEFAULTS.kernelSize;
  kernelCandidate = clamp(kernelCandidate, 1, 31);
  if (kernelCandidate % 2 === 0) {
    kernelCandidate = kernelCandidate === 31 ? kernelCandidate - 1 : kernelCandidate + 1;
  }

  const minAreaCandidate = Number(hintTuningState.minAreaRatio);
  const minAreaRatio = Math.max(0, Number.isFinite(minAreaCandidate) ? minAreaCandidate : HINT_TUNING_DEFAULTS.minAreaRatio);

  return {
    cannyLowThreshold: low,
    cannyHighThreshold: clamp(high, 0, 255),
    kernelSize: kernelCandidate,
    minAreaRatio,
  };
}

function setActiveImageMat(mat) {
  if (activeImageMat) {
    activeImageMat.delete();
    activeImageMat = null;
  }

  if (mat) {
    activeImageMat = mat.clone();
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function insertTopContour(list, contour, area, perimeter) {
  const clone = contour.clone();
  const entry = { mat: clone, area, perimeter };
  let inserted = false;

  for (let i = 0; i < list.length; i += 1) {
    if (area > list[i].area) {
      list.splice(i, 0, entry);
      inserted = true;
      break;
    }
  }

  if (!inserted) {
    list.push(entry);
  }

  if (list.length > MAX_DISPLAY_CONTOURS) {
    const removed = list.pop();
    removed.mat.delete();
  }
}

function setupTabs() {
  const tabButtons = Array.from(document.querySelectorAll(`button[${TAB_DATA_ATTRIBUTE}]`));
  if (!tabButtons.length) return;

  const tabPanels = Array.from(document.querySelectorAll('.tab-panel'));

  tabButtons.forEach((button) => {
    const isActive = button.classList.contains('is-active');
    button.setAttribute('aria-pressed', String(isActive));
  });

  tabPanels.forEach((panel) => {
    const isActive = panel.classList.contains('is-active');
    panel.setAttribute('aria-hidden', String(!isActive));
  });

  const activateTab = (targetId) => {
    const targetPanel = tabPanels.find((panel) => panel.id === targetId);
    if (!targetPanel) return;

    tabButtons.forEach((button) => {
      const isActive = button.getAttribute(TAB_DATA_ATTRIBUTE) === targetId;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    tabPanels.forEach((panel) => {
      const isActive = panel === targetPanel;
      panel.classList.toggle('is-active', isActive);
      panel.setAttribute('aria-hidden', String(!isActive));
    });

    window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const targetId = button.getAttribute(TAB_DATA_ATTRIBUTE);
      if (targetId) activateTab(targetId);
    });
  });
}

function setupHintTuningControls() {
  const tuningContent = document.getElementById('hint-tuning-content');
  const tuningToggle = document.getElementById('hint-tuning-toggle');

  const lowInput = document.getElementById(HINT_TUNING_INPUT_IDS.low);
  const highInput = document.getElementById(HINT_TUNING_INPUT_IDS.high);
  const kernelInput = document.getElementById(HINT_TUNING_INPUT_IDS.kernel);
  const minAreaInput = document.getElementById(HINT_TUNING_INPUT_IDS.minArea);
  const showStepsInput = document.getElementById(HINT_TUNING_INPUT_IDS.showSteps);

  if (tuningContent && tuningToggle) {
    let tuningExpanded = false;

    const syncTuningContent = () => {
      tuningContent.dataset.expanded = tuningExpanded ? 'true' : 'false';
      tuningContent.setAttribute('aria-hidden', String(!tuningExpanded));
      tuningToggle.setAttribute('aria-expanded', String(tuningExpanded));

      if (tuningExpanded) {
        tuningContent.style.maxHeight = `${tuningContent.scrollHeight}px`;
      } else {
        tuningContent.style.maxHeight = '0px';
      }

      tuningToggle.textContent = tuningExpanded ? 'Hide details' : 'Show details';
    };

    tuningToggle.addEventListener('click', () => {
      tuningExpanded = !tuningExpanded;
      syncTuningContent();
    });

    syncTuningContent();
    requestAnimationFrame(syncTuningContent);
  }

  if (!lowInput || !highInput || !kernelInput || !minAreaInput || !showStepsInput) return;

  const syncInputsFromState = () => {
    const config = getHintTuningConfig();
    lowInput.value = config.cannyLowThreshold;
    highInput.value = config.cannyHighThreshold;
    highInput.min = String(config.cannyLowThreshold);
    kernelInput.value = config.kernelSize;
    const percentValue = hintTuningState.minAreaRatio * 100;
    let formattedPercent;
    if (!Number.isFinite(percentValue)) {
      formattedPercent = (HINT_TUNING_DEFAULTS.minAreaRatio * 100).toString();
    } else if (percentValue === 0) {
      formattedPercent = '0';
    } else {
      formattedPercent = percentValue.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }
    minAreaInput.value = formattedPercent;
    showStepsInput.checked = Boolean(hintTuningState.showProcessingSteps);
  };

  syncInputsFromState();

  lowInput.addEventListener('change', () => {
    const raw = Number(lowInput.value);
    if (!Number.isFinite(raw)) {
      syncInputsFromState();
      return;
    }

    applyHintTuningState({ cannyLowThreshold: raw });
    syncInputsFromState();
  });

  highInput.addEventListener('change', () => {
    const raw = Number(highInput.value);
    if (!Number.isFinite(raw)) {
      syncInputsFromState();
      return;
    }

    applyHintTuningState({ cannyHighThreshold: raw });
    syncInputsFromState();
  });

  kernelInput.addEventListener('change', () => {
    const raw = Number(kernelInput.value);
    if (!Number.isFinite(raw)) {
      syncInputsFromState();
      return;
    }

    applyHintTuningState({ kernelSize: raw });
    syncInputsFromState();
  });

  minAreaInput.addEventListener('change', () => {
    const raw = Number(minAreaInput.value);
    if (!Number.isFinite(raw) || raw < 0) {
      syncInputsFromState();
      return;
    }

    applyHintTuningState({ minAreaRatio: raw / 100 });
    syncInputsFromState();
  });

  showStepsInput.addEventListener('change', () => {
    hintTuningState.showProcessingSteps = showStepsInput.checked;
    syncProcessingStepsVisibility();
  });
}

function applyHintTuningState(partial, options = {}) {
  hintTuningState = { ...hintTuningState, ...partial };

  const normalized = getHintTuningConfig();
  hintTuningState = {
    ...hintTuningState,
    cannyLowThreshold: normalized.cannyLowThreshold,
    cannyHighThreshold: normalized.cannyHighThreshold,
    kernelSize: normalized.kernelSize,
    minAreaRatio: normalized.minAreaRatio,
  };

  if (options.rerunSelection !== false) {
    rerunHintSelection();
  }

  return normalized;
}

function syncProcessingStepsVisibility() {
  const visible = Boolean(hintTuningState.showProcessingSteps);
  if (activePaperProcessingSteps) {
    activePaperProcessingSteps.setVisible(visible);
  }
  if (activeHintProcessingSteps) {
    activeHintProcessingSteps.setVisible(visible);
  }
}

function rerunHintSelection() {
  if (!activeOverlayElement || !activeImageMat) return;

  const state = overlayStateMap.get(activeOverlayElement);
  if (!state || !state.displayInfo || !state.lastHintPixel) return;
  runHintSelection(state);
}

function initThreeStlDesigner({
  viewerId,
  widthInputId,
  depthInputId,
  heightInputId,
  summaryId,
  downloadButtonId,
  resetButtonId,
}) {
  const viewerRoot = document.getElementById(viewerId);
  const widthInput = document.getElementById(widthInputId);
  const depthInput = document.getElementById(depthInputId);
  const heightInput = document.getElementById(heightInputId);
  const summaryNode = document.getElementById(summaryId);
  const downloadButton = document.getElementById(downloadButtonId);
  const resetButton = document.getElementById(resetButtonId);

  if (!viewerRoot || !widthInput || !depthInput || !heightInput || !summaryNode) return null;
  if (typeof THREE === 'undefined') {
    viewerRoot.textContent = 'Three.js failed to load, so the 3D preview is unavailable.';
    return null;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const initialWidth = Math.max(
    1,
    viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || 480,
  );
  const initialHeight = Math.max(
    1,
    viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || 320,
  );
  const initialAspect = initialWidth / initialHeight;
  renderer.setSize(initialWidth, initialHeight);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.cursor = 'grab';
  renderer.domElement.style.touchAction = 'none';
  viewerRoot.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, initialAspect, 0.1, 2000);
  camera.position.set(12, 8, 12);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
  keyLight.position.set(10, 12, 18);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.35);
  rimLight.position.set(-8, -6, -10);
  scene.add(rimLight);

  const ground = new THREE.GridHelper(40, 10, 0xa5b4fc, 0xe0e7ff);
  ground.position.y = -STL_DEFAULT_DIMENSIONS.height / 2;
  scene.add(ground);

  const modelGroup = new THREE.Group();
  modelGroup.rotation.set(Math.PI / 10, Math.PI / 8, 0);
  scene.add(modelGroup);

  let activeMesh = null;

  const ensureCameraFrame = (dimensions) => {
    const maxDimension = Math.max(dimensions.width, dimensions.depth, dimensions.height);
    const distance = Math.max(12, maxDimension * 3.2);
    camera.position.set(distance, distance * 0.75, distance);
    camera.near = Math.max(0.1, maxDimension / 20);
    camera.far = distance * 12;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  };

  const rebuildMesh = (dimensions) => {
    if (activeMesh) {
      modelGroup.remove(activeMesh);
      activeMesh.geometry.dispose();
      activeMesh.material.dispose();
    }

    const geometry = new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4f46e5,
      metalness: 0.08,
      roughness: 0.4,
    });

    activeMesh = new THREE.Mesh(geometry, material);
    modelGroup.add(activeMesh);

    ground.position.y = -dimensions.height / 2;
    ensureCameraFrame(dimensions);
  };

  const resizeRenderer = () => {
    const { clientWidth, clientHeight } = viewerRoot;
    if (clientWidth === 0 || clientHeight === 0) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  };

  const dragState = {
    active: false,
    pointerId: null,
    previous: new THREE.Vector2(),
  };

  const handlePointerDown = (event) => {
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.previous.set(event.clientX, event.clientY);
    renderer.domElement.setPointerCapture(event.pointerId);
    renderer.domElement.style.cursor = 'grabbing';
  };

  const handlePointerMove = (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.previous.x;
    const deltaY = event.clientY - dragState.previous.y;

    modelGroup.rotation.y += deltaX * 0.005;
    modelGroup.rotation.x += deltaY * 0.005;
    modelGroup.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, modelGroup.rotation.x));

    dragState.previous.set(event.clientX, event.clientY);
  };

  const releasePointer = (event) => {
    if (dragState.pointerId !== event.pointerId) return;
    dragState.active = false;
    dragState.pointerId = null;
    renderer.domElement.releasePointerCapture(event.pointerId);
    renderer.domElement.style.cursor = 'grab';
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(event.deltaY * 0.001);
    camera.position.multiplyScalar(zoomFactor);
  };

  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointermove', handlePointerMove);
  renderer.domElement.addEventListener('pointerup', releasePointer);
  renderer.domElement.addEventListener('pointercancel', releasePointer);
  renderer.domElement.addEventListener('pointerleave', () => {
    dragState.active = false;
    dragState.pointerId = null;
    renderer.domElement.style.cursor = 'grab';
  });
  renderer.domElement.addEventListener('wheel', handleWheel, { passive: false });
  window.addEventListener('resize', resizeRenderer);

  const controls = configureStlControls({
    widthInput,
    depthInput,
    heightInput,
    summaryNode,
    downloadButton,
    resetButton,
    onChange: (dimensions) => {
      rebuildMesh(dimensions);
    },
  });

  resizeRenderer();

  const animate = () => {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };

  animate();

  return {
    getDimensions: () => controls.getDimensions(),
    reset: () => controls.reset(),
  };
}

function initCanvasStlDesigner({
  viewerId,
  widthInputId,
  depthInputId,
  heightInputId,
  summaryId,
  downloadButtonId,
  resetButtonId,
}) {
  const viewerRoot = document.getElementById(viewerId);
  const widthInput = document.getElementById(widthInputId);
  const depthInput = document.getElementById(depthInputId);
  const heightInput = document.getElementById(heightInputId);
  const summaryNode = document.getElementById(summaryId);
  const downloadButton = document.getElementById(downloadButtonId);
  const resetButton = document.getElementById(resetButtonId);

  if (!viewerRoot || !widthInput || !depthInput || !heightInput || !summaryNode) return null;

  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  canvas.style.touchAction = 'none';
  canvas.classList.add('stl-viewer__canvas');

  viewerRoot.replaceChildren(canvas);

  const context = canvas.getContext('2d');
  if (!context) {
    viewerRoot.textContent = 'Your browser does not support the canvas 3D preview.';
    return null;
  }

  const faces = [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
    [3, 2, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [0, 3, 7, 4],
  ];

  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  const lightDirection = normalizeVector({ x: 0.6, y: 0.85, z: 1 });
  const state = {
    rotationX: Math.PI / 10,
    rotationY: Math.PI / 8,
    zoom: 1,
  };

  const displaySize = {
    width: Math.max(1, viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || 480),
    height: Math.max(1, viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || 320),
    dpr: window.devicePixelRatio || 1,
  };

  let latestDimensions = { ...STL_DEFAULT_DIMENSIONS };
  let pendingFrame = null;

  const ensureCanvasSize = () => {
    displaySize.width = Math.max(
      1,
      viewerRoot.clientWidth || viewerRoot.offsetWidth || viewerRoot.scrollWidth || displaySize.width,
    );
    displaySize.height = Math.max(
      1,
      viewerRoot.clientHeight || viewerRoot.offsetHeight || viewerRoot.scrollHeight || displaySize.height,
    );
    displaySize.dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(displaySize.width * displaySize.dpr));
    canvas.height = Math.max(1, Math.round(displaySize.height * displaySize.dpr));
    canvas.style.width = `${displaySize.width}px`;
    canvas.style.height = `${displaySize.height}px`;

    scheduleRender();
  };

  const scheduleRender = () => {
    if (pendingFrame) return;
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null;
      render();
    });
  };

  const render = () => {
    const width = displaySize.width;
    const height = displaySize.height;
    if (width === 0 || height === 0) return;

    context.setTransform(displaySize.dpr, 0, 0, displaySize.dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#eef2ff');
    gradient.addColorStop(1, '#e2e8f0');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    const dims = latestDimensions;
    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const maxDimension = Math.max(dims.width, dims.height, dims.depth);
    const minCanvasSize = Math.min(width, height);
    const scale = (minCanvasSize * 0.5) / (maxDimension || 1);
    const baseDistance = (maxDimension || 1) * scale * 3.2;
    const distance = baseDistance / state.zoom;
    const focalLength = distance;

    const baseVertices = buildBoxVertices(dims, scale);
    const rotatedVertices = baseVertices.map((vertex) => rotateVertex(vertex, state.rotationX, state.rotationY));
    const projectedVertices = rotatedVertices.map((vertex) => projectVertex(vertex, halfWidth, halfHeight, distance, focalLength));

    drawShadow(context, dims, maxDimension, minCanvasSize, halfWidth, halfHeight);

    const visibleFaces = faces
      .map((indices) => buildFaceData(indices, rotatedVertices, projectedVertices, distance))
      .filter((face) => face && face.viewDot < 0)
      .map((face) => ({
        ...face,
        fill: shadeColor({ r: 79, g: 70, b: 229 }, lightDirection, face.normal),
      }));

    visibleFaces.sort((a, b) => b.averageDepth - a.averageDepth);

    visibleFaces.forEach((face) => {
      context.beginPath();
      face.projected.forEach((point, index) => {
        if (index === 0) {
          context.moveTo(point.x, point.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.closePath();
      context.fillStyle = face.fill;
      context.fill();
    });

    context.beginPath();
    edges.forEach(([startIndex, endIndex]) => {
      const start = projectedVertices[startIndex];
      const end = projectedVertices[endIndex];
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    });
    context.lineWidth = 1.2;
    context.strokeStyle = 'rgba(30, 41, 59, 0.35)';
    context.stroke();
  };

  const dragState = {
    active: false,
    pointerId: null,
    previous: { x: 0, y: 0 },
  };

  canvas.addEventListener('pointerdown', (event) => {
    dragState.active = true;
    dragState.pointerId = event.pointerId;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!dragState.active || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.previous.x;
    const deltaY = event.clientY - dragState.previous.y;
    dragState.previous.x = event.clientX;
    dragState.previous.y = event.clientY;

    state.rotationY += deltaX * 0.005;
    state.rotationX += deltaY * 0.005;
    state.rotationX = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.rotationX));

    scheduleRender();
  });

  const releasePointer = (event) => {
    if (dragState.pointerId !== event.pointerId) return;
    dragState.active = false;
    dragState.pointerId = null;
    canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'grab';
  };

  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('pointerleave', () => {
    dragState.active = false;
    dragState.pointerId = null;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const zoomFactor = Math.exp(event.deltaY * 0.001);
      state.zoom = Math.min(6, Math.max(0.4, state.zoom / zoomFactor));
      scheduleRender();
    },
    { passive: false },
  );

  const controls = configureStlControls({
    widthInput,
    depthInput,
    heightInput,
    summaryNode,
    downloadButton,
    resetButton,
    onChange: (dimensions) => {
      latestDimensions = { ...dimensions };
      scheduleRender();
    },
  });

  window.addEventListener('resize', ensureCanvasSize);
  ensureCanvasSize();

  return {
    getDimensions: () => controls.getDimensions(),
    reset: () => controls.reset(),
  };
}

function configureStlControls({
  widthInput,
  depthInput,
  heightInput,
  summaryNode,
  downloadButton,
  resetButton,
  onChange,
}) {
  let currentDimensions = { ...STL_DEFAULT_DIMENSIONS };

  const formatDimensionValue = (value) => {
    const normalized = Math.round(value * 1000) / 1000;
    return Number.isFinite(normalized) ? normalized.toString() : '';
  };

  const applyDimensions = (dimensions, { commitInputs = false } = {}) => {
    currentDimensions = { ...dimensions };

    if (commitInputs) {
      widthInput.value = formatDimensionValue(currentDimensions.width);
      depthInput.value = formatDimensionValue(currentDimensions.depth);
      heightInput.value = formatDimensionValue(currentDimensions.height);
    }

    updateStlSummary(summaryNode, currentDimensions);
    if (typeof onChange === 'function') {
      onChange({ ...currentDimensions });
    }
  };

  const readDimension = (input) => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
  };

  const handleLiveInput = () => {
    const next = { ...currentDimensions };
    let hasChange = false;

    const width = readDimension(widthInput);
    if (width !== null && width !== next.width) {
      next.width = width;
      hasChange = true;
    }

    const depth = readDimension(depthInput);
    if (depth !== null && depth !== next.depth) {
      next.depth = depth;
      hasChange = true;
    }

    const height = readDimension(heightInput);
    if (height !== null && height !== next.height) {
      next.height = height;
      hasChange = true;
    }

    if (hasChange) {
      applyDimensions(next);
    }
  };

  const commitDimensions = () => {
    const width = readDimension(widthInput) ?? currentDimensions.width;
    const depth = readDimension(depthInput) ?? currentDimensions.depth;
    const height = readDimension(heightInput) ?? currentDimensions.height;
    applyDimensions({ width, depth, height }, { commitInputs: true });
  };

  const resetDimensions = () => {
    applyDimensions({ ...STL_DEFAULT_DIMENSIONS }, { commitInputs: true });
  };

  const handleDownload = () => {
    const stlContent = generateBoxStl(currentDimensions);
    const fileName = buildStlFileName(currentDimensions);
    const blob = new Blob([stlContent], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  widthInput.addEventListener('input', handleLiveInput);
  depthInput.addEventListener('input', handleLiveInput);
  heightInput.addEventListener('input', handleLiveInput);

  widthInput.addEventListener('change', commitDimensions);
  depthInput.addEventListener('change', commitDimensions);
  heightInput.addEventListener('change', commitDimensions);

  if (downloadButton) {
    downloadButton.addEventListener('click', (event) => {
      event.preventDefault();
      handleDownload();
    });
  }

  if (resetButton) {
    resetButton.addEventListener('click', (event) => {
      event.preventDefault();
      resetDimensions();
    });
  }

  resetDimensions();

  return {
    getDimensions: () => ({ ...currentDimensions }),
    reset: resetDimensions,
  };
}

function updateStlSummary(summaryNode, dimensions) {
  if (!summaryNode) return;
  const { width, depth, height } = dimensions;
  const format = (value) => Math.round(value * 100) / 100;
  summaryNode.textContent = `Box dimensions: ${format(width)}" × ${format(depth)}" × ${format(height)}".`;
}

function buildBoxVertices(dimensions, scale) {
  const hx = ((dimensions.width || 0) * scale) / 2;
  const hy = ((dimensions.height || 0) * scale) / 2;
  const hz = ((dimensions.depth || 0) * scale) / 2;

  return [
    { x: -hx, y: -hy, z: -hz },
    { x: hx, y: -hy, z: -hz },
    { x: hx, y: hy, z: -hz },
    { x: -hx, y: hy, z: -hz },
    { x: -hx, y: -hy, z: hz },
    { x: hx, y: -hy, z: hz },
    { x: hx, y: hy, z: hz },
    { x: -hx, y: hy, z: hz },
  ];
}

function rotateVertex(vertex, rotationX, rotationY) {
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);

  const x1 = vertex.x * cosY - vertex.z * sinY;
  const z1 = vertex.x * sinY + vertex.z * cosY;
  const y1 = vertex.y * cosX - z1 * sinX;
  const z2 = vertex.y * sinX + z1 * cosX;

  return { x: x1, y: y1, z: z2 };
}

function projectVertex(vertex, halfWidth, halfHeight, distance, focalLength) {
  const z = vertex.z + distance;
  const perspective = focalLength / (z || 1);

  return {
    x: halfWidth + vertex.x * perspective,
    y: halfHeight - vertex.y * perspective,
    depth: z,
  };
}

function drawShadow(context, dimensions, maxDimension, minCanvasSize, centerX, centerY) {
  const safeMax = maxDimension || 1;
  const scaleWidth = (dimensions.width / safeMax) * minCanvasSize * 0.28;
  const scaleDepth = (dimensions.depth / safeMax) * minCanvasSize * 0.22;
  const offsetY = (dimensions.height / safeMax) * minCanvasSize * 0.14;

  context.save();
  context.fillStyle = 'rgba(15, 23, 42, 0.12)';
  context.beginPath();
  context.ellipse(
    centerX,
    centerY + offsetY,
    Math.max(12, scaleWidth),
    Math.max(8, scaleDepth),
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  context.restore();
}

function buildFaceData(indices, rotatedVertices, projectedVertices, cameraDistance) {
  const rotated = indices.map((index) => rotatedVertices[index]);
  const projected = indices.map((index) => projectedVertices[index]);

  const edgeA = subtractVector(rotated[1], rotated[0]);
  const edgeB = subtractVector(rotated[2], rotated[0]);
  const normal = crossVector(edgeA, edgeB);
  const normalLength = Math.hypot(normal.x, normal.y, normal.z);
  if (!normalLength) return null;
  const unitNormal = {
    x: normal.x / normalLength,
    y: normal.y / normalLength,
    z: normal.z / normalLength,
  };

  const center = rotated.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y, z: acc.z + point.z }),
    { x: 0, y: 0, z: 0 },
  );
  center.x /= rotated.length;
  center.y /= rotated.length;
  center.z /= rotated.length;

  const centerCamera = {
    x: center.x,
    y: center.y,
    z: center.z + cameraDistance,
  };

  const toCamera = {
    x: -centerCamera.x,
    y: -centerCamera.y,
    z: -centerCamera.z,
  };
  const toCameraLength = Math.hypot(toCamera.x, toCamera.y, toCamera.z) || 1;
  const unitToCamera = {
    x: toCamera.x / toCameraLength,
    y: toCamera.y / toCameraLength,
    z: toCamera.z / toCameraLength,
  };

  const averageDepth = projected.reduce((sum, point) => sum + point.depth, 0) / projected.length;

  return {
    normal: unitNormal,
    projected,
    averageDepth,
    viewDot: dotVector(unitNormal, unitToCamera),
  };
}

function shadeColor(baseColor, lightDirection, normal) {
  const dot = Math.max(0, dotVector(lightDirection, normal));
  const intensity = 0.35 + 0.65 * dot;

  const r = Math.round(Math.min(255, baseColor.r * intensity));
  const g = Math.round(Math.min(255, baseColor.g * intensity));
  const b = Math.round(Math.min(255, baseColor.b * intensity));

  return `rgb(${r}, ${g}, ${b})`;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function subtractVector(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function crossVector(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dotVector(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function generateBoxStl(dimensions) {
  const width = dimensions.width * INCH_TO_MM;
  const depth = dimensions.depth * INCH_TO_MM;
  const height = dimensions.height * INCH_TO_MM;

  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  const vertices = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, hy, -hz],
    [-hx, hy, -hz],
    [-hx, -hy, hz],
    [hx, -hy, hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];

  const facets = [
    { normal: [0, 0, -1], triangles: [[0, 1, 2], [0, 2, 3]] },
    { normal: [0, 0, 1], triangles: [[4, 5, 6], [4, 6, 7]] },
    { normal: [0, 1, 0], triangles: [[3, 2, 6], [3, 6, 7]] },
    { normal: [0, -1, 0], triangles: [[0, 1, 5], [0, 5, 4]] },
    { normal: [1, 0, 0], triangles: [[1, 6, 2], [1, 5, 6]] },
    { normal: [-1, 0, 0], triangles: [[0, 7, 3], [0, 4, 7]] },
  ];

  const lines = ['solid gridfinium_box'];

  facets.forEach(({ normal, triangles }) => {
    const normalLine = `  facet normal ${normal.map((value) => value.toFixed(6)).join(' ')}`;
    triangles.forEach((triangle) => {
      lines.push(normalLine, '    outer loop');
      triangle.forEach((index) => {
        const vertex = vertices[index];
        lines.push(`      vertex ${vertex.map((value) => value.toFixed(6)).join(' ')}`);
      });
      lines.push('    endloop', '  endfacet');
    });
  });

  lines.push('endsolid gridfinium_box');
  return `${lines.join('\n')}\n`;
}

function buildStlFileName(dimensions) {
  const parts = [dimensions.width, dimensions.depth, dimensions.height].map((value) => {
    const rounded = Math.round(value * 100) / 100;
    return String(rounded).replace(/\./g, '_');
  });
  return `gridfinium-box-${parts.join('x')}.stl`;
}







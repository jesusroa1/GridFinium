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

const POLL_INTERVAL_MS = 50;
// Only keep the top three contours so we avoid rendering dozens of shapes.
const MAX_DISPLAY_CONTOURS = 3;
// Keep preview canvases to a mobile-friendly size so zooming never tries to render
// the original multi-megapixel image at full resolution.
const MAX_DISPLAY_DIMENSION = 1280;

// Grab the upload input and preview container once the page loads.
const fileInput = document.getElementById(DOM_IDS.input);
const previewContainer = document.getElementById(DOM_IDS.preview);
// Start preparing OpenCV right away so we can await it later.
const cvReady = waitForOpenCv();
let activePreviewToken = 0;

// Only hook up the change handler when the key DOM nodes exist.
if (fileInput && previewContainer) {
  fileInput.addEventListener('change', handleFileSelection);
  loadDefaultPreview(DEFAULT_IMAGE_PATH);
} else {
  console.warn('GridFinium: required DOM elements not found.');
}

setupTabs();

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

  const { heading: resultHeading, canvas: resultCanvas } = createPreviewResultSection(previewContainer);

  const imageElement = new Image();
  const appendStep = createStepRenderer(previewContainer);
  const renderStep = (label, mat, modifier) => {
    if (sessionId !== activePreviewToken) return;
    if (modifier === 'step-outlined') {
      resultHeading.textContent = label;
      renderMatOnCanvas(mat, resultCanvas);
      if (sessionId !== activePreviewToken) return;
    }
    appendStep(label, mat, modifier);
  };

  await loadImage(imageElement, imageSrc);
  if (sessionId !== activePreviewToken) return;

  await cvReady;
  if (sessionId !== activePreviewToken) return;

  const src = cv.imread(imageElement);
  try {
    renderStep('Original Photo', src, 'step-original');

    const paperContour = detectPaperContour(src, renderStep);

    if (paperContour) {
      const outline = new cv.MatVector();
      outline.push_back(paperContour);
      cv.drawContours(src, outline, 0, new cv.Scalar(0, 255, 0, 255), 6, cv.LINE_AA);
      outline.delete();
      paperContour.delete();
    }

    renderStep('Outlined Paper', src, 'step-outlined');
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

  canvasWrapper.appendChild(canvas);
  section.appendChild(heading);
  section.appendChild(canvasWrapper);
  container.appendChild(section);

  return { heading, canvas };
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
  cv.erode(edges, edges, kernel);
  kernel.delete();
  showStep('Cleaned Edges - cv.erode()', edges, 'step-edges-cleaned');

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

function createStepRenderer(container) {
  ensureProcessingStyles();
  const section = document.createElement('section');
  section.className = 'processing-steps';

  const header = document.createElement('div');
  header.className = 'processing-steps__header';

  const title = document.createElement('h3');
  title.className = 'processing-steps__title';
  title.textContent = 'Processing Steps';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'processing-steps__toggle';
  toggle.textContent = 'Show details';
  toggle.setAttribute('aria-expanded', 'false');

  header.appendChild(title);
  header.appendChild(toggle);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'processing-steps__list';
  list.hidden = true;
  section.appendChild(list);

  container.appendChild(section);

  let expanded = false;
  const syncToggleState = () => {
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Hide details' : 'Show details';
    list.hidden = !expanded;
  };

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    syncToggleState();
  });

  syncToggleState();

  return (label, mat, modifier) => {
    const wrapper = document.createElement('figure');
    wrapper.className = 'processing-step';
    if (modifier) wrapper.classList.add(modifier);

    const canvas = document.createElement('canvas');
    canvas.className = 'processing-canvas';
    if (modifier) canvas.classList.add(`${modifier}__canvas`);

    const caption = document.createElement('figcaption');
    caption.textContent = label;

    wrapper.appendChild(canvas);
    wrapper.appendChild(caption);
    list.appendChild(wrapper);

    renderMatOnCanvas(mat, canvas);
  };
}

function renderMatOnCanvas(mat, canvas) {
  const { displayMat, cleanup } = buildDisplayMat(mat);
  try {
    cv.imshow(canvas, displayMat);
  } finally {
    cleanup();
  }
}

function buildDisplayMat(mat) {
  const owned = [];
  let display = mat;

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
  };
}

function ensureProcessingStyles() {
  if (document.getElementById('processing-step-styles')) return;
  const style = document.createElement('style');
  style.id = 'processing-step-styles';
  style.textContent = `
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
    .processing-steps__header h3 {
      margin: 0;
      font-size: 1rem;
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
    .processing-steps__list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      padding: 16px;
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    .processing-steps__list[data-expanded="true"] {
      max-height: 1200px;
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
  `;
  document.head.appendChild(style);
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
      state.zoom = Math.min(3, Math.max(0.4, state.zoom / zoomFactor));
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

  const parseDimension = (input, fallback) => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      input.value = fallback;
      return fallback;
    }
    return value;
  };

  const applyDimensions = (dimensions) => {
    currentDimensions = { ...dimensions };
    updateStlSummary(summaryNode, currentDimensions);
    if (typeof onChange === 'function') {
      onChange({ ...currentDimensions });
    }
  };

  const syncDimensions = () => {
    applyDimensions({
      width: parseDimension(widthInput, currentDimensions.width),
      depth: parseDimension(depthInput, currentDimensions.depth),
      height: parseDimension(heightInput, currentDimensions.height),
    });
  };

  const resetDimensions = () => {
    widthInput.value = STL_DEFAULT_DIMENSIONS.width;
    depthInput.value = STL_DEFAULT_DIMENSIONS.depth;
    heightInput.value = STL_DEFAULT_DIMENSIONS.height;
    applyDimensions({ ...STL_DEFAULT_DIMENSIONS });
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

  widthInput.addEventListener('change', syncDimensions);
  depthInput.addEventListener('change', syncDimensions);
  heightInput.addEventListener('change', syncDimensions);

  widthInput.addEventListener('input', syncDimensions);
  depthInput.addEventListener('input', syncDimensions);
  heightInput.addEventListener('input', syncDimensions);

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
  summaryNode.textContent = `Cube dimensions: ${format(width)}" × ${format(depth)}" × ${format(height)}".`;
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







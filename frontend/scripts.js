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
ensureThreeJs()
  .then(() => {
    initStlDesigner({
      viewerId: 'stl-viewer',
      widthInputId: 'stl-width',
      depthInputId: 'stl-depth',
      heightInputId: 'stl-height',
      summaryId: 'stl-summary',
      downloadButtonId: 'stl-download',
      resetButtonId: 'stl-reset',
    });
  })
  .catch((error) => {
    const viewerRoot = document.getElementById('stl-viewer');
    if (viewerRoot) {
      viewerRoot.textContent = 'Three.js failed to load, so the 3D preview is unavailable.';
    }
    console.error('GridFinium: unable to load Three.js.', error);
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

let threeLoaderPromise = null;

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
    if (modifier) canvas.classList.add(${modifier}__canvas);

    const caption = document.createElement('figcaption');
    caption.textContent = label;

    wrapper.appendChild(canvas);
    wrapper.appendChild(caption);
    list.appendChild(wrapper);

    renderMatOnCanvas(mat, canvas);
  };
}

function renderMatOnCanvas(mat, canvas)(mat, canvas) {
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

function initStlDesigner({
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
  let currentDimensions = { ...STL_DEFAULT_DIMENSIONS };

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

  const updateSummary = (dimensions) => {
    const { width, depth, height } = dimensions;
    const format = (value) => Math.round(value * 100) / 100;
    summaryNode.textContent = `Cube dimensions: ${format(width)}" × ${format(depth)}" × ${format(height)}".`;
  };

  const parseDimension = (input, fallback) => {
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      input.value = fallback;
      return fallback;
    }
    return value;
  };

  const syncDimensions = () => {
    currentDimensions = {
      width: parseDimension(widthInput, currentDimensions.width),
      depth: parseDimension(depthInput, currentDimensions.depth),
      height: parseDimension(heightInput, currentDimensions.height),
    };

    rebuildMesh(currentDimensions);
    updateSummary(currentDimensions);
  };

  const resetDimensions = () => {
    widthInput.value = STL_DEFAULT_DIMENSIONS.width;
    depthInput.value = STL_DEFAULT_DIMENSIONS.depth;
    heightInput.value = STL_DEFAULT_DIMENSIONS.height;
    currentDimensions = { ...STL_DEFAULT_DIMENSIONS };
    rebuildMesh(currentDimensions);
    updateSummary(currentDimensions);
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
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const zoomFactor = Math.exp(event.deltaY * 0.001);
    camera.position.multiplyScalar(zoomFactor);
  };

  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointermove', handlePointerMove);
  renderer.domElement.addEventListener('pointerup', releasePointer);
  renderer.domElement.addEventListener('pointerleave', () => {
    dragState.active = false;
    dragState.pointerId = null;
  });
  renderer.domElement.addEventListener('wheel', handleWheel, { passive: false });

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

  window.addEventListener('resize', resizeRenderer);

  const animate = () => {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  };

  resizeRenderer();
  resetDimensions();
  animate();

  return {
    getDimensions: () => ({ ...currentDimensions }),
    reset: resetDimensions,
  };
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







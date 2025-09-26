// IDs for the upload input and the area where we show the result.
const DOM_IDS = {
  input: 'file-upload',
  preview: 'preview',
};

const POLL_INTERVAL_MS = 50;
// Only keep the top three contours so we avoid rendering dozens of shapes.
const MAX_DISPLAY_CONTOURS = 3;

// Grab the upload input and preview container once the page loads.
const fileInput = document.getElementById(DOM_IDS.input);
const previewContainer = document.getElementById(DOM_IDS.preview);
// Start preparing OpenCV right away so we can await it later.
const cvReady = waitForOpenCv();

// Only hook up the change handler when the key DOM nodes exist.
if (fileInput && previewContainer) {
  fileInput.addEventListener('change', handleFileSelection);
} else {
  console.warn('GridFinium: required DOM elements not found.');
}

async function handleFileSelection(event) {
  // Start fresh every time a new file is chosen.
  previewContainer.replaceChildren();

  const file = event.target?.files?.[0];
  if (!file) return;

  // Build the <img> object that will hold this upload for OpenCV to read.
  const imageElement = new Image();
  const objectUrl = URL.createObjectURL(file);
  const renderStep = createStepRenderer(previewContainer);

  try {
    await loadImage(imageElement, objectUrl);

    await cvReady;

    // Step 0: load the raw pixels from the image into an OpenCV matrix.
    const src = cv.imread(imageElement);
    renderStep('Original Photo', src, 'step-original');
    // Step 1+: run the paper detection routine and log each transformation.
    const paperContour = detectPaperContour(src, renderStep);

    if (paperContour) {
      const outline = new cv.MatVector();
      outline.push_back(paperContour);
      cv.drawContours(src, outline, 0, new cv.Scalar(0, 255, 0, 255), 6, cv.LINE_AA);
      outline.delete();
      paperContour.delete();
    }

    renderStep('Outlined Paper', src, 'step-outlined');
    src.delete();
  } finally {
    // Free the temporary blob URL created for this upload.
    URL.revokeObjectURL(objectUrl);
  }
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
  container.appendChild(section);

  return (label, mat, modifier) => {
    const wrapper = document.createElement('figure');
    wrapper.className = 'processing-step';
    if (modifier) wrapper.classList.add(modifier);
    const title = document.createElement('figcaption');
    title.textContent = label;
    const stepCanvas = document.createElement('canvas');
    stepCanvas.className = 'processing-canvas';
    if (modifier) stepCanvas.classList.add(`${modifier}__canvas`);
    wrapper.appendChild(stepCanvas);
    wrapper.appendChild(title);
    section.appendChild(wrapper);

    if (mat.type() === cv.CV_8UC1) {
      const rgba = new cv.Mat();
      cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
      cv.imshow(stepCanvas, rgba);
      rgba.delete();
    } else {
      cv.imshow(stepCanvas, mat);
    }
  };
}

function ensureProcessingStyles() {
  if (document.getElementById('processing-step-styles')) return;
  const style = document.createElement('style');
  style.id = 'processing-step-styles';
  style.textContent = `
    .processing-steps {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 16px;
    }
    .processing-step {
      flex: 1 1 180px;
      max-width: 220px;
    }
    .processing-step figcaption {
      margin-top: 4px;
      font-size: 0.85rem;
      text-align: center;
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

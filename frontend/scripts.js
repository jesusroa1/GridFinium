const DOM_IDS = {
  input: 'file-upload',
  preview: 'preview',
};

const POLL_INTERVAL_MS = 50;

const fileInput = document.getElementById(DOM_IDS.input);
const previewContainer = document.getElementById(DOM_IDS.preview);
const cvReady = waitForOpenCv();

if (fileInput && previewContainer) {
  fileInput.addEventListener('change', handleFileSelection);
} else {
  console.warn('GridFinium: required DOM elements not found.');
}

async function handleFileSelection(event) {
  previewContainer.replaceChildren();

  const file = event.target?.files?.[0];
  if (!file) return;

  const canvas = createPreviewCanvas();
  const imageElement = new Image();
  const objectUrl = URL.createObjectURL(file);

  try {
    await loadImage(imageElement, objectUrl);
    sizeCanvasToImage(canvas, imageElement);
    previewContainer.replaceChildren(canvas);

    await cvReady;

    const src = cv.imread(imageElement);
    const paperContour = detectPaperContour(src);

    if (paperContour) {
      const outline = new cv.MatVector();
      outline.push_back(paperContour);
      cv.drawContours(src, outline, 0, new cv.Scalar(0, 255, 0, 255), 6, cv.LINE_AA);
      outline.delete();
      paperContour.delete();
    }

    cv.imshow(canvas, src);
    src.delete();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function createPreviewCanvas() {
  const canvas = document.createElement('canvas');
  canvas.id = 'canvasOutput';
  canvas.style.maxWidth = '75%';
  canvas.style.height = 'auto';
  return canvas;
}

function sizeCanvasToImage(canvas, imageElement) {
  canvas.width = imageElement.naturalWidth || imageElement.width;
  canvas.height = imageElement.naturalHeight || imageElement.height;
}

function loadImage(imageElement, src) {
  return new Promise((resolve, reject) => {
    imageElement.onload = () => resolve();
    imageElement.onerror = reject;
    imageElement.src = src;
  });
}

function waitForOpenCv() {
  if (window.cv && window.cv.Mat) return Promise.resolve();

  return new Promise((resolve) => {
    const settle = () => resolve();

    const bindRuntime = () => {
      if (!window.cv) return false;
      if (window.cv.Mat) {
        settle();
      } else {
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

function detectPaperContour(src) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 30, 90);

  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.dilate(edges, edges, kernel);
  cv.erode(edges, edges, kernel);
  kernel.delete();

  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const minArea = src.rows * src.cols * 0.15;
  let paper = null;
  let bestArea = 0;

  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i);
    const perimeter = cv.arcLength(contour, true);
    if (perimeter < 100) {
      contour.delete();
      continue;
    }

    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, 0.02 * perimeter, true);

    const area = cv.contourArea(approx);
    if (approx.rows === 4 && area > bestArea && area > minArea) {
      bestArea = area;
      if (paper) paper.delete();
      paper = approx;
    } else {
      approx.delete();
    }

    contour.delete();
  }

  gray.delete();
  blurred.delete();
  edges.delete();
  contours.delete();
  hierarchy.delete();

  return paper;
}

const DOM_IDS = {
  input: 'file-upload',
  preview: 'preview',
};

const POLL_INTERVAL_MS = 50;

const fileInput = document.getElementById(DOM_IDS.input);
const previewContainer = document.getElementById(DOM_IDS.preview);
const cvReady = waitForOpenCv();

// Optional check: only register handlers when both required DOM nodes are present.
if (fileInput && previewContainer) {
  fileInput.addEventListener('change', handleFileSelection);
} else {
  console.warn('GridFinium: required DOM elements not found.');
}

async function handleFileSelection(event) {
  previewContainer.replaceChildren();

  // Optional check: safely pull the first selected file without assuming the input exists.
  const file = event.target?.files?.[0];
  // Optional check: stop gracefully when no file is provided (e.g. user cancels file picker).
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
  // Optional check: naturalWidth provides real pixel dimensions; fall back to width when unavailable.
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
  // Optional check: resolve immediately when OpenCV already finished bootstrapping.
  if (window.cv?.Mat) return Promise.resolve();

  return new Promise((resolve) => {
    const settle = () => resolve();

    const bindRuntime = () => {
      // Optional check: wait until the cv global exists before binding runtime hooks.
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

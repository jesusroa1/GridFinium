import {
  HINT_TUNING_DEFAULTS,
  setActiveImageMat,
  setHintProcessingStepsRenderer,
  attachPaperOverlay,
  applyHintTuningState,
  getHintTuningConfig,
} from './js/ObjectOutlining.js';

// IDs for the upload input and the area where we show the result.
const DOM_IDS = {
  input: 'file-upload',
  preview: 'preview',
};

const TEST_IMAGES = Object.freeze([
  {
    id: 'test-image-mouse',
    label: 'Mouse on paper',
    src: 'frontend/test-images/mouse.png.jpeg',
  },
  {
    id: 'test-image-remote',
    label: 'Remote on paper',
    src: 'frontend/test-images/remote.png.jpeg',
  },
  {
    id: 'test-image-coaster',
    label: 'Coaster top on paper',
    src: 'frontend/test-images/coaster-top.png.jpeg',
  },
]);

const TEST_IMAGE_LOOKUP = new Map(TEST_IMAGES.map((image) => [image.id, image]));
const DEFAULT_PREVIEW_FALLBACK = 'example_coaster.jpeg';
const DEFAULT_IMAGE_PATH = TEST_IMAGES[0]?.src ?? DEFAULT_PREVIEW_FALLBACK;
const TEST_IMAGE_PICKER_ID = 'test-image-picker';
const TEST_IMAGE_BUTTON_ACTIVE_CLASS = 'test-image-button--active';

const TAB_DATA_ATTRIBUTE = 'data-tab-target';
const COLOR_THEME_STORAGE_KEY = 'gridfinium:color-theme';
const COLOR_THEMES = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
});
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

const HINT_TUNING_INPUT_IDS = Object.freeze({
  low: 'hint-threshold-low',
  high: 'hint-threshold-high',
  kernel: 'hint-kernel-size',
  minArea: 'hint-min-area',
  paperTolerance: 'hint-paper-tolerance',
  showSteps: 'hint-show-steps',
  enableErode: 'hint-enable-erode',
  fusionMode: 'hint-fusion-mode',
});

const POLL_INTERVAL_MS = 50;
// Only keep the top five contours so we avoid rendering dozens of shapes.
// Keep preview canvases to a mobile-friendly size so zooming never tries to render
// the original multi-megapixel image at full resolution.
const MAX_DISPLAY_DIMENSION = 1280;
let processingStepsIdCounter = 0;

let fileInput = null;
let previewContainer = null;
let cvReady = null;
let activePreviewToken = 0;
let activePaperProcessingSteps = null;
let activeHintProcessingSteps = null;
let testImageButtons = [];
let activeTestImageId = null;
let defaultPreviewLoaded = false;
let detectPaperContourImpl = null;
let extractContourPointsImpl = null;
const overlayControllers = new WeakMap();

export function bootGridFinium(dependencies = {}) {
  const {
    detectPaperContour: detectPaperContourDependency,
    extractContourPoints: extractContourPointsDependency,
  } = dependencies;

  detectPaperContourImpl = typeof detectPaperContourDependency === 'function'
    ? detectPaperContourDependency
    : null;
  extractContourPointsImpl = typeof extractContourPointsDependency === 'function'
    ? extractContourPointsDependency
    : null;

  fileInput = document.getElementById(DOM_IDS.input);
  previewContainer = document.getElementById(DOM_IDS.preview);
  cvReady = waitForOpenCv();
  activePreviewToken = 0;
  setActiveImageMat(null);
  activePaperProcessingSteps = null;
  activeHintProcessingSteps = null;
  testImageButtons = [];
  activeTestImageId = null;
  defaultPreviewLoaded = false;
  processingStepsIdCounter = 0;

  if (fileInput && previewContainer) {
    fileInput.removeEventListener('change', handleFileSelection);
    fileInput.addEventListener('change', handleFileSelection);
    defaultPreviewLoaded = setupTestImagePicker();
  } else {
    console.warn('GridFinium: required DOM elements not found.');
  }

  if (!defaultPreviewLoaded) {
    loadDefaultPreview(DEFAULT_IMAGE_PATH);
  }

  setupTabs();
  setupHintTuningControls();
  setupThemeToggle();

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
}

function setupThemeToggle() {
  const themeToggleButton = document.getElementById('theme-toggle');
  if (!themeToggleButton) return;

  const rootElement = document.documentElement;
  const systemPreferenceQuery = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;

  const applyTheme = (theme) => {
    const normalizedTheme = theme === COLOR_THEMES.DARK ? COLOR_THEMES.DARK : COLOR_THEMES.LIGHT;
    const isDark = normalizedTheme === COLOR_THEMES.DARK;
    rootElement.setAttribute('data-theme', normalizedTheme);
    themeToggleButton.setAttribute('aria-pressed', String(isDark));
    themeToggleButton.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
    themeToggleButton.classList.toggle('theme-toggle--dark', isDark);
  };

  const storedTheme = localStorage.getItem(COLOR_THEME_STORAGE_KEY);
  const hasStoredTheme = storedTheme === COLOR_THEMES.LIGHT || storedTheme === COLOR_THEMES.DARK;
  const systemPrefersDark = systemPreferenceQuery?.matches ?? false;
  let activeTheme = hasStoredTheme ? storedTheme : systemPrefersDark ? COLOR_THEMES.DARK : COLOR_THEMES.LIGHT;
  let respectSystemPreference = !hasStoredTheme;

  applyTheme(activeTheme);

  // Keep the UI in sync with the operating system preference until the user overrides it.
  if (respectSystemPreference && systemPreferenceQuery) {
    const handleSystemThemeChange = (event) => {
      if (!respectSystemPreference) return;
      activeTheme = event.matches ? COLOR_THEMES.DARK : COLOR_THEMES.LIGHT;
      applyTheme(activeTheme);
    };

    if (typeof systemPreferenceQuery.addEventListener === 'function') {
      systemPreferenceQuery.addEventListener('change', handleSystemThemeChange);
    } else if (typeof systemPreferenceQuery.addListener === 'function') {
      systemPreferenceQuery.addListener(handleSystemThemeChange);
    }
  }

  themeToggleButton.addEventListener('click', () => {
    respectSystemPreference = false;
    activeTheme = activeTheme === COLOR_THEMES.DARK ? COLOR_THEMES.LIGHT : COLOR_THEMES.DARK;
    applyTheme(activeTheme);

    try {
      localStorage.setItem(COLOR_THEME_STORAGE_KEY, activeTheme);
    } catch (storageError) {
      console.warn('GridFinium: unable to store theme preference.', storageError);
    }
  });
}

async function handleFileSelection(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  setActiveTestImage(null);

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
  activePaperProcessingSteps = null;
  activeHintProcessingSteps = null;
  setHintProcessingStepsRenderer(null);

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
    startExpanded: false,
  });
  setHintProcessingStepsRenderer(activeHintProcessingSteps);
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

    const paperContour = detectPaperContourImpl
      ? detectPaperContourImpl(src, renderStep)
      : null;

    let finalDisplay = src;
    let finalOptions;

    if (paperContour) {
      const corners = extractContourPointsImpl
        ? extractContourPointsImpl(paperContour)
        : [];
      finalDisplay = src.clone();
      const outline = new cv.MatVector();
      outline.push_back(paperContour);
      cv.drawContours(finalDisplay, outline, 0, new cv.Scalar(0, 255, 0, 255), 6, cv.LINE_AA);
      outline.delete();
      finalOptions = {
        onRender: (info) => {
          const controller = attachPaperOverlay(resultOverlay, corners, info);
          overlayControllers.set(resultOverlay, controller);
        },
      };
      paperContour.delete();
    } else {
      finalOptions = {
        onRender: (info) => {
          const controller = attachPaperOverlay(resultOverlay, null, info);
          overlayControllers.set(resultOverlay, controller);
        },
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

// Build the toggle buttons that let users try the bundled sample photos.
function setupTestImagePicker() {
  const picker = document.getElementById(TEST_IMAGE_PICKER_ID);
  if (!picker) return false;

  const buttons = Array.from(picker.querySelectorAll('[data-test-image-id]'));
  if (buttons.length === 0) return false;

  testImageButtons = buttons;

  buttons.forEach((button) => {
    const imageId = button.getAttribute('data-test-image-id');
    const testImage = TEST_IMAGE_LOOKUP.get(imageId);

    button.type = 'button';
    button.setAttribute('aria-pressed', 'false');

    if (!testImage) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
      return;
    }

    button.addEventListener('click', () => {
      if (activeTestImageId === imageId) return;

      setActiveTestImage(imageId);
      if (fileInput) {
        fileInput.value = '';
      }
      loadDefaultPreview(testImage.src);
    });
  });

  const defaultImage = TEST_IMAGES[0];
  if (defaultImage) {
    setActiveTestImage(defaultImage.id);
    loadDefaultPreview(defaultImage.src);
    return true;
  }

  return false;
}

// Highlight the active sample image button and reset when uploads occur.
function setActiveTestImage(testImageId) {
  activeTestImageId = testImageId;

  if (!testImageButtons.length) return;

  testImageButtons.forEach((button) => {
    const isActive = button.getAttribute('data-test-image-id') === testImageId;
    button.classList.toggle(TEST_IMAGE_BUTTON_ACTIVE_CLASS, isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
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
  overlay.tabIndex = 0;
  overlay.setAttribute('role', 'application');
  overlay.setAttribute('aria-label', 'Image overlay: left-click to add hints; right-click or Ctrl/Cmd-click to draw exclusion zones; double-click to finish a zone; press Escape to cancel drawing.');
  overlay.setAttribute('title', 'Left-click to add hints. Right-click or Ctrl/Cmd-click to draw exclusion zones. Double-click to close a zone. Press Escape to cancel drawing.');
  overlay.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

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
    const controller = overlayControllers.get(overlay);
    controller?.resetHints();
  });
  resetHintsButton.setAttribute('aria-label', 'Remove all hint points');
  resetHintsButton.setAttribute('title', 'Remove all hint points');

  const resetExclusionsButton = document.createElement('button');
  resetExclusionsButton.type = 'button';
  resetExclusionsButton.className = 'preview-result__button';
  resetExclusionsButton.textContent = 'Reset exclusions';
  resetExclusionsButton.disabled = true;
  resetExclusionsButton.addEventListener('click', () => {
    const controller = overlayControllers.get(overlay);
    controller?.resetExclusions();
  });
  resetExclusionsButton.setAttribute('aria-label', 'Remove all exclusion zones');
  resetExclusionsButton.setAttribute('title', 'Remove all exclusion zones');

  controls.appendChild(resetHintsButton);
  controls.appendChild(resetExclusionsButton);
  section.appendChild(controls);
  overlay.addEventListener('gridfinium:overlay-state', (event) => {
    const detail = event.detail ?? {};
    const hintCount = Number(detail.hintCount) || 0;
    const exclusionCount = Number(detail.exclusionCount) || 0;
    resetHintsButton.disabled = hintCount === 0;
    resetExclusionsButton.disabled = exclusionCount === 0;
  });
  container.appendChild(section);

  return { heading, canvas, overlay };
}

function loadDefaultPreview(imageSrc) {
  processImageFromSource(imageSrc).catch((error) => {
    console.error('GridFinium: failed to load default preview image.', error);

    if (imageSrc === DEFAULT_PREVIEW_FALLBACK) {
      return;
    }

    if (activeTestImageId) {
      setActiveTestImage(null);
    }

    processImageFromSource(DEFAULT_PREVIEW_FALLBACK).catch((fallbackError) => {
      console.error('GridFinium: failed to load fallback preview image.', fallbackError);
    });
  });
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
  const paperToleranceInput = document.getElementById(HINT_TUNING_INPUT_IDS.paperTolerance);
  const showStepsInput = document.getElementById(HINT_TUNING_INPUT_IDS.showSteps);
  const erodeInput = document.getElementById(HINT_TUNING_INPUT_IDS.enableErode);
  const fusionModeInput = document.getElementById(HINT_TUNING_INPUT_IDS.fusionMode);

  if (tuningContent && tuningToggle) {
    let tuningExpanded = false;

    const syncTuningContent = () => {
      tuningContent.dataset.expanded = tuningExpanded ? 'true' : 'false';
      tuningContent.setAttribute('aria-hidden', String(!tuningExpanded));
      tuningToggle.setAttribute('aria-expanded', String(tuningExpanded));
      tuningToggle.textContent = tuningExpanded ? 'Hide details' : 'Show details';
      tuningContent.style.maxHeight = tuningExpanded ? `${tuningContent.scrollHeight}px` : '0px';
    };

    tuningToggle.addEventListener('click', () => {
      tuningExpanded = !tuningExpanded;
      syncTuningContent();
    });

    syncTuningContent();
    requestAnimationFrame(syncTuningContent);
  }

  if (
    !lowInput
    || !highInput
    || !kernelInput
    || !minAreaInput
    || !paperToleranceInput
    || !showStepsInput
    || !erodeInput
    || !fusionModeInput
  ) {
    return;
  }

  const syncInputsFromState = () => {
    const config = getHintTuningConfig();
    lowInput.value = config.cannyLowThreshold;
    highInput.value = config.cannyHighThreshold;
    highInput.min = String(config.cannyLowThreshold);
    kernelInput.value = config.kernelSize;

    const percentValue = config.minAreaRatio * 100;
    let formattedPercent;
    if (!Number.isFinite(percentValue)) {
      formattedPercent = (HINT_TUNING_DEFAULTS.minAreaRatio * 100).toString();
    } else if (percentValue === 0) {
      formattedPercent = '0';
    } else {
      formattedPercent = percentValue.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    }
    minAreaInput.value = formattedPercent;

    const tolerancePercent = config.paperExclusionTolerance * 100;
    let formattedTolerance;
    if (!Number.isFinite(tolerancePercent)) {
      formattedTolerance = (HINT_TUNING_DEFAULTS.paperExclusionTolerance * 100).toString();
    } else if (tolerancePercent === 0) {
      formattedTolerance = '0';
    } else {
      formattedTolerance = tolerancePercent.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    }
    paperToleranceInput.value = formattedTolerance;

    showStepsInput.checked = Boolean(config.showProcessingSteps);
    erodeInput.checked = Boolean(config.enableErodeStep);
    fusionModeInput.value = config.fusionMode;
  };

  applyHintTuningState({ ...HINT_TUNING_DEFAULTS }, { rerunSelection: false });
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

  paperToleranceInput.addEventListener('change', () => {
    const raw = Number(paperToleranceInput.value);
    if (!Number.isFinite(raw) || raw < 0) {
      syncInputsFromState();
      return;
    }

    applyHintTuningState({ paperExclusionTolerance: raw / 100 });
    syncInputsFromState();
  });

  showStepsInput.addEventListener('change', () => {
    applyHintTuningState({ showProcessingSteps: showStepsInput.checked }, { rerunSelection: false });
    syncProcessingStepsVisibility();
  });

  erodeInput.addEventListener('change', () => {
    applyHintTuningState({ enableErodeStep: erodeInput.checked });
    syncInputsFromState();
  });

  fusionModeInput.addEventListener('change', () => {
    const value = fusionModeInput.value;
    applyHintTuningState({ fusionMode: value });
    syncInputsFromState();
  });
}

function syncProcessingStepsVisibility() {
  const visible = Boolean(getHintTuningConfig().showProcessingSteps);
  if (activePaperProcessingSteps) {
    activePaperProcessingSteps.setVisible(visible);
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

  const clampUnit = (value) => Math.min(Math.max(value, 0), 1);

  context.save();
  context.beginPath();
  polygon.forEach((point, index) => {
    if (!point) return;
    const x = clampUnit(point.x) * width;
    const y = clampUnit(point.y) * height;
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

  const clampUnit = (value) => Math.min(Math.max(value, 0), 1);
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
    const x = clampUnit(point.x) * width;
    const y = clampUnit(point.y) * height;

    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    if (fillStyle) context.fill();
    if (strokeStyle && lineWidth > 0) context.stroke();
  });

  context.restore();
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
    .preview-result__exclusions {
      pointer-events: none;
    }
    .preview-result__exclusion {
      fill: rgba(248, 113, 113, 0.24);
      stroke: #ef4444;
      stroke-width: 3;
      vector-effect: non-scaling-stroke;
      pointer-events: none;
    }
    .preview-result__exclusion--active {
      fill: rgba(248, 113, 113, 0.15);
      stroke-dasharray: 8 4;
    }
    .preview-result__exclusion[data-visible="false"] {
      display: none;
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
      gap: 8px;
      flex-wrap: wrap;
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
      border: 1px solid var(--color-processing-border);
      border-radius: 12px;
      background: var(--color-processing-surface);
      overflow: hidden;
      box-shadow: var(--shadow-card);
      transition: background 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
    }
    .processing-steps__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: linear-gradient(135deg, var(--color-processing-header-start), var(--color-processing-header-end));
    }
    .processing-steps__title {
      margin: 0;
      font-size: clamp(1.35rem, 2.5vw, 1.6rem);
      font-weight: 700;
    }
    .processing-steps__toggle {
      border: none;
      background: var(--color-accent);
      color: var(--color-accent-contrast);
      padding: 6px 14px;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
      box-shadow: var(--shadow-button-primary);
    }
    .processing-steps__toggle:hover {
      background: var(--color-accent-hover);
      transform: translateY(-1px);
      box-shadow: var(--shadow-button-primary-hover);
    }
    .processing-steps--disabled .processing-steps__toggle {
      opacity: 0.6;
      cursor: not-allowed;
      background: var(--color-processing-toggle-disabled);
      box-shadow: none;
      transform: none;
    }
    .processing-steps--disabled .processing-steps__toggle:hover {
      background: var(--color-processing-toggle-disabled);
      transform: none;
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
      color: var(--color-muted-text);
    }
    .processing-step .processing-canvas {
      width: 100%;
      height: auto;
      border: 1px solid var(--color-processing-canvas-border);
      border-radius: 8px;
      background: var(--color-processing-canvas-bg);
      box-shadow: var(--shadow-card);
      transition: border-color 0.3s ease, background 0.3s ease, box-shadow 0.3s ease;
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







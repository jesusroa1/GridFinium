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


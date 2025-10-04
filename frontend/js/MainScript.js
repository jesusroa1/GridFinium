import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import {
  HINT_TUNING_DEFAULTS,
  setActiveImageMat,
  setHintProcessingStepsRenderer,
  attachPaperOverlay,
  applyHintTuningState,
  getHintTuningConfig,
  OVERLAY_INTERACTION_MODES,
} from './ObjectOutlining.js';
import { ensureThreeJs, initStlDesigner } from './STLLogic.js';

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
const MAX_DISPLAY_DIMENSION = 1280;

const stlDesignerOptions = {
  viewerId: 'stl-viewer',
  widthInputId: 'stl-width',
  depthInputId: 'stl-depth',
  heightInputId: 'stl-height',
  summaryId: 'stl-summary',
  downloadButtonId: 'stl-download',
  resetButtonId: 'stl-reset',
};

let fileInput = null;
let previewContainer = null;
let cvReady = null;
let activePreviewToken = 0;
let activePaperProcessingSteps = null;
let activeHintProcessingSteps = null;
let testImageButtons = [];
let activeTestImageId = null;
let defaultPreviewLoaded = false;

const overlayControllers = new WeakMap();
let processingStepsIdCounter = 0;

boot();

function boot() {
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

  ensureThreeJs().finally(() => {
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
  const paperSteps = createStepRenderer(previewContainer, {
    titleText: 'Paper Processing Steps',
    startExpanded: false,
  });
  activePaperProcessingSteps = paperSteps;
  activeHintProcessingSteps = createStepRenderer(previewContainer, {
    titleText: 'Hint Processing Steps',
    hideWhenEmpty: true,
    startExpanded: true,
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
  overlay.setAttribute(
    'aria-label',
    'Image overlay: use the click mode toggle to choose between adding hints or drawing exclusion zones. Right-click or Ctrl/Cmd-click also draws exclusions. Double-click to finish a zone; press Escape to cancel drawing.',
  );
  overlay.setAttribute(
    'title',
    'Use the click mode toggle to decide whether left-click adds hints or draws exclusion zones. Right-click or Ctrl/Cmd-click also draws exclusions. Double-click to close a zone. Press Escape to cancel drawing.',
  );
  overlay.addEventListener('contextmenu', (event) => {
    event.preventDefault();
  });

  canvasWrapper.appendChild(canvas);
  canvasWrapper.appendChild(overlay);
  section.appendChild(heading);
  section.appendChild(canvasWrapper);

  const controls = document.createElement('div');
  controls.className = 'preview-result__controls';

  const modeToggle = document.createElement('div');
  modeToggle.className = 'preview-result__mode-toggle';
  modeToggle.setAttribute('role', 'group');
  modeToggle.setAttribute('aria-label', 'Click mode');

  const modeLabel = document.createElement('span');
  modeLabel.className = 'preview-result__mode-label';
  modeLabel.textContent = 'Click adds:';
  modeToggle.appendChild(modeLabel);

  const hintModeButton = document.createElement('button');
  hintModeButton.type = 'button';
  hintModeButton.className = 'preview-result__mode-button';
  hintModeButton.textContent = 'Hints';
  hintModeButton.setAttribute('aria-pressed', 'true');
  hintModeButton.disabled = true;

  const exclusionModeButton = document.createElement('button');
  exclusionModeButton.type = 'button';
  exclusionModeButton.className = 'preview-result__mode-button';
  exclusionModeButton.textContent = 'Exclusions';
  exclusionModeButton.setAttribute('aria-pressed', 'false');
  exclusionModeButton.disabled = true;

  modeToggle.appendChild(hintModeButton);
  modeToggle.appendChild(exclusionModeButton);

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

  const updateModeButtons = (activeMode) => {
    const normalized = activeMode === OVERLAY_INTERACTION_MODES.EXCLUSION
      ? OVERLAY_INTERACTION_MODES.EXCLUSION
      : OVERLAY_INTERACTION_MODES.HINT;
    hintModeButton.setAttribute('aria-pressed', normalized === OVERLAY_INTERACTION_MODES.HINT ? 'true' : 'false');
    exclusionModeButton.setAttribute('aria-pressed', normalized === OVERLAY_INTERACTION_MODES.EXCLUSION ? 'true' : 'false');
    hintModeButton.disabled = false;
    exclusionModeButton.disabled = false;
  };

  hintModeButton.addEventListener('click', () => {
    const controller = overlayControllers.get(overlay);
    const mode = controller?.setInteractionMode?.(OVERLAY_INTERACTION_MODES.HINT);
    updateModeButtons(mode ?? OVERLAY_INTERACTION_MODES.HINT);
  });

  exclusionModeButton.addEventListener('click', () => {
    const controller = overlayControllers.get(overlay);
    const mode = controller?.setInteractionMode?.(OVERLAY_INTERACTION_MODES.EXCLUSION);
    updateModeButtons(mode ?? OVERLAY_INTERACTION_MODES.EXCLUSION);
  });

  controls.appendChild(modeToggle);
  controls.appendChild(resetHintsButton);
  controls.appendChild(resetExclusionsButton);
  section.appendChild(controls);
  overlay.addEventListener('gridfinium:overlay-state', (event) => {
    const detail = event.detail ?? {};
    const hintCount = Number(detail.hintCount) || 0;
    const exclusionCount = Number(detail.exclusionCount) || 0;
    resetHintsButton.disabled = hintCount === 0;
    resetExclusionsButton.disabled = exclusionCount === 0;
    updateModeButtons(detail.interactionMode ?? OVERLAY_INTERACTION_MODES.HINT);
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
    const state = getHintTuningConfig();

    if (lowInput.type === 'number') {
      lowInput.value = state.cannyLowThreshold.toString();
    }
    if (highInput.type === 'number') {
      highInput.value = state.cannyHighThreshold.toString();
    }
    if (kernelInput.type === 'number') {
      kernelInput.value = state.kernelSize.toString();
    }
    if (minAreaInput.type === 'number') {
      const normalizedValue = Math.max(0, Math.min(1, state.minAreaRatio));
      minAreaInput.value = (normalizedValue * 100).toFixed(4);
    }
    if (paperToleranceInput.type === 'number') {
      const normalizedTolerance = Math.max(0, Math.min(1, state.paperExclusionTolerance));
      paperToleranceInput.value = (normalizedTolerance * 100).toFixed(2);
    }
    if (showStepsInput.type === 'checkbox') {
      showStepsInput.checked = Boolean(state.showProcessingSteps);
    }
    if (erodeInput.type === 'checkbox') {
      erodeInput.checked = Boolean(state.enableErodeStep);
    }
    if (fusionModeInput.tagName === 'SELECT') {
      fusionModeInput.value = state.fusionMode;
    }
  };

  syncInputsFromState();

  const parseInteger = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const parseFloatValue = (value, fallback) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  lowInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const low = parseInteger(lowInput.value, state.cannyLowThreshold);
    applyHintTuningState({ cannyLowThreshold: low });
    syncInputsFromState();
  });

  highInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const high = parseInteger(highInput.value, state.cannyHighThreshold);
    applyHintTuningState({ cannyHighThreshold: high });
    syncInputsFromState();
  });

  kernelInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const kernel = parseInteger(kernelInput.value, state.kernelSize);
    applyHintTuningState({ kernelSize: kernel });
    syncInputsFromState();
  });

  minAreaInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const value = parseFloatValue(minAreaInput.value, state.minAreaRatio * 100) / 100;
    applyHintTuningState({ minAreaRatio: value });
    syncInputsFromState();
  });

  paperToleranceInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const value = parseFloatValue(paperToleranceInput.value, state.paperExclusionTolerance * 100) / 100;
    applyHintTuningState({ paperExclusionTolerance: value });
    syncInputsFromState();
  });

  showStepsInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    applyHintTuningState({ showProcessingSteps: Boolean(showStepsInput.checked) });
    syncInputsFromState();
    syncProcessingStepsVisibility();
  });

  erodeInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    applyHintTuningState({ enableErodeStep: Boolean(erodeInput.checked) });
    syncInputsFromState();
  });

  fusionModeInput.addEventListener('change', () => {
    const state = getHintTuningConfig();
    const fallback = state.fusionMode;
    const nextValue = typeof fusionModeInput.value === 'string' ? fusionModeInput.value : fallback;
    applyHintTuningState({ fusionMode: nextValue });
    syncInputsFromState();
  });

  const resetButton = document.getElementById('hint-reset');
  if (resetButton) {
    resetButton.addEventListener('click', () => {
      applyHintTuningState({ ...HINT_TUNING_DEFAULTS }, { rerunSelection: false });
      syncInputsFromState();
      syncProcessingStepsVisibility();
    });
  }
}

function syncProcessingStepsVisibility() {
  const hintConfig = getHintTuningConfig();
  const shouldShowHintSteps = Boolean(hintConfig.showProcessingSteps);

  if (activePaperProcessingSteps) {
    activePaperProcessingSteps.setExpanded(false);
    activePaperProcessingSteps.setVisible(true);
  }

  if (activeHintProcessingSteps) {
    activeHintProcessingSteps.setExpanded(true);
    activeHintProcessingSteps.setVisible(shouldShowHintSteps);
  }
}

function createStepRenderer(container, options = {}) {
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
  const width = mat.cols;
  const height = mat.rows;

  if (width <= MAX_DISPLAY_DIMENSION && height <= MAX_DISPLAY_DIMENSION) {
    return {
      displayMat: mat,
      cleanup: () => {},
      originalWidth: width,
      originalHeight: height,
      displayWidth: width,
      displayHeight: height,
    };
  }

  const scale = MAX_DISPLAY_DIMENSION / Math.max(width, height);
  const displayWidth = Math.round(width * scale);
  const displayHeight = Math.round(height * scale);
  const displayMat = new cv.Mat();
  cv.resize(mat, displayMat, new cv.Size(displayWidth, displayHeight), 0, 0, cv.INTER_AREA);

  return {
    displayMat,
    cleanup: () => {
      displayMat.delete();
    },
    originalWidth: width,
    originalHeight: height,
    displayWidth,
    displayHeight,
  };
}

function loadImage(imageElement, src) {
  return new Promise((resolve, reject) => {
    const handleLoad = () => {
      cleanup();
      resolve();
    };

    const handleError = (error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      imageElement.removeEventListener('load', handleLoad);
      imageElement.removeEventListener('error', handleError);
    };

    imageElement.addEventListener('load', handleLoad);
    imageElement.addEventListener('error', handleError);
    imageElement.src = src;
  });
}

function waitForOpenCv() {
  if (typeof cv !== 'undefined' && cv.Mat) {
    return Promise.resolve();
  }

  if (typeof window === 'undefined') {
    return Promise.reject(new Error('OpenCV is only available in the browser.'));
  }

  return new Promise((resolve, reject) => {
    const interval = window.setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        window.clearInterval(interval);
        resolve();
      }
    }, POLL_INTERVAL_MS);

    window.setTimeout(() => {
      window.clearInterval(interval);
      reject(new Error('OpenCV initialization timed out.'));
    }, 10000);
  });
}

let processingStylesInjected = false;

function ensureProcessingStyles() {
  if (processingStylesInjected) return;

  const style = document.createElement('style');
  style.textContent = `
    .preview-result {
      margin-top: 24px;
      padding: 24px;
      border-radius: 16px;
      background: var(--color-surface);
      box-shadow: var(--shadow-card);
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .preview-result__heading {
      margin: 0;
      font-size: clamp(1.5rem, 3vw, 1.8rem);
      font-weight: 700;
      color: var(--color-subtle-text);
    }
    .preview-result__canvas-wrapper {
      position: relative;
      width: 100%;
      border-radius: 12px;
      overflow: hidden;
      background: linear-gradient(135deg, var(--color-viewer-bg-start), var(--color-viewer-bg-end));
      box-shadow: var(--shadow-card);
    }
    .preview-result__canvas {
      width: 100%;
      height: auto;
      display: block;
    }
    .preview-result__overlay {
      position: absolute;
      inset: 0;
      outline: none;
    }
    .preview-result__svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .preview-result__outline {
      fill: rgba(34, 197, 94, 0.12);
      stroke: #22c55e;
      stroke-width: 6;
      stroke-linejoin: round;
      pointer-events: none;
    }
    .preview-result__exclusions {
      pointer-events: none;
    }
    .preview-result__exclusion {
      fill: rgba(239, 68, 68, 0.16);
      stroke: rgba(239, 68, 68, 0.85);
      stroke-width: 5;
      stroke-linejoin: round;
    }
    .preview-result__exclusion--active {
      fill: rgba(239, 68, 68, 0.1);
      stroke-dasharray: 12 8;
    }
    .preview-result__exclusion[data-visible="false"],
    .preview-result__selection[data-visible="false"] {
      display: none;
    }
    .preview-result__selection {
      fill: rgba(99, 102, 241, 0.18);
      stroke: rgba(79, 70, 229, 0.85);
      stroke-width: 4;
      stroke-linejoin: round;
    }
    .preview-result__hint-layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }
    .preview-result__hint-point {
      position: absolute;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #38bdf8;
      border: 2px solid #0ea5e9;
      box-shadow: 0 4px 8px rgba(14, 165, 233, 0.35);
      transform: translate(-50%, -50%);
    }
    .preview-result__controls {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .preview-result__mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--color-surface-subtle);
      border: 1px solid var(--color-border-soft);
    }
    .preview-result__mode-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--color-muted-text);
    }
    .preview-result__mode-button {
      border: none;
      background: transparent;
      color: var(--color-muted-text);
      padding: 6px 14px;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
    }
    .preview-result__mode-button[aria-pressed="true"] {
      background: var(--color-accent);
      color: var(--color-accent-contrast);
      box-shadow: var(--shadow-button-primary);
      transform: translateY(-1px);
    }
    .preview-result__mode-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }
    .preview-result__mode-button:not(:disabled):hover,
    .preview-result__mode-button:not(:disabled):focus-visible {
      background: var(--color-accent-hover);
      color: var(--color-accent-contrast);
      outline: none;
      box-shadow: var(--shadow-button-primary-hover);
      transform: translateY(-1px);
    }
    .preview-result__button {
      border: none;
      background: var(--color-accent);
      color: var(--color-accent-contrast);
      padding: 10px 20px;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
      box-shadow: var(--shadow-button-primary);
    }
    .preview-result__button:hover {
      background: var(--color-accent-hover);
      transform: translateY(-1px);
      box-shadow: var(--shadow-button-primary-hover);
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
  processingStylesInjected = true;
}

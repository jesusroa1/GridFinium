const OVERLAY_COORDINATE_SCALE = 1000;
const MAX_DISPLAY_DIMENSION = 1280;
const MAX_DISPLAY_CONTOURS = 5;
const PERIMETER_COMPARISON_EPSILON = 1e-2;
const NORMALIZED_GEOMETRY_EPSILON = 1e-6;

export const HINT_TUNING_DEFAULTS = Object.freeze({
  cannyLowThreshold: 10,
  cannyHighThreshold: 50,
  enableAutoCanny: true,
  autoCannySigma: 0.33,
  kernelSize: 5,
  minAreaRatio: 0.00001,
  paperExclusionTolerance: 0.1,
  showProcessingSteps: true,
  enableErodeStep: true,
  enableThresholdBranch: true,
  thresholdMode: 'otsu', // 'otsu' | 'adaptive'
  morphCloseSize: 3,
  morphOpenSize: 3,
  fusionMode: 'and', // 'edge' | 'threshold' | 'and' | 'or'
});

let hintTuningState = { ...HINT_TUNING_DEFAULTS };
let activeImageMat = null;
let activeOverlayElement = null;
let activeHintProcessingSteps = null;

const overlayStateMap = new WeakMap();
const overlayControllerMap = new WeakMap();

let globalListenersBound = false;

function ensureGlobalListeners() {
  if (globalListenersBound || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleGlobalKeyDown, true);
  globalListenersBound = true;
}

export function setActiveImageMat(mat) {
  if (activeImageMat) {
    activeImageMat.delete();
    activeImageMat = null;
  }

  if (mat) {
    activeImageMat = mat.clone();
  }
}

export function setHintProcessingStepsRenderer(renderer) {
  activeHintProcessingSteps = renderer ?? null;
  updateHintProcessingStepsVisibility();
}

export function attachPaperOverlay(overlay, corners, renderInfo) {
  if (!overlay) return null;

  ensureGlobalListeners();

  overlay.replaceChildren();

  const state = {
    displayInfo: renderInfo || null,
    selectionPath: null,
    paperOutline: null,
    exclusions: [],
    exclusionElements: [],
    activeExclusion: null,
    exclusionLayer: null,
    activeExclusionPath: null,
    hintLayer: null,
    hintPoints: [],
    lastHintPixel: null,
    overlay,
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

    state.paperOutline = normalizedCorners.map((corner) => ({
      x: clamp(corner.x, 0, 1),
      y: clamp(corner.y, 0, 1),
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
      state.paperOutline = normalizedCorners.map((corner) => ({
        x: clamp(corner.x, 0, 1),
        y: clamp(corner.y, 0, 1),
      }));
    };
  }

  const exclusionsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  exclusionsGroup.classList.add('preview-result__exclusions');
  svg.appendChild(exclusionsGroup);
  state.exclusionLayer = exclusionsGroup;

  const activeExclusion = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  activeExclusion.classList.add('preview-result__exclusion', 'preview-result__exclusion--active');
  activeExclusion.dataset.visible = 'false';
  activeExclusion.setAttribute('points', '');
  exclusionsGroup.appendChild(activeExclusion);
  state.activeExclusionPath = activeExclusion;

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

  renderExclusions(state);

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
  overlay.removeEventListener('pointerdown', handleOverlayPointerDown);
  overlay.addEventListener('pointerdown', handleOverlayPointerDown);
  overlay.removeEventListener('dblclick', handleOverlayDoubleClick);
  overlay.addEventListener('dblclick', handleOverlayDoubleClick);

  notifyOverlayStateChange(overlay, state);

  return getOverlayController(overlay);
}

export function applyHintTuningState(partial, options = {}) {
  hintTuningState = { ...hintTuningState, ...partial };

  const normalized = getHintTuningConfig();
  hintTuningState = {
    ...hintTuningState,
    cannyLowThreshold: normalized.cannyLowThreshold,
    cannyHighThreshold: normalized.cannyHighThreshold,
    kernelSize: normalized.kernelSize,
    minAreaRatio: normalized.minAreaRatio,
    paperExclusionTolerance: normalized.paperExclusionTolerance,
    enableErodeStep: Boolean(normalized.enableErodeStep),
    enableAutoCanny: Boolean(normalized.enableAutoCanny),
    autoCannySigma: normalized.autoCannySigma,
    enableThresholdBranch: Boolean(normalized.enableThresholdBranch),
    thresholdMode: normalized.thresholdMode,
    morphCloseSize: normalized.morphCloseSize,
    morphOpenSize: normalized.morphOpenSize,
    fusionMode: normalized.fusionMode,
    showProcessingSteps: Boolean(partial.showProcessingSteps ?? hintTuningState.showProcessingSteps),
  };

  updateHintProcessingStepsVisibility();

  if (options.rerunSelection !== false) {
    rerunHintSelection();
  }

  return normalized;
}

export function getHintTuningConfig() {
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

  const paperToleranceCandidate = Number(hintTuningState.paperExclusionTolerance);
  const paperExclusionTolerance = clamp(
    Number.isFinite(paperToleranceCandidate) ? paperToleranceCandidate : HINT_TUNING_DEFAULTS.paperExclusionTolerance,
    0,
    1,
  );

  const enableErodeStep = hintTuningState.enableErodeStep;
  const enableAutoCanny = hintTuningState.enableAutoCanny;
  const enableThresholdBranch = hintTuningState.enableThresholdBranch;
  const thresholdModeCandidate = hintTuningState.thresholdMode;
  const morphCloseCandidate = Math.round(hintTuningState.morphCloseSize);
  const morphOpenCandidate = Math.round(hintTuningState.morphOpenSize);
  const autoCannySigmaCandidate = Number(hintTuningState.autoCannySigma);
  const autoCannySigma = clamp(
    Number.isFinite(autoCannySigmaCandidate) ? autoCannySigmaCandidate : HINT_TUNING_DEFAULTS.autoCannySigma,
    0,
    1,
  );
  const fusionModeCandidate = hintTuningState.fusionMode;
  const allowedFusionModes = new Set(['edge', 'threshold', 'and', 'or']);
  const fusionMode = allowedFusionModes.has(fusionModeCandidate)
    ? fusionModeCandidate
    : HINT_TUNING_DEFAULTS.fusionMode;
  const morphCloseSize = clamp(
    Number.isFinite(morphCloseCandidate) ? morphCloseCandidate : HINT_TUNING_DEFAULTS.morphCloseSize,
    0,
    99,
  );
  const morphOpenSize = clamp(
    Number.isFinite(morphOpenCandidate) ? morphOpenCandidate : HINT_TUNING_DEFAULTS.morphOpenSize,
    0,
    99,
  );
  const thresholdMode = thresholdModeCandidate === 'adaptive' ? 'adaptive' : 'otsu';

  return {
    cannyLowThreshold: low,
    cannyHighThreshold: clamp(high, 0, 255),
    kernelSize: kernelCandidate,
    minAreaRatio,
    paperExclusionTolerance,
    enableErodeStep: enableErodeStep !== undefined ? Boolean(enableErodeStep) : HINT_TUNING_DEFAULTS.enableErodeStep,
    enableAutoCanny: enableAutoCanny !== undefined ? Boolean(enableAutoCanny) : HINT_TUNING_DEFAULTS.enableAutoCanny,
    autoCannySigma,
    enableThresholdBranch:
      enableThresholdBranch !== undefined
        ? Boolean(enableThresholdBranch)
        : HINT_TUNING_DEFAULTS.enableThresholdBranch,
    thresholdMode,
    morphCloseSize,
    morphOpenSize,
    fusionMode,
    showProcessingSteps: hintTuningState.showProcessingSteps !== undefined
      ? Boolean(hintTuningState.showProcessingSteps)
      : HINT_TUNING_DEFAULTS.showProcessingSteps,
  };
}

export function rerunHintSelection() {
  if (!activeOverlayElement || !activeImageMat) return;

  const state = overlayStateMap.get(activeOverlayElement);
  if (!state || !state.displayInfo || !state.lastHintPixel) return;
  runHintSelection(state);
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
  if (!state || !state.displayInfo) return;

  const handleTarget = event.target?.closest?.('.preview-result__handle');
  if (handleTarget) return;

  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  const normalizedX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  const normalizedY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);

  addHintPoint(state, normalizedX, normalizedY);

  const { displayWidth, displayHeight, originalWidth, originalHeight } = state.displayInfo;
  const scaleX = originalWidth / displayWidth;
  const scaleY = originalHeight / displayHeight;

  const displayX = normalizedX * displayWidth;
  const displayY = normalizedY * displayHeight;
  const targetPoint = {
    x: clamp(Math.round(displayX * scaleX), 0, Math.max(0, originalWidth - 1)),
    y: clamp(Math.round(displayY * scaleY), 0, Math.max(0, originalHeight - 1)),
  };

  state.lastHintPixel = targetPoint;
  runHintSelection(state);
  notifyOverlayStateChange(overlay, state);
}

function handleOverlayPointerDown(event) {
  const isRightClick = event.button === 2;
  const isModifierClick = event.button === 0 && (event.ctrlKey || event.metaKey);
  if (!isRightClick && !isModifierClick) return;

  const overlay = event.currentTarget;
  const state = overlayStateMap.get(overlay);
  if (!state) return;

  const handleTarget = event.target?.closest?.('.preview-result__handle');
  if (handleTarget) return;

  const bounds = overlay.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;

  event.preventDefault();
  event.stopPropagation();

  if (typeof overlay.focus === 'function') {
    try {
      overlay.focus({ preventScroll: true });
    } catch (_error) {
      overlay.focus();
    }
  }

  const normalizedX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
  const normalizedY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);

  addExclusionPoint(state, normalizedX, normalizedY);
  updateActiveExclusionPath(state);
  notifyOverlayStateChange(overlay, state);
}

function handleOverlayDoubleClick(event) {
  const overlay = event.currentTarget;
  const state = overlayStateMap.get(overlay);
  if (!state) return;

  if (!Array.isArray(state.activeExclusion) || state.activeExclusion.length < 2) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const completed = finalizeActiveExclusion(state);
  if (completed) {
    rerunHintSelection();
  }
  notifyOverlayStateChange(overlay, state);
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
}

function clearHintPoints(state) {
  if (!state?.hintLayer) return;

  state.hintLayer.replaceChildren();
  state.hintPoints = [];
  state.lastHintPixel = null;
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
    notifyOverlayStateChange(state.overlay || activeOverlayElement, state);
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
  notifyOverlayStateChange(state.overlay || activeOverlayElement, state);
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

function addExclusionPoint(state, normalizedX, normalizedY) {
  if (!state) return;

  if (!Array.isArray(state.activeExclusion)) {
    state.activeExclusion = [];
  }

  const x = clamp(Number(normalizedX) || 0, 0, 1);
  const y = clamp(Number(normalizedY) || 0, 0, 1);
  const lastPoint = state.activeExclusion[state.activeExclusion.length - 1];

  if (lastPoint && Math.abs(lastPoint.x - x) < 1e-4 && Math.abs(lastPoint.y - y) < 1e-4) {
    return;
  }

  state.activeExclusion.push({ x, y });
}

function finalizeActiveExclusion(state) {
  if (!state || !Array.isArray(state.activeExclusion)) return false;

  const polygon = state.activeExclusion.slice();
  if (polygon.length < 3) {
    cancelActiveExclusion(state);
    return false;
  }

  const normalized = polygon.map((point) => ({
    x: clamp(Number(point?.x) || 0, 0, 1),
    y: clamp(Number(point?.y) || 0, 0, 1),
  }));

  if (!Array.isArray(state.exclusions)) {
    state.exclusions = [];
  }

  state.exclusions.push(normalized);
  state.activeExclusion = null;
  updateActiveExclusionPath(state);
  renderExclusions(state);

  return true;
}

function cancelActiveExclusion(state) {
  if (!state) return false;
  const hadActivePoints = Array.isArray(state.activeExclusion) && state.activeExclusion.length > 0;
  state.activeExclusion = null;
  updateActiveExclusionPath(state);
  return hadActivePoints;
}

function updateActiveExclusionPath(state) {
  if (!state?.activeExclusionPath) return;

  const polygon = Array.isArray(state.activeExclusion) ? state.activeExclusion : [];
  if (!polygon.length) {
    state.activeExclusionPath.dataset.visible = 'false';
    state.activeExclusionPath.setAttribute('points', '');
    return;
  }

  state.activeExclusionPath.setAttribute('points', normalizedPolygonToPointString(polygon));
  state.activeExclusionPath.dataset.visible = 'true';
}

function renderExclusions(state) {
  if (!state?.exclusionLayer) return;

  const activePath = state.activeExclusionPath;
  if (Array.isArray(state.exclusionElements)) {
    state.exclusionElements.forEach((element) => element.remove());
  }
  state.exclusionElements = [];

  if (!Array.isArray(state.exclusions)) {
    state.exclusions = [];
  }

  state.exclusions.forEach((polygon) => {
    if (!Array.isArray(polygon) || polygon.length < 3) return;
    const exclusion = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    exclusion.classList.add('preview-result__exclusion');
    exclusion.setAttribute('points', normalizedPolygonToPointString(polygon));
    exclusion.setAttribute('aria-hidden', 'true');
    state.exclusionLayer.insertBefore(exclusion, activePath || null);
    state.exclusionElements.push(exclusion);
  });
}

function clearExclusions(state) {
  if (!state) return;
  state.exclusions = [];
  renderExclusions(state);
  cancelActiveExclusion(state);
}

function normalizedPolygonToPointString(polygon) {
  if (!Array.isArray(polygon)) return '';
  return polygon
    .map((point) => {
      if (!point) return null;
      const x = clamp(Number(point.x) || 0, 0, 1) * OVERLAY_COORDINATE_SCALE;
      const y = clamp(Number(point.y) || 0, 0, 1) * OVERLAY_COORDINATE_SCALE;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter(Boolean)
    .join(' ');
}

function handleGlobalKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (!activeOverlayElement) return;
  const state = overlayStateMap.get(activeOverlayElement);
  if (!state) return;
  const canceled = cancelActiveExclusion(state);
  if (canceled) {
    event.preventDefault();
    event.stopPropagation();
    notifyOverlayStateChange(state.overlay || activeOverlayElement, state);
  }
}

function notifyOverlayStateChange(overlay, state) {
  if (!overlay || typeof overlay.dispatchEvent !== 'function') return;
  const detail = {
    hintCount: Array.isArray(state?.hintPoints) ? state.hintPoints.length : 0,
    exclusionCount: Array.isArray(state?.exclusions) ? state.exclusions.length : 0,
    hasSelection: state?.selectionPath?.dataset?.visible === 'true',
    hasActiveExclusion: Array.isArray(state?.activeExclusion) && state.activeExclusion.length > 0,
  };

  overlay.dispatchEvent(new CustomEvent('gridfinium:overlay-state', { detail }));
}

function getOverlayController(overlay) {
  if (!overlay) return null;
  let controller = overlayControllerMap.get(overlay);
  if (controller) return controller;

  controller = {
    resetHints: () => {
      const state = overlayStateMap.get(overlay);
      if (!state) return;
      clearHintPoints(state);
      clearSelectionHighlight(state);
      notifyOverlayStateChange(overlay, state);
    },
    resetExclusions: () => {
      const state = overlayStateMap.get(overlay);
      if (!state) return;
      clearExclusions(state);
      notifyOverlayStateChange(overlay, state);
      rerunHintSelection();
    },
    getState: () => {
      const state = overlayStateMap.get(overlay);
      return state ? { ...state } : null;
    },
  };

  overlayControllerMap.set(overlay, controller);
  return controller;
}

function runHintSelection(state) {
  if (!state || !state.displayInfo || !state.lastHintPixel || !activeImageMat) return;

  const showStep = prepareHintStepRenderer();
  const result = findContourAtPoint(
    activeImageMat,
    state.lastHintPixel,
    showStep,
    state.displayInfo,
    state.paperOutline,
    state.exclusions,
  );
  if (!result) {
    updateSelectionHighlight(state, null, state.displayInfo);
    return;
  }

  const { contour, normalizedPoints } = result;
  updateSelectionHighlight(state, contour, state.displayInfo, normalizedPoints);
}

function prepareHintStepRenderer() {
  if (!activeHintProcessingSteps) return null;

  if (typeof activeHintProcessingSteps.reset === 'function') {
    activeHintProcessingSteps.reset();
  }

  activeHintProcessingSteps.setVisible(Boolean(getHintTuningConfig().showProcessingSteps));

  return (label, mat, modifier, stepOptions) => {
    activeHintProcessingSteps.renderStep(label, mat, modifier, stepOptions);
  };
}

function findContourAtPoint(sourceMat, point, showStep, displayInfo, paperOutline, exclusionPolygons) {
  if (!sourceMat) return null;

  const renderStep = typeof showStep === 'function' ? showStep : null;
  const normalizedHint = normalizedPointFromPixel(point, displayInfo)
    || normalizedPointFromPixel(point, {
      originalWidth: sourceMat.cols,
      originalHeight: sourceMat.rows,
    });
  const baseStepOptions = normalizedHint ? { overlayPoints: [normalizedHint] } : undefined;

  const normalizedPaperOutline = Array.isArray(paperOutline) && paperOutline.length >= 3
    ? paperOutline
    : null;

  const normalizedExclusions = Array.isArray(exclusionPolygons)
    ? exclusionPolygons
        .filter((polygon) => Array.isArray(polygon) && polygon.length >= 3)
        .map((polygon) => polygon.map((entry) => ({
          x: clamp(Number(entry?.x) || 0, 0, 1),
          y: clamp(Number(entry?.y) || 0, 0, 1),
        })))
    : [];

  if (renderStep) {
    if (normalizedHint) {
      const highlighted = sourceMat.clone();

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

      const radius = Math.max(3, Math.round(12 * scaleEstimate));
      cv.circle(highlighted, hintLocation, radius, new cv.Scalar(236, 72, 153, 255), 3, cv.LINE_AA);
      const hintOptions = baseStepOptions ? { ...baseStepOptions } : undefined;
      renderStep('Hint Location', highlighted, 'step-original', hintOptions);
      highlighted.delete();
    }

    renderStep('Hint Source', sourceMat, 'step-original', baseStepOptions);
  }

  let workingSource = sourceMat;
  let cleanupWorkingSource = null;

  if (normalizedPaperOutline) {
    const masked = buildMaskedDisplayMat(sourceMat, normalizedPaperOutline, displayInfo);
    if (masked?.mat) {
      workingSource = masked.mat;
      if (renderStep) {
        const preview = workingSource.clone();
        const stepOptions = baseStepOptions ? { ...baseStepOptions } : {};
        stepOptions.overlayPolygon = normalizedPaperOutline;
        stepOptions.overlayFill = 'rgba(79, 70, 229, 0.18)';
        stepOptions.overlayStroke = '#4f46e5';
        stepOptions.overlayLineWidth = 3;
        renderStep('Hint Source - Paper Masked', preview, 'step-original', stepOptions);
        preview.delete();
      }
    }
    cleanupWorkingSource = masked?.cleanup || null;
  }

  if (normalizedExclusions.length && workingSource) {
    const exclusionMask = new cv.Mat(workingSource.rows, workingSource.cols, cv.CV_8UC1);
    exclusionMask.setTo(new cv.Scalar(255, 255, 255, 255));
    let hasMask = false;

    normalizedExclusions.forEach((polygon, index) => {
      const maskResult = buildMaskedDisplayMat(workingSource, polygon, displayInfo, { returnMaskOnly: true });
      if (maskResult?.mask) {
        cv.bitwise_not(maskResult.mask, maskResult.mask);
        cv.bitwise_and(exclusionMask, maskResult.mask, exclusionMask);
        hasMask = true;
      }

      if (renderStep) {
        const stepOptions = baseStepOptions ? { ...baseStepOptions } : {};
        stepOptions.overlayPolygon = polygon;
        stepOptions.overlayFill = 'rgba(248, 113, 113, 0.28)';
        stepOptions.overlayStroke = '#f87171';
        stepOptions.overlayLineWidth = 3;
        const preview = workingSource.clone();
        renderStep(`Excluded Region #${index + 1}`, preview, 'step-exclusion', stepOptions);
        preview.delete();
      }

      if (maskResult?.cleanup) {
        maskResult.cleanup();
      }
    });

    if (hasMask) {
      const invertedMask = new cv.Mat();
      cv.bitwise_not(exclusionMask, invertedMask);
      const filler = new cv.Mat(workingSource.rows, workingSource.cols, workingSource.type());
      filler.setTo(new cv.Scalar(255, 255, 255, 255));
      filler.copyTo(workingSource, invertedMask);
      filler.delete();
      invertedMask.delete();

      if (renderStep) {
        const preview = workingSource.clone();
        renderStep('Hint Source - Exclusions Applied', preview, 'step-original', baseStepOptions);
        preview.delete();
      }
    }

    exclusionMask.delete();
  }

  const tuning = getHintTuningConfig();
  const paperTolerance = Math.max(0, Number(tuning.paperExclusionTolerance) || 0);
  const paperMetrics = paperTolerance > 0 && normalizedPaperOutline
    ? measureNormalizedOutlineMetrics(normalizedPaperOutline, workingSource, displayInfo)
    : null;
  const gray = new cv.Mat();
  cv.cvtColor(workingSource, gray, cv.COLOR_RGBA2GRAY);
  if (renderStep) {
    renderStep('Hint Grayscale - cv.cvtColor()', gray, 'step-gray', baseStepOptions);
  }

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  if (renderStep) {
    renderStep('Hint Blurred - cv.GaussianBlur()', blurred, 'step-blurred', baseStepOptions);
  }

  const shouldComputeThreshold = Boolean(tuning.enableThresholdBranch || tuning.fusionMode !== 'edge');
  let bin = null;
  if (shouldComputeThreshold) {
    bin = new cv.Mat();
    const isAdaptive = tuning.thresholdMode === 'adaptive';
    if (isAdaptive) {
      cv.adaptiveThreshold(
        blurred,
        bin,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        11,
        2,
      );
    } else {
      cv.threshold(blurred, bin, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    }

    if (tuning.morphCloseSize > 0) {
      const kClose = cv.Mat.ones(tuning.morphCloseSize, tuning.morphCloseSize, cv.CV_8U);
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kClose);
      kClose.delete();
    }
    if (tuning.morphOpenSize > 0) {
      const kOpen = cv.Mat.ones(tuning.morphOpenSize, tuning.morphOpenSize, cv.CV_8U);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, kOpen);
      kOpen.delete();
    }

    if (renderStep) {
      const caption = isAdaptive ? 'Threshold Map\nmode=Adaptive Gaussian' : 'Threshold Map\nmode=Otsu';
      renderStep(caption, bin, 'step-binary', baseStepOptions);
    }
  }

  let edges = null;
  let cannyLow = tuning.cannyLowThreshold;
  let cannyHigh = tuning.cannyHighThreshold;
  if (tuning.enableAutoCanny) {
    const result = autoCanny(blurred, tuning.autoCannySigma);
    edges = result.edges;
    cannyLow = result.lower;
    cannyHigh = result.upper;
  } else {
    edges = new cv.Mat();
    cv.Canny(blurred, edges, tuning.cannyLowThreshold, tuning.cannyHighThreshold);
  }
  if (renderStep) {
    const formatThreshold = (value) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const formatted = value.toFixed(1);
        return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
      }
      return value;
    };
    const caption = `Edge Map\nlow=${formatThreshold(cannyLow)}, high=${formatThreshold(cannyHigh)}`;
    renderStep(caption, edges, 'step-edges-raw', baseStepOptions);
  }

  const kSize = Math.max(1, tuning.kernelSize | 0);
  const kernel = cv.Mat.ones(kSize, kSize, cv.CV_8U);
  cv.dilate(edges, edges, kernel);
  if (renderStep) {
    renderStep('Hint Dilated Edges - cv.dilate()', edges, 'step-edges-dilated', baseStepOptions);
  }
  if (tuning.enableErodeStep) {
    cv.erode(edges, edges, kernel);
    if (renderStep) {
      renderStep('Hint Refined Edges - cv.erode()', edges, 'step-edges-cleaned', baseStepOptions);
    }
  } else if (renderStep) {
    renderStep('Hint Refined Edges - cv.erode() skipped', edges, 'step-edges-cleaned', baseStepOptions);
  }
  kernel.delete();

  let contourSource = edges;
  let fused = null;
  const fusionMode = tuning.fusionMode;
  const hasThreshold = bin instanceof cv.Mat;
  if (fusionMode === 'threshold' && hasThreshold) {
    contourSource = bin;
  } else if ((fusionMode === 'and' || fusionMode === 'or') && hasThreshold) {
    fused = new cv.Mat();
    if (fusionMode === 'and') {
      cv.bitwise_and(edges, bin, fused);
    } else {
      cv.bitwise_or(edges, bin, fused);
    }
    if (renderStep) {
      const caption = fusionMode === 'and' ? 'Combined (AND)' : 'Combined (OR)';
      renderStep(caption, fused, 'step-fused-map', baseStepOptions);
    }
    contourSource = fused;
  } else {
    contourSource = edges;
  }

  if ((fusionMode === 'and' || fusionMode === 'or') && renderStep && !hasThreshold) {
    renderStep('Combined (AND/OR) - threshold map unavailable', edges, 'step-fused-map', baseStepOptions);
  }
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(contourSource, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const minArea = workingSource.rows * workingSource.cols * tuning.minAreaRatio;
  const testPoint = new cv.Point(point.x, point.y);
  const topContours = [];
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

    const perimeter = cv.arcLength(contour, true);

    if (
      normalizedExclusions.length
      && contourIntersectsNormalizedPolygons(contour, normalizedExclusions, displayInfo, workingSource)
    ) {
      contour.delete();
      continue;
    }

    insertTopContour(topContours, contour, area, perimeter);

    if (paperMetrics) {
      const areaDifference = paperMetrics.area > 0
        ? Math.abs(area - paperMetrics.area) / paperMetrics.area
        : Number.POSITIVE_INFINITY;
      const perimeterDifference = paperMetrics.perimeter > 0
        ? Math.abs(perimeter - paperMetrics.perimeter) / paperMetrics.perimeter
        : Number.POSITIVE_INFINITY;

      if (areaDifference <= paperTolerance && perimeterDifference <= paperTolerance) {
        contour.delete();
        continue;
      }

      if (
        paperMetrics.perimeter > 0
        && perimeter + PERIMETER_COMPARISON_EPSILON >= paperMetrics.perimeter
      ) {
        contour.delete();
        continue;
      }
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

  if (renderStep && topContours.length) {
    topContours.forEach((entry, index) => {
      const display = cv.Mat.zeros(workingSource.rows, workingSource.cols, cv.CV_8UC3);
      const single = new cv.MatVector();
      single.push_back(entry.mat);
      cv.drawContours(display, single, -1, new cv.Scalar(236, 72, 153, 255), 3, cv.LINE_AA);
      single.delete();
      const captionLines = [
        `Hint Top Contour ${index + 1}`,
        `Perimeter: ${entry.perimeter.toFixed(1)} px`,
        `Area: ${entry.area.toFixed(1)} px²`,
      ];

      if (paperMetrics) {
        const hasPerimeter = Number.isFinite(paperMetrics.perimeter) && paperMetrics.perimeter > 0;
        const paperPerimeterText = hasPerimeter
          ? `${paperMetrics.perimeter.toFixed(1)} px`
          : 'N/A';
        captionLines.push(`Paper Perimeter: ${paperPerimeterText}`);

        if (hasPerimeter) {
          const perimeterDifference = ((entry.perimeter - paperMetrics.perimeter) / paperMetrics.perimeter) * 100;
          const formattedDifference = `${perimeterDifference >= 0 ? '+' : ''}${perimeterDifference.toFixed(1)}%`;
          captionLines.push(`Perimeter Δ vs Paper: ${formattedDifference}`);
        } else {
          captionLines.push('Perimeter Δ vs Paper: N/A');
        }
      } else {
        captionLines.push('Paper Perimeter: N/A', 'Perimeter Δ vs Paper: N/A');
      }

      const caption = captionLines.join('\n');
      const stepOptions = baseStepOptions
        ? { ...baseStepOptions }
        : undefined;
      renderStep(caption, display, 'step-contour', stepOptions);
      display.delete();
      entry.mat.delete();
    });
  } else {
    topContours.forEach((entry) => {
      entry.mat.delete();
    });
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
      originalWidth: workingSource.cols,
      originalHeight: workingSource.rows,
    });
  }

  if (renderStep && selected) {
    const selectionDisplay = workingSource.clone();
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

  if (typeof cleanupWorkingSource === 'function') {
    cleanupWorkingSource();
    cleanupWorkingSource = null;
  }

  if (insideContour) insideContour.delete();
  if (fallbackContour) fallbackContour.delete();

  gray.delete();
  blurred.delete();
  if (bin) {
    bin.delete();
    bin = null;
  }
  if (fused) {
    fused.delete();
    fused = null;
  }
  edges.delete();
  contours.delete();
  hierarchy.delete();

  if (!selected) return null;

  return { contour: selected, normalizedPoints };
}

function measureNormalizedOutlineMetrics(normalizedOutline, sourceMat, dimensions) {
  const polygon = createPolygonMatFromNormalizedOutline(normalizedOutline, sourceMat, dimensions);
  if (!polygon) return null;

  const area = cv.contourArea(polygon);
  const perimeter = cv.arcLength(polygon, true);
  polygon.delete();

  if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(perimeter) || perimeter <= 0) {
    return null;
  }

  return { area, perimeter };
}

function createPolygonMatFromNormalizedOutline(normalizedOutline, sourceMat, dimensions) {
  if (!sourceMat || !Array.isArray(normalizedOutline) || normalizedOutline.length < 3) return null;

  const hasWidth = dimensions && Number.isFinite(dimensions.originalWidth) && dimensions.originalWidth > 0;
  const hasHeight = dimensions && Number.isFinite(dimensions.originalHeight) && dimensions.originalHeight > 0;
  const baseWidth = hasWidth ? dimensions.originalWidth : sourceMat.cols;
  const baseHeight = hasHeight ? dimensions.originalHeight : sourceMat.rows;

  if (!baseWidth || !baseHeight) return null;

  const scaleX = sourceMat.cols / baseWidth;
  const scaleY = sourceMat.rows / baseHeight;
  const maxX = Math.max(0, baseWidth - 1);
  const maxY = Math.max(0, baseHeight - 1);

  const pointData = [];
  normalizedOutline.forEach((corner) => {
    if (!corner) return;
    const normalizedXRaw = Number(corner.x);
    const normalizedYRaw = Number(corner.y);
    const normalizedX = clamp(Number.isFinite(normalizedXRaw) ? normalizedXRaw : 0, 0, 1);
    const normalizedY = clamp(Number.isFinite(normalizedYRaw) ? normalizedYRaw : 0, 0, 1);
    const pixelX = clamp(Math.round(normalizedX * maxX * scaleX), 0, Math.max(0, sourceMat.cols - 1));
    const pixelY = clamp(Math.round(normalizedY * maxY * scaleY), 0, Math.max(0, sourceMat.rows - 1));
    pointData.push(pixelX, pixelY);
  });

  if (pointData.length < 6) return null;

  return cv.matFromArray(pointData.length / 2, 1, cv.CV_32SC2, Int32Array.from(pointData));
}

function buildMaskedDisplayMat(sourceMat, normalizedOutline, dimensions, options = {}) {
  const polygon = createPolygonMatFromNormalizedOutline(normalizedOutline, sourceMat, dimensions);
  if (!polygon) return null;
  const polygons = new cv.MatVector();
  polygons.push_back(polygon);

  const mask = cv.Mat.zeros(sourceMat.rows, sourceMat.cols, cv.CV_8UC1);
  cv.fillPoly(mask, polygons, new cv.Scalar(255, 255, 255, 255));

  polygons.delete();
  polygon.delete();

  if (options && options.returnMaskOnly) {
    return {
      mask,
      cleanup: () => {
        mask.delete();
      },
    };
  }

  const masked = new cv.Mat(sourceMat.rows, sourceMat.cols, sourceMat.type());
  masked.setTo(new cv.Scalar(255, 255, 255, 255));
  sourceMat.copyTo(masked, mask);

  return {
    mat: masked,
    mask,
    cleanup: () => {
      masked.delete();
      mask.delete();
    },
  };
}

function autoCanny(grayMat, sigma = 0.33) {
  const sigmaValue = Number.isFinite(sigma) ? clamp(sigma, 0, 1) : 0.33;
  const data = grayMat.data;
  const sample = [];
  for (let i = 0; i < data.length; i += 16) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const medianIndex = sample.length > 0 ? (sample.length / 2) | 0 : 0;
  const med = sample[medianIndex] ?? 0;
  const lower = Math.max(0, (1.0 - sigmaValue) * med);
  const upper = Math.min(255, (1.0 + sigmaValue) * med);
  const edges = new cv.Mat();
  cv.Canny(grayMat, edges, lower, upper);
  return { edges, lower, upper };
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
    const removed = list.splice(MAX_DISPLAY_CONTOURS);
    removed.forEach((item) => item.mat.delete());
  }
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

function contourIntersectsNormalizedPolygons(contour, polygons, dimensions, sourceMat) {
  if (!contour || !Array.isArray(polygons) || !polygons.length) return false;

  const baseDimensions = dimensions && (dimensions.originalWidth || dimensions.originalHeight)
    ? dimensions
    : sourceMat
      ? { originalWidth: sourceMat.cols, originalHeight: sourceMat.rows }
      : null;

  let normalizedContour = normalizedPointsFromContour(contour, baseDimensions);
  if ((!normalizedContour || !normalizedContour.length) && sourceMat) {
    normalizedContour = normalizedPointsFromContour(contour, {
      originalWidth: sourceMat.cols,
      originalHeight: sourceMat.rows,
    });
  }

  if (!normalizedContour || normalizedContour.length < 3) {
    return false;
  }

  for (let index = 0; index < polygons.length; index += 1) {
    const polygon = polygons[index];
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    if (normalizedPolygonsIntersect(normalizedContour, polygon)) {
      return true;
    }
  }

  return false;
}

function normalizedPolygonsIntersect(polyA, polyB) {
  if (!Array.isArray(polyA) || polyA.length < 3 || !Array.isArray(polyB) || polyB.length < 3) {
    return false;
  }

  for (let i = 0; i < polyA.length; i += 1) {
    if (normalizedPointInPolygon(polyA[i], polyB)) {
      return true;
    }
  }

  for (let i = 0; i < polyB.length; i += 1) {
    if (normalizedPointInPolygon(polyB[i], polyA)) {
      return true;
    }
  }

  for (let i = 0; i < polyA.length; i += 1) {
    const a1 = polyA[i];
    const a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j += 1) {
      const b1 = polyB[j];
      const b2 = polyB[(j + 1) % polyB.length];
      if (normalizedSegmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return false;
}

function normalizedPointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const deltaY = b.y - a.y;
    if (Math.abs(deltaY) < NORMALIZED_GEOMETRY_EPSILON) continue;
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / deltaY + a.x);
    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function normalizedSegmentsIntersect(a1, a2, b1, b2) {
  const o1 = normalizedOrientation(a1, a2, b1);
  const o2 = normalizedOrientation(a1, a2, b2);
  const o3 = normalizedOrientation(b1, b2, a1);
  const o4 = normalizedOrientation(b1, b2, a2);

  if ((o1 * o2) < -NORMALIZED_GEOMETRY_EPSILON && (o3 * o4) < -NORMALIZED_GEOMETRY_EPSILON) {
    return true;
  }

  if (Math.abs(o1) <= NORMALIZED_GEOMETRY_EPSILON && isPointOnSegmentNormalized(b1, a1, a2)) return true;
  if (Math.abs(o2) <= NORMALIZED_GEOMETRY_EPSILON && isPointOnSegmentNormalized(b2, a1, a2)) return true;
  if (Math.abs(o3) <= NORMALIZED_GEOMETRY_EPSILON && isPointOnSegmentNormalized(a1, b1, b2)) return true;
  if (Math.abs(o4) <= NORMALIZED_GEOMETRY_EPSILON && isPointOnSegmentNormalized(a2, b1, b2)) return true;

  return false;
}

function isPointOnSegmentNormalized(point, start, end) {
  if (!point || !start || !end) return false;
  const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
  if (Math.abs(cross) > NORMALIZED_GEOMETRY_EPSILON) return false;
  const dot = (point.x - start.x) * (point.x - end.x) + (point.y - start.y) * (point.y - end.y);
  return dot <= NORMALIZED_GEOMETRY_EPSILON;
}

function normalizedOrientation(a, b, c) {
  if (!a || !b || !c) return 0;
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function updateHintProcessingStepsVisibility() {
  if (!activeHintProcessingSteps) return;
  const visible = Boolean(getHintTuningConfig().showProcessingSteps);
  activeHintProcessingSteps.setVisible(visible);
}

function setupHintTuningDebugApi() {
  if (typeof window === 'undefined') return;

  const namespace = window.GridFinium ?? {};
  const hintApi = namespace.hintTuning ?? {};

  hintApi.getState = () => ({ ...hintTuningState });
  hintApi.getConfig = () => ({ ...getHintTuningConfig() });
  hintApi.apply = (overrides = {}, options = {}) => applyHintTuningState(overrides, options);
  hintApi.reset = (options = {}) => applyHintTuningState({ ...HINT_TUNING_DEFAULTS }, options);

  namespace.hintTuning = hintApi;
  window.GridFinium = namespace;
}

setupHintTuningDebugApi();

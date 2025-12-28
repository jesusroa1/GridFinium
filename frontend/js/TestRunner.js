import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import { attachPaperOverlay } from './ObjectOutlining.js';
import { initStlDesigner } from './STLLogic.js';

const DOM_IDS = Object.freeze({
  runAllButton: 'tests-run-all',
  resultsBody: 'tests-results-body',
  sandbox: 'tests-sandbox',
});

const REQUIRED_DOM_IDS = [
  'file-upload',
  'preview',
  'test-image-picker',
  'hint-tuning-card',
  'hint-tuning-toggle',
  'stl-viewer',
  'stl-width',
  'stl-depth',
  'stl-height',
  'stl-download',
  'stl-reset',
  DOM_IDS.runAllButton,
  DOM_IDS.resultsBody,
];

const TEST_SAMPLES = [
  {
    name: 'Mouse on paper',
    src: 'frontend/test-images/mouse.png.jpeg',
  },
  {
    name: 'Remote on paper',
    src: 'frontend/test-images/remote.png.jpeg',
  },
  {
    name: 'Coaster top on paper',
    src: 'frontend/test-images/coaster-top.png.jpeg',
  },
  {
    name: 'Fallback coaster',
    src: 'example_coaster.jpeg',
  },
];

const TAB_DATA_ATTRIBUTE = 'data-tab-target';
const OPEN_CV_POLL_INTERVAL_MS = 50;
const OPEN_CV_TIMEOUT_MS = 10000;

let stlSmokeState = null;

export function initTestRunner() {
  const runAllButton = document.getElementById(DOM_IDS.runAllButton);
  const resultsBody = document.getElementById(DOM_IDS.resultsBody);
  const sandbox = document.getElementById(DOM_IDS.sandbox);

  if (!runAllButton || !resultsBody || !sandbox) return;

  renderEmptyState(resultsBody);

  let running = false;

  const runAll = async () => {
    if (running) return;
    running = true;
    runAllButton.disabled = true;
    runAllButton.textContent = 'Running...';

    try {
      const domWiringStage = await runDomWiringTest();
      const stlStage = await runStlSmokeTest(sandbox);

      const results = [];

      for (const sample of TEST_SAMPLES) {
        const startedAt = new Date().toISOString();
        const stages = {};

        stages['DOM Wiring'] = domWiringStage;

        const loadResult = await runImageLoadTest(sample);
        stages['Load'] = loadResult.stage;

        const detectionResult = await runPaperDetectionTest(loadResult.imageElement);
        stages['Paper Detect'] = detectionResult.stage;

        stages['Overlay Init'] = await runOverlayInitTest(
          detectionResult.points,
          loadResult.imageElement,
          sandbox,
        );

        stages['STL Export Smoke'] = stlStage;

        const overallPass = Object.values(stages).every((stage) => stage?.pass);

        results.push({
          sampleName: sample.name,
          stages,
          overallPass,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }

      renderResults(resultsBody, results);
    } catch (error) {
      console.error('GridFinium: test run failed.', error);
      renderError(resultsBody, error);
    } finally {
      running = false;
      runAllButton.disabled = false;
      runAllButton.textContent = 'Run All';
    }
  };

  runAllButton.addEventListener('click', () => {
    runAll();
  });
}

function renderEmptyState(resultsBody) {
  resultsBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.textContent = 'No test results yet. Click “Run All” to start the smoke checks.';
  cell.className = 'tests-table__empty';
  row.appendChild(cell);
  resultsBody.appendChild(row);
}

function renderError(resultsBody, error) {
  resultsBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.className = 'tests-table__empty tests-table__empty--error';
  cell.textContent = `Test run failed: ${formatError(error)}`;
  row.appendChild(cell);
  resultsBody.appendChild(row);
}

function renderResults(resultsBody, results) {
  resultsBody.replaceChildren();

  results.forEach((result) => {
    const row = document.createElement('tr');
    row.appendChild(buildTextCell(result.sampleName));
    row.appendChild(buildStatusCell(result.stages['Load']));
    row.appendChild(buildStatusCell(result.stages['Paper Detect']));
    row.appendChild(buildStatusCell(result.stages['Overlay Init']));
    row.appendChild(buildStatusCell(result.stages['STL Export Smoke']));
    row.appendChild(buildOverallCell(result.overallPass));
    resultsBody.appendChild(row);

    const detailsRow = document.createElement('tr');
    const detailsCell = document.createElement('td');
    detailsCell.colSpan = 6;
    detailsCell.appendChild(buildDetailsPanel(result));
    detailsRow.appendChild(detailsCell);
    resultsBody.appendChild(detailsRow);
  });
}

function buildTextCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function buildStatusCell(stage) {
  const cell = document.createElement('td');
  const pass = Boolean(stage?.pass);
  cell.textContent = pass ? 'Pass' : 'Fail';
  cell.className = `tests-status ${pass ? 'tests-status--pass' : 'tests-status--fail'}`;
  return cell;
}

function buildOverallCell(overallPass) {
  const cell = document.createElement('td');
  cell.textContent = overallPass ? 'Pass' : 'Fail';
  cell.className = `tests-status ${overallPass ? 'tests-status--pass' : 'tests-status--fail'}`;
  return cell;
}

function buildDetailsPanel(result) {
  const wrapper = document.createElement('details');
  wrapper.className = 'tests-details';

  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  wrapper.appendChild(summary);

  const meta = document.createElement('div');
  meta.className = 'tests-details__meta';
  meta.innerHTML = `
    <div><strong>Started:</strong> ${result.startedAt}</div>
    <div><strong>Finished:</strong> ${result.finishedAt}</div>
  `;
  wrapper.appendChild(meta);

  const list = document.createElement('ul');
  list.className = 'tests-details__list';

  Object.entries(result.stages).forEach(([stageName, stageResult]) => {
    const item = document.createElement('li');
    item.className = stageResult?.pass ? 'tests-details__item--pass' : 'tests-details__item--fail';

    const title = document.createElement('div');
    title.className = 'tests-details__title';
    title.textContent = `${stageName}: ${stageResult?.pass ? 'Pass' : 'Fail'}`;
    item.appendChild(title);

    const message = document.createElement('div');
    message.className = 'tests-details__message';
    message.textContent = stageResult?.message || 'No message provided.';
    item.appendChild(message);

    if (stageResult?.metrics && Object.keys(stageResult.metrics).length > 0) {
      const metrics = document.createElement('pre');
      metrics.className = 'tests-details__metrics';
      metrics.textContent = JSON.stringify(stageResult.metrics, null, 2);
      item.appendChild(metrics);
    }

    list.appendChild(item);
  });

  wrapper.appendChild(list);
  return wrapper;
}

async function runDomWiringTest() {
  const missing = REQUIRED_DOM_IDS.filter((id) => !document.getElementById(id));
  let tabError = null;
  const tabButtons = Array.from(document.querySelectorAll(`button[${TAB_DATA_ATTRIBUTE}]`));

  try {
    tabButtons.forEach((button) => {
      button.click();
    });
  } catch (error) {
    tabError = error;
  }

  const pass = missing.length === 0 && !tabError;
  return buildStageResult(pass, pass
    ? 'Required DOM elements present; tab switching did not throw.'
    : formatDomWiringMessage(missing, tabError), {
    missingIds: missing,
    tabButtonCount: tabButtons.length,
  });
}

async function runImageLoadTest(sample) {
  const imageElement = new Image();
  try {
    await loadImage(imageElement, sample.src);

    let bitmap = null;
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(imageElement);
    }

    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }

    return {
      imageElement,
      stage: buildStageResult(true, 'Image loaded successfully.', {
        width: imageElement.naturalWidth,
        height: imageElement.naturalHeight,
        source: sample.src,
      }),
    };
  } catch (error) {
    return {
      imageElement: null,
      stage: buildStageResult(false, formatError(error), {
        source: sample.src,
      }),
    };
  }
}

async function runPaperDetectionTest(imageElement) {
  if (!imageElement) {
    return {
      stage: buildStageResult(false, 'Skipped paper detection because the image failed to load.'),
      points: null,
    };
  }

  try {
    await waitForOpenCv();
    const src = cv.imread(imageElement);
    let contour = null;
    let points = null;

    try {
      contour = detectPaperContour(src, () => {});
      if (contour) {
        points = extractContourPoints(contour);
      }
    } finally {
      if (contour) contour.delete();
      src.delete();
    }

    if (points && points.length) {
      return {
        stage: buildStageResult(true, 'Paper contour detected.', {
          pointCount: points.length,
        }),
        points,
      };
    }

    return {
      stage: buildStageResult(true, 'Paper contour not found, but handled gracefully.', {}),
      points: null,
    };
  } catch (error) {
    return {
      stage: buildStageResult(false, formatError(error)),
      points: null,
    };
  }
}

async function runOverlayInitTest(points, imageElement, sandbox) {
  if (!imageElement) {
    return buildStageResult(false, 'Skipped overlay init because the image failed to load.');
  }

  const overlay = document.createElement('div');
  overlay.className = 'tests-overlay';
  sandbox.appendChild(overlay);

  try {
    const corners = Array.isArray(points) && points.length >= 4 ? points : null;
    const renderInfo = {
      originalWidth: imageElement.naturalWidth,
      originalHeight: imageElement.naturalHeight,
      displayWidth: imageElement.naturalWidth,
      displayHeight: imageElement.naturalHeight,
    };
    attachPaperOverlay(overlay, corners, renderInfo);
    return buildStageResult(true, 'Overlay initialized without throwing.', {
      cornersProvided: Boolean(corners),
    });
  } catch (error) {
    return buildStageResult(false, formatError(error));
  } finally {
    overlay.remove();
  }
}

async function runStlSmokeTest(sandbox) {
  if (!stlSmokeState) {
    const container = document.createElement('div');
    container.className = 'tests-stl-sandbox';

    const viewer = document.createElement('div');
    viewer.id = 'tests-stl-viewer';

    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.id = 'tests-stl-width';
    widthInput.value = '4';

    const depthInput = document.createElement('input');
    depthInput.type = 'number';
    depthInput.id = 'tests-stl-depth';
    depthInput.value = '6';

    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.id = 'tests-stl-height';
    heightInput.value = '3';

    const summary = document.createElement('p');
    summary.id = 'tests-stl-summary';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.id = 'tests-stl-download';
    downloadButton.textContent = 'Download STL';

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.id = 'tests-stl-reset';
    resetButton.textContent = 'Reset';

    container.appendChild(viewer);
    container.appendChild(widthInput);
    container.appendChild(depthInput);
    container.appendChild(heightInput);
    container.appendChild(summary);
    container.appendChild(downloadButton);
    container.appendChild(resetButton);
    sandbox.appendChild(container);

    const controller = initStlDesigner({
      viewerId: viewer.id,
      widthInputId: widthInput.id,
      depthInputId: depthInput.id,
      heightInputId: heightInput.id,
      summaryId: summary.id,
      downloadButtonId: downloadButton.id,
      resetButtonId: resetButton.id,
    });

    stlSmokeState = {
      container,
      downloadButton,
      controller,
    };
  }

  const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
  const originalRevokeObjectUrl = URL.revokeObjectURL.bind(URL);

  let blobSize = 0;

  URL.createObjectURL = (blob) => {
    blobSize = blob?.size ?? 0;
    return 'blob:test-stl';
  };
  URL.revokeObjectURL = () => {};

  try {
    stlSmokeState.downloadButton.click();

    const pass = Boolean(stlSmokeState.controller) && blobSize > 0;
    return buildStageResult(pass,
      pass
        ? 'STL designer initialized and export produced output.'
        : 'STL export did not produce output.', {
        blobSize,
      });
  } catch (error) {
    return buildStageResult(false, formatError(error));
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
}

function buildStageResult(pass, message, metrics = {}) {
  return {
    pass: Boolean(pass),
    message: message || '',
    metrics,
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

  return new Promise((resolve, reject) => {
    const interval = window.setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        window.clearInterval(interval);
        resolve();
      }
    }, OPEN_CV_POLL_INTERVAL_MS);

    window.setTimeout(() => {
      window.clearInterval(interval);
      reject(new Error('OpenCV initialization timed out.'));
    }, OPEN_CV_TIMEOUT_MS);
  });
}

function formatDomWiringMessage(missing, tabError) {
  const missingText = missing.length
    ? `Missing IDs: ${missing.join(', ')}.`
    : 'All required IDs present.';
  const tabText = tabError ? ` Tab switching error: ${formatError(tabError)}` : ' Tab switching OK.';
  return `${missingText}${tabText}`.trim();
}

function formatError(error) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

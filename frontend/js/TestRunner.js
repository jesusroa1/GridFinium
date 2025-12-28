import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import { attachPaperOverlay } from './ObjectOutlining.js';
import { ensureThreeJs, initStlDesigner } from './STLLogic.js';

const DOM_IDS = Object.freeze({
  runAllButton: 'tests-run-all',
  resultsBody: 'tests-results-body',
  summary: 'tests-summary',
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
  DOM_IDS.summary,
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
const OPEN_CV_TIMEOUT_MS = 8000;
const IMAGE_LOAD_TIMEOUT_MS = 8000;
const PAPER_DETECT_TIMEOUT_MS = 8000;
const OVERLAY_INIT_TIMEOUT_MS = 5000;
const STL_TIMEOUT_MS = 8000;
const THREE_LOAD_TIMEOUT_MS = 7000;

let stlSmokeState = null;

export function initTestRunner() {
  const runAllButton = document.getElementById(DOM_IDS.runAllButton);
  const resultsBody = document.getElementById(DOM_IDS.resultsBody);
  const summary = document.getElementById(DOM_IDS.summary);
  const sandbox = document.getElementById(DOM_IDS.sandbox);

  if (!runAllButton || !resultsBody || !sandbox || !summary) return;

  renderEmptyState(resultsBody);
  renderSummary(summary, []);

  let running = false;

  const runAll = async () => {
    if (running) return;
    running = true;
    runAllButton.disabled = true;
    runAllButton.textContent = 'Running...';

    document.documentElement.dataset.testsDone = 'false';
    const runStartedAt = performance.now();

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
      renderSummary(summary, results, performance.now() - runStartedAt);
      window.__GRIDFINIUM_TEST_RESULTS__ = results;
      document.documentElement.dataset.testsDone = 'true';
    } catch (error) {
      console.error('GridFinium: test run failed.', error);
      renderError(resultsBody, error);
      renderSummary(summary, [], performance.now() - runStartedAt, error);
      window.__GRIDFINIUM_TEST_RESULTS__ = null;
      document.documentElement.dataset.testsDone = 'true';
    } finally {
      running = false;
      runAllButton.disabled = false;
      runAllButton.textContent = 'Run All';
    }
  };

  runAllButton.addEventListener('click', () => {
    runAll();
  });

  if (shouldAutorunTests()) {
    openTestsTab();
    window.setTimeout(() => {
      runAll();
    }, 0);
  }
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

function renderSummary(summaryNode, results, runtimeMs = 0, error = null) {
  const totals = {
    pass: 0,
    fail: 0,
    skipped: 0,
  };

  results.forEach((result) => {
    Object.values(result.stages).forEach((stage) => {
      if (stage?.skipped) {
        totals.skipped += 1;
      } else if (stage?.pass) {
        totals.pass += 1;
      } else {
        totals.fail += 1;
      }
    });
  });

  const runtimeText = Number.isFinite(runtimeMs) && runtimeMs > 0
    ? `${Math.round(runtimeMs)} ms`
    : '—';

  if (error) {
    summaryNode.textContent = `Tests failed to run (${runtimeText}).`;
    summaryNode.className = 'tests-summary tests-summary--fail';
    return;
  }

  summaryNode.textContent = `Pass: ${totals.pass} · Fail: ${totals.fail} · Skipped: ${totals.skipped} · Runtime: ${runtimeText}`;
  summaryNode.className = totals.fail > 0
    ? 'tests-summary tests-summary--fail'
    : totals.skipped > 0
      ? 'tests-summary tests-summary--warn'
      : 'tests-summary tests-summary--pass';
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
  const skipped = Boolean(stage?.skipped);
  let label = 'Fail';
  let statusClass = 'tests-status--fail';

  if (skipped) {
    label = 'Skipped';
    statusClass = 'tests-status--skipped';
  } else if (pass) {
    label = 'Pass';
    statusClass = 'tests-status--pass';
  }

  cell.textContent = label;
  cell.className = `tests-status ${statusClass}`;
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
    if (stageResult?.skipped) {
      item.className = 'tests-details__item--skipped';
    } else {
      item.className = stageResult?.pass ? 'tests-details__item--pass' : 'tests-details__item--fail';
    }

    const title = document.createElement('div');
    title.className = 'tests-details__title';
    let statusLabel = 'Fail';
    if (stageResult?.skipped) {
      statusLabel = 'Skipped';
    } else if (stageResult?.pass) {
      statusLabel = 'Pass';
    }
    title.textContent = `${stageName}: ${statusLabel}`;
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
  const runCheck = () => {
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
    return buildStageResult(pass ? 'pass' : 'fail', pass
      ? 'Required DOM elements present; tab switching did not throw.'
      : formatDomWiringMessage(missing, tabError), {
      missingIds: missing,
      tabButtonCount: tabButtons.length,
    });
  };

  try {
    return await runWithTimeout(runCheck, OVERLAY_INIT_TIMEOUT_MS, 'DOM wiring timed out.');
  } catch (error) {
    return buildStageResult('fail', formatError(error));
  }
}

async function runImageLoadTest(sample) {
  const imageElement = new Image();
  try {
    await runWithTimeout(
      () => loadImage(imageElement, sample.src),
      IMAGE_LOAD_TIMEOUT_MS,
      'Image load timed out.',
    );

    let bitmap = null;
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(imageElement);
    }

    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }

    return {
      imageElement,
      stage: buildStageResult('pass', 'Image loaded successfully.', {
        width: imageElement.naturalWidth,
        height: imageElement.naturalHeight,
        source: sample.src,
      }),
    };
  } catch (error) {
    return {
      imageElement: null,
      stage: buildStageResult('fail', formatError(error), {
        source: sample.src,
      }),
    };
  }
}

async function runPaperDetectionTest(imageElement) {
  if (!imageElement) {
    return {
      stage: buildStageResult('fail', 'Skipped paper detection because the image failed to load.'),
      points: null,
    };
  }

  try {
    await runWithTimeout(
      () => waitForOpenCv(),
      OPEN_CV_TIMEOUT_MS,
      'OpenCV readiness timed out.',
    );

    const detection = await runWithTimeout(() => {
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

      return points;
    }, PAPER_DETECT_TIMEOUT_MS, 'Paper detection timed out.');

    const points = detection;

    if (points && points.length) {
      return {
        stage: buildStageResult('pass', 'Paper contour detected.', {
          pointCount: points.length,
        }),
        points,
      };
    }

    return {
      stage: buildStageResult('pass', 'Paper contour not found, but handled gracefully.', {}),
      points: null,
    };
  } catch (error) {
    return {
      stage: buildStageResult('fail', formatError(error)),
      points: null,
    };
  }
}

async function runOverlayInitTest(points, imageElement, sandbox) {
  if (!imageElement) {
    return buildStageResult('fail', 'Skipped overlay init because the image failed to load.');
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

    await runWithTimeout(() => {
      attachPaperOverlay(overlay, corners, renderInfo);
    }, OVERLAY_INIT_TIMEOUT_MS, 'Overlay init timed out.');

    return buildStageResult('pass', 'Overlay initialized without throwing.', {
      cornersProvided: Boolean(corners),
    });
  } catch (error) {
    return buildStageResult('fail', formatError(error));
  } finally {
    overlay.remove();
  }
}

async function runStlSmokeTest(sandbox) {
  let threeReady = false;
  try {
    await runWithTimeout(() => ensureThreeJs(), THREE_LOAD_TIMEOUT_MS, 'Three.js load timed out.');
    threeReady = true;
  } catch (error) {
    return buildStageResult(
      'skipped',
      `Three.js unavailable; skipping STL smoke. ${formatError(error)}`,
      { reason: 'three.js unavailable' },
    );
  }

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
    await runWithTimeout(() => {
      stlSmokeState.downloadButton.click();
    }, STL_TIMEOUT_MS, 'STL export timed out.');

    const pass = Boolean(stlSmokeState.controller) && blobSize > 0 && threeReady;
    return buildStageResult(pass ? 'pass' : 'fail',
      pass
        ? 'STL designer initialized and export produced output.'
        : 'STL export did not produce output.', {
      blobSize,
    });
  } catch (error) {
    return buildStageResult('fail', formatError(error));
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  }
}

function buildStageResult(status, message, metrics = {}) {
  const normalized = status === 'skipped'
    ? 'skipped'
    : status === 'pass'
      ? 'pass'
      : 'fail';
  return {
    pass: normalized === 'pass',
    skipped: normalized === 'skipped',
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

function runWithTimeout(task, timeoutMs, timeoutMessage) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(task);
  }

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(timeoutMessage || `Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([
    Promise.resolve().then(task),
    timeoutPromise,
  ]).finally(() => {
    window.clearTimeout(timeoutId);
  });
}

function openTestsTab() {
  const tabButton = document.querySelector(`button[${TAB_DATA_ATTRIBUTE}="tests"]`);
  if (tabButton) {
    tabButton.click();
  }
}

function shouldAutorunTests() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('runTests') === '1';
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

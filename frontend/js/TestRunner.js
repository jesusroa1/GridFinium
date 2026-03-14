import { detectPaperContour, extractContourPoints } from './PaperOutlining.js';
import { detectObjectContour, extractPoints } from './ObjectDetection.js';

const DOM_IDS = Object.freeze({
  runAllButton: 'tests-run-all',
  resultsBody: 'tests-results-body',
  resultsCards: 'tests-results-cards',
  sandbox: 'tests-sandbox',
});

const REQUIRED_DOM_IDS = [
  'file-upload',
  'output-canvas',
  'status',
  'results',
  DOM_IDS.runAllButton,
  DOM_IDS.resultsBody,
  DOM_IDS.resultsCards,
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
];

const OPEN_CV_POLL_INTERVAL_MS = 50;
const OPEN_CV_TIMEOUT_MS = 10000;

export function initTestRunner() {
  const runAllButton = document.getElementById(DOM_IDS.runAllButton);
  const resultsBody = document.getElementById(DOM_IDS.resultsBody);
  const resultsCards = document.getElementById(DOM_IDS.resultsCards);
  const sandbox = document.getElementById(DOM_IDS.sandbox);

  if (!runAllButton || !resultsBody || !resultsCards || !sandbox) return;

  renderEmptyState(resultsBody, resultsCards);

  let running = false;

  const runAll = async () => {
    if (running) return;
    running = true;
    runAllButton.disabled = true;
    runAllButton.textContent = 'Running...';

    try {
      const domWiringStage = await runDomWiringTest();

      const results = [];

      for (const sample of TEST_SAMPLES) {
        const startedAt = new Date().toISOString();
        const stages = {};

        stages['DOM Wiring'] = domWiringStage;

        const loadResult = await runImageLoadTest(sample);
        stages['Load'] = loadResult.stage;

        const detectionResult = await runPaperDetectionTest(loadResult.imageElement);
        stages['Paper Detect'] = detectionResult.stage;

        stages['Object Detect'] = await runObjectDetectionTest(
          loadResult.imageElement,
          detectionResult.paperContour,
        );

        const overallPass = Object.values(stages).every((stage) => stage?.pass);

        results.push({
          sampleName: sample.name,
          stages,
          overallPass,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }

      renderResults(resultsBody, resultsCards, results);
    } catch (error) {
      console.error('GridFinium: test run failed.', error);
      renderError(resultsBody, resultsCards, error);
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

function renderEmptyState(resultsBody, resultsCards) {
  resultsBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.textContent = 'No test results yet. Click "Run All" to start the smoke checks.';
  cell.className = 'tests-table__empty';
  row.appendChild(cell);
  resultsBody.appendChild(row);

  resultsCards.replaceChildren();
  const card = document.createElement('div');
  card.className = 'tests-card tests-card__empty';
  card.textContent = 'No test results yet. Tap "Run All" to start the smoke checks.';
  resultsCards.appendChild(card);
}

function renderError(resultsBody, resultsCards, error) {
  resultsBody.replaceChildren();
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.className = 'tests-table__empty tests-table__empty--error';
  cell.textContent = `Test run failed: ${formatError(error)}`;
  row.appendChild(cell);
  resultsBody.appendChild(row);

  resultsCards.replaceChildren();
  const card = document.createElement('div');
  card.className = 'tests-card tests-card__empty tests-table__empty--error';
  card.textContent = `Test run failed: ${formatError(error)}`;
  resultsCards.appendChild(card);
}

function renderResults(resultsBody, resultsCards, results) {
  resultsBody.replaceChildren();

  results.forEach((result) => {
    const row = document.createElement('tr');
    row.appendChild(buildTextCell(result.sampleName));
    row.appendChild(buildStatusCell(result.stages['Load']));
    row.appendChild(buildStatusCell(result.stages['Paper Detect']));
    row.appendChild(buildStatusCell(result.stages['Object Detect']));
    row.appendChild(buildOverallCell(result.overallPass));
    resultsBody.appendChild(row);

    const detailsRow = document.createElement('tr');
    const detailsCell = document.createElement('td');
    detailsCell.colSpan = 5;
    detailsCell.appendChild(buildDetailsPanel(result));
    detailsRow.appendChild(detailsCell);
    resultsBody.appendChild(detailsRow);
  });

  resultsCards.replaceChildren();
  results.forEach((result) => {
    resultsCards.appendChild(buildCard(result));
  });
}

function buildTextCell(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  cell.title = text;
  cell.className = 'tests-sample';
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

function buildCard(result) {
  const card = document.createElement('article');
  card.className = 'tests-card';

  const header = document.createElement('div');
  header.className = 'tests-card__header';

  const title = document.createElement('h3');
  title.className = 'tests-card__title';
  title.textContent = result.sampleName;
  title.title = result.sampleName;
  header.appendChild(title);

  const overall = document.createElement('span');
  overall.className = `tests-status tests-status--${result.overallPass ? 'pass' : 'fail'} tests-card__overall`;
  overall.textContent = result.overallPass ? 'Pass' : 'Fail';
  header.appendChild(overall);

  card.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'tests-card__list';

  Object.entries(result.stages).forEach(([stageName, stageResult]) => {
    const item = document.createElement('li');
    item.className = 'tests-card__row';

    const stageRow = document.createElement('div');
    stageRow.className = 'tests-card__stage';

    const label = document.createElement('span');
    label.textContent = stageName;
    stageRow.appendChild(label);

    const status = document.createElement('span');
    status.className = `tests-status tests-status--${stageResult?.pass ? 'pass' : 'fail'}`;
    status.textContent = stageResult?.pass ? 'Pass' : 'Fail';
    stageRow.appendChild(status);

    item.appendChild(stageRow);

    if (stageResult?.message || stageResult?.metrics) {
      const details = document.createElement('details');
      details.className = 'tests-card__details';

      const summary = document.createElement('summary');
      summary.textContent = 'Details';
      details.appendChild(summary);

      const body = document.createElement('div');
      body.className = 'tests-card__details-body';
      body.textContent = stageResult?.message || 'No message provided.';
      details.appendChild(body);

      if (stageResult?.metrics && Object.keys(stageResult.metrics).length > 0) {
        const metrics = document.createElement('pre');
        metrics.className = 'tests-details__metrics';
        metrics.textContent = JSON.stringify(stageResult.metrics, null, 2);
        body.appendChild(metrics);
      }

      item.appendChild(details);
    }

    list.appendChild(item);
  });

  card.appendChild(list);
  return card;
}

async function runDomWiringTest() {
  const missing = REQUIRED_DOM_IDS.filter((id) => !document.getElementById(id));
  const pass = missing.length === 0;
  return buildStageResult(
    pass,
    pass ? 'Required DOM elements present.' : `Missing IDs: ${missing.join(', ')}.`,
    { missingIds: missing },
  );
}

async function runImageLoadTest(sample) {
  const imageElement = new Image();
  try {
    await loadImage(imageElement, sample.src);
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
      stage: buildStageResult(false, formatError(error), { source: sample.src }),
    };
  }
}

async function runPaperDetectionTest(imageElement) {
  if (!imageElement) {
    return {
      stage: buildStageResult(false, 'Skipped: image failed to load.'),
      paperContour: null,
    };
  }

  try {
    await waitForOpenCv();
    const src = cv.imread(imageElement);
    let paperContour = null;
    let points = null;

    try {
      paperContour = detectPaperContour(src, () => {});
      if (paperContour) {
        points = extractContourPoints(paperContour);
      }
    } finally {
      src.delete();
    }

    if (points && points.length >= 4) {
      return {
        stage: buildStageResult(true, 'Paper contour detected.', { pointCount: points.length }),
        paperContour,
      };
    }

    if (paperContour) paperContour.delete();
    return {
      stage: buildStageResult(false, 'Paper contour not found in sample image.'),
      paperContour: null,
    };
  } catch (error) {
    return {
      stage: buildStageResult(false, formatError(error)),
      paperContour: null,
    };
  }
}

async function runObjectDetectionTest(imageElement, paperContour) {
  if (!imageElement) {
    return buildStageResult(false, 'Skipped: image failed to load.');
  }
  if (!paperContour) {
    return buildStageResult(false, 'Skipped: paper not detected.');
  }

  try {
    await waitForOpenCv();
    const src = cv.imread(imageElement);
    let objectContour = null;
    let points = null;

    try {
      objectContour = detectObjectContour(src, paperContour);
      if (objectContour) {
        points = extractPoints(objectContour);
        objectContour.delete();
      }
    } finally {
      paperContour.delete();
      src.delete();
    }

    if (points && points.length >= 3) {
      return buildStageResult(true, 'Object contour detected.', { pointCount: points.length });
    }

    return buildStageResult(
      false,
      'No object found inside the paper region. Check that the sample image has a clearly visible object on the paper.',
    );
  } catch (error) {
    return buildStageResult(false, formatError(error));
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

function formatError(error) {
  if (!error) return 'Unknown error';
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

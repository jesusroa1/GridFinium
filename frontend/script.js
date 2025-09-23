(function () {
  var dropzone = document.getElementById("upload-dropzone");
  var fileInput = document.getElementById("file-input");
  var preview = document.getElementById("preview");
  var previewImage = document.getElementById("preview-image");
  var previewStage = document.getElementById("preview-stage");
  var clearButton = document.getElementById("clear-button");
  var analyzeButton = document.getElementById("analyze-button");
  var exportButton = document.getElementById("export-button");
  var paperSizeSelect = document.getElementById("paper-size");
  var metricScale = document.getElementById("metric-scale");
  var metricCoverage = document.getElementById("metric-coverage");
  var metricCorners = document.getElementById("metric-corners");
  var warpContainer = document.getElementById("warp-preview");
  var warpCanvas = document.getElementById("warped-canvas");
  var warpReprojection = document.getElementById("warp-reprojection");
  var warpError = document.getElementById("warp-error");
  var calibrationCanvas = document.createElement("canvas");
  var canvasContext = calibrationCanvas.getContext("2d");
  var currentImageDataUrl = "";
  var cornerHandles = [];
  var handleCornerKeys = ["tl", "tr", "br", "bl"];
  var metricCornerLabels = null;
  var activeHandle = null;
  var lastAnalyzedImage = null;
  var lastOverlayScale = 1;
  var lastOverlayCanvasWidth = 0;
  var lastOverlayCanvasHeight = 0;
  var pendingOverlayRender = false;
  var lastPreviewDataUrl = "";
  var detectionCanvas = document.createElement("canvas");
  var detectionContext =
    detectionCanvas.getContext("2d", { willReadFrequently: true }) ||
    detectionCanvas.getContext("2d");
  var lastDetectedRegion = null;
  var calibrationState = null;
  var warpState = null;
  var lastWarpSignature = null;
  var pendingHomographyRequest = null;
  var cvReady =
    typeof cv !== "undefined" &&
    cv &&
    typeof cv.Mat === "function" &&
    typeof cv.getPerspectiveTransform === "function";
  var cvCheckIntervalId = null;
  var themeToggle = document.getElementById("theme-toggle");
  var themeLabel = document.getElementById("theme-toggle-label");
  var deploymentInfo = document.getElementById("deployment-info");
  var deploymentTimestamp = document.getElementById("deployment-timestamp");
  var themeStorageKey = "gridfinium-theme";
  var themeMediaQuery =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

  if (typeof window !== "undefined") {
    var moduleConfig = window.Module || {};
    var previousRuntimeInitialized = moduleConfig.onRuntimeInitialized;
    moduleConfig.onRuntimeInitialized = function () {
      if (typeof previousRuntimeInitialized === "function") {
        try {
          previousRuntimeInitialized();
        } catch (runtimeError) {
          console.error(runtimeError);
        }
      }

      cvReady =
        typeof cv !== "undefined" &&
        cv &&
        typeof cv.Mat === "function" &&
        typeof cv.getPerspectiveTransform === "function";
      if (cvReady) {
        handlePendingHomography();
      }
    };
    window.Module = moduleConfig;
  }

  if (metricCorners) {
    metricCornerLabels = {};

    for (var labelIndex = 0; labelIndex < handleCornerKeys.length; labelIndex++) {
      var cornerKey = handleCornerKeys[labelIndex];
      metricCornerLabels[cornerKey] = metricCorners.querySelector(
        '[data-corner="' + cornerKey + '"]'
      );
    }
  }

  function getStoredTheme() {
    if (typeof window === "undefined" || !window.localStorage) {
      return null;
    }
    try {
      var stored = window.localStorage.getItem(themeStorageKey);
      if (stored === "dark" || stored === "light") {
        return stored;
      }
    } catch (error) {
      // Local storage might be unavailable (e.g. privacy mode). Ignore errors.
    }
    return null;
  }

  function storeTheme(theme) {
    if (typeof window === "undefined" || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch (error) {
      // Ignore storage errors and keep working with in-memory preference.
    }
  }

  function applyTheme(theme) {
    var nextTheme = theme === "dark" ? "dark" : "light";
    var root = document.documentElement;

    if (root) {
      root.setAttribute("data-theme", nextTheme);
    }

    if (themeToggle) {
      var isDark = nextTheme === "dark";
      themeToggle.setAttribute("aria-pressed", isDark ? "true" : "false");
      themeToggle.setAttribute(
        "aria-label",
        isDark ? "Switch to light mode" : "Switch to dark mode"
      );
    }

    if (themeLabel) {
      themeLabel.textContent = nextTheme === "dark" ? "Dark mode" : "Light mode";
    }
  }

  var storedThemePreference = getStoredTheme();
  var prefersDark = themeMediaQuery ? themeMediaQuery.matches : false;
  var initialTheme = storedThemePreference || "dark";
  applyTheme(initialTheme);

  if (themeMediaQuery) {
    var handleThemeChange = function (event) {
      if (getStoredTheme() !== null) {
        return;
      }
      applyTheme(event.matches ? "dark" : "light");
    };

    if (typeof themeMediaQuery.addEventListener === "function") {
      themeMediaQuery.addEventListener("change", handleThemeChange);
    } else if (typeof themeMediaQuery.addListener === "function") {
      themeMediaQuery.addListener(handleThemeChange);
    }
  }

  if (themeToggle) {
    themeToggle.addEventListener("click", function () {
      var currentTheme =
        document.documentElement.getAttribute("data-theme") === "dark"
          ? "dark"
          : "light";
      var nextTheme = currentTheme === "dark" ? "light" : "dark";
      applyTheme(nextTheme);
      storeTheme(nextTheme);
    });
  }

  function fetchDeploymentTimestamp() {
    if (
      !deploymentTimestamp ||
      typeof fetch !== "function" ||
      typeof window === "undefined"
    ) {
      return;
    }

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeoutId = null;

    if (controller && typeof window.setTimeout === "function") {
      timeoutId = window.setTimeout(function () {
        controller.abort();
      }, 5000);
    }

    fetch("deployment.json", {
      signal: controller ? controller.signal : undefined,
      cache: "no-store",
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Failed to load deployment info");
        }
        return response.json();
      })
      .then(function (payload) {
        if (!payload || typeof payload.deployedAt !== "string") {
          throw new Error("Invalid deployment payload");
        }

        var timestamp = new Date(payload.deployedAt);
        if (isNaN(timestamp.getTime())) {
          throw new Error("Invalid deployment timestamp");
        }

        var formatter =
          typeof Intl !== "undefined" &&
          Intl.DateTimeFormat &&
          typeof Intl.DateTimeFormat === "function"
            ? new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : null;

        var formatted = formatter
          ? formatter.format(timestamp)
          : timestamp.toLocaleString();

        var isoTimestamp = timestamp.toISOString();
        deploymentTimestamp.textContent = formatted;
        deploymentTimestamp.dateTime = isoTimestamp;
        deploymentTimestamp.setAttribute("datetime", isoTimestamp);

        if (deploymentInfo) {
          deploymentInfo.removeAttribute("data-status");
        }
      })
      .catch(function () {
        if (deploymentTimestamp) {
          deploymentTimestamp.textContent = "Unavailable";
          deploymentTimestamp.removeAttribute("datetime");
        }
        if (deploymentInfo) {
          deploymentInfo.setAttribute("data-status", "error");
        }
      })
      .finally(function () {
        if (timeoutId && typeof window.clearTimeout === "function") {
          window.clearTimeout(timeoutId);
        }
      });
  }

  fetchDeploymentTimestamp();

  if (previewStage) {
    var handleLabels = {
      tl: "Adjust top-left corner",
      tr: "Adjust top-right corner",
      br: "Adjust bottom-right corner",
      bl: "Adjust bottom-left corner"
    };

    handleCornerKeys.forEach(function (key, index) {
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "quad-handle";
      handle.dataset.corner = key;
      handle.dataset.index = String(index);
      handle.setAttribute("aria-label", handleLabels[key]);
      handle.addEventListener("pointerdown", onHandlePointerDown);
      handle.addEventListener("pointermove", onHandlePointerMove);
      handle.addEventListener("pointerup", onHandlePointerUp);
      handle.addEventListener("pointercancel", onHandlePointerUp);
      previewStage.appendChild(handle);
      cornerHandles.push(handle);
    });

    updateHandlePositions();
  }

  if (previewImage) {
    previewImage.addEventListener("load", updateHandlePositions);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("resize", updateHandlePositions);
  }

  if (fileInput && typeof navigator !== "undefined") {
    var isIOS = /iP(ad|hone|od)/.test(navigator.platform || "") ||
      (navigator.userAgent && navigator.userAgent.includes("Mac") &&
        "ontouchend" in document);

    if (isIOS) {
      fileInput.removeAttribute("capture");
    }
  }

  function resetAnalysis() {
    lastDetectedRegion = null;
    calibrationState = null;
    resetWarpState();
    lastAnalyzedImage = null;
    lastOverlayScale = 1;
    lastOverlayCanvasWidth = 0;
    lastOverlayCanvasHeight = 0;
    pendingOverlayRender = false;
    lastPreviewDataUrl = "";

    if (activeHandle && activeHandle.element && activeHandle.element.classList) {
      activeHandle.element.classList.remove("quad-handle--dragging");
    }
    activeHandle = null;

    for (var handleIndex = 0; handleIndex < cornerHandles.length; handleIndex++) {
      var handle = cornerHandles[handleIndex];
      if (handle) {
        handle.style.left = "";
        handle.style.top = "";
        handle.classList.remove("quad-handle--dragging");
      }
    }

    updateHandlePositions();

    if (exportButton) {
      exportButton.disabled = true;
    }

    if (typeof window !== "undefined") {
      window.gridFiniumCalibration = null;
    }

    if (!calibrationCanvas || !canvasContext) {
      return;
    }

    calibrationCanvas.width = 0;
    calibrationCanvas.height = 0;
    canvasContext.clearRect(0, 0, calibrationCanvas.width, calibrationCanvas.height);

    updateCalibrationMetrics(null);
    updateExportButtonState();
  }

  function resetPreview() {
    preview.hidden = true;
    previewImage.src = "";
    analyzeButton.disabled = true;
    fileInput.value = "";
    currentImageDataUrl = "";
    resetAnalysis();
  }

  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      resetPreview();
      return;
    }

    resetAnalysis();

    var reader = new FileReader();
    reader.onload = function (event) {
      currentImageDataUrl = event.target.result;
      previewImage.src = currentImageDataUrl;
      lastPreviewDataUrl = currentImageDataUrl;
      preview.hidden = false;
      analyzeButton.disabled = false;
      updateHandlePositions();
      runAnalysis();
    };
    reader.readAsDataURL(file);
  }

  function getPaperAspectRatio() {
    if (!paperSizeSelect) {
      return 11 / 8.5;
    }

    switch (paperSizeSelect.value) {
      case "a4":
        return 297 / 210;
      case "letter":
      default:
        return 11 / 8.5;
    }
  }

  function getPaperMeasurements() {
    if (!paperSizeSelect) {
      return { shortLabel: "8.5 in", longLabel: "11 in" };
    }

    switch (paperSizeSelect.value) {
      case "a4":
        return { shortLabel: "210 mm", longLabel: "297 mm" };
      case "letter":
      default:
        return { shortLabel: "8.5 in", longLabel: "11 in" };
    }
  }

  function getPaperPhysicalDimensions() {
    if (!paperSizeSelect) {
      return { short: 215.9, long: 279.4, unit: "mm" };
    }

    switch (paperSizeSelect.value) {
      case "a4":
        return { short: 210, long: 297, unit: "mm" };
      case "letter":
      default:
        return { short: 215.9, long: 279.4, unit: "mm" };
    }
  }

  function orderQuad(points) {
    if (!points || points.length < 4) {
      return [];
    }

    var filtered = [];

    for (var index = 0; index < points.length; index++) {
      var point = points[index];
      if (!point) {
        continue;
      }

      var x = Number(point.x);
      var y = Number(point.y);

      if (!isFinite(x) || !isFinite(y)) {
        continue;
      }

      filtered.push({ x: x, y: y });
      if (filtered.length === 4) {
        break;
      }
    }

    if (filtered.length !== 4) {
      return [];
    }

    var centroidX = 0;
    var centroidY = 0;

    for (var centroidIndex = 0; centroidIndex < filtered.length; centroidIndex++) {
      centroidX += filtered[centroidIndex].x;
      centroidY += filtered[centroidIndex].y;
    }

    centroidX /= filtered.length;
    centroidY /= filtered.length;

    var pointsWithAngles = filtered.map(function (point) {
      return {
        point: { x: point.x, y: point.y },
        angle: Math.atan2(point.y - centroidY, point.x - centroidX)
      };
    });

    pointsWithAngles.sort(function (a, b) {
      return a.angle - b.angle;
    });

    var startIndex = 0;
    var minSum = Infinity;

    for (var angleIndex = 0; angleIndex < pointsWithAngles.length; angleIndex++) {
      var candidate = pointsWithAngles[angleIndex].point;
      var sum = candidate.x + candidate.y;
      if (sum < minSum) {
        minSum = sum;
        startIndex = angleIndex;
      }
    }

    var ordered = [];
    for (var orderedIndex = 0; orderedIndex < pointsWithAngles.length; orderedIndex++) {
      var nextIndex = (startIndex + orderedIndex) % pointsWithAngles.length;
      var nextPoint = pointsWithAngles[nextIndex].point;
      ordered.push({ x: nextPoint.x, y: nextPoint.y });
    }

    if (ordered.length !== 4) {
      return [];
    }

    var twiceArea = 0;
    for (var areaIndex = 0; areaIndex < ordered.length; areaIndex++) {
      var current = ordered[areaIndex];
      var following = ordered[(areaIndex + 1) % ordered.length];
      twiceArea += current.x * following.y - following.x * current.y;
    }

    var polygonArea = Math.abs(twiceArea) * 0.5;
    if (!isFinite(polygonArea) || polygonArea < 1) {
      return [];
    }

    var crossSign = 0;
    for (var crossIndex = 0; crossIndex < ordered.length; crossIndex++) {
      var a = ordered[crossIndex];
      var b = ordered[(crossIndex + 1) % ordered.length];
      var c = ordered[(crossIndex + 2) % ordered.length];

      var abx = b.x - a.x;
      var aby = b.y - a.y;
      var bcx = c.x - b.x;
      var bcy = c.y - b.y;

      var crossProduct = abx * bcy - aby * bcx;
      if (!isFinite(crossProduct)) {
        return [];
      }

      var abLength = Math.sqrt(abx * abx + aby * aby);
      var bcLength = Math.sqrt(bcx * bcx + bcy * bcy);
      var lengthProduct = abLength * bcLength;

      if (lengthProduct > 0) {
        var normalized = Math.abs(crossProduct) / lengthProduct;
        if (normalized < 1e-3) {
          return [];
        }
      }

      if (Math.abs(crossProduct) < 1e-4) {
        continue;
      }

      var sign = crossProduct > 0 ? 1 : -1;
      if (crossSign === 0) {
        crossSign = sign;
      } else if (crossSign * sign < 0) {
        return [];
      }
    }

    return ordered;
  }

  function orderPoints(corners) {
    return orderQuad(corners);
  }

  function distanceBetweenPoints(a, b) {
    if (!a || !b) {
      return NaN;
    }

    var dx = Number(b.x) - Number(a.x);
    var dy = Number(b.y) - Number(a.y);

    if (!isFinite(dx) || !isFinite(dy)) {
      return NaN;
    }

    return Math.sqrt(dx * dx + dy * dy);
  }

  function resetWarpState() {
    warpState = null;
    lastWarpSignature = null;
    pendingHomographyRequest = null;

    if (warpReprojection) {
      warpReprojection.textContent = "";
      warpReprojection.removeAttribute("data-status");
    }

    if (warpError) {
      warpError.textContent = "";
      warpError.hidden = true;
    }

    if (warpContainer) {
      warpContainer.hidden = true;
      warpContainer.removeAttribute("data-status");
    }

    if (warpCanvas) {
      var warpContext = warpCanvas.getContext("2d");
      if (warpContext) {
        warpContext.clearRect(0, 0, warpCanvas.width, warpCanvas.height);
      }
      warpCanvas.width = 0;
      warpCanvas.height = 0;
    }

    if (typeof window !== "undefined") {
      window.gridFiniumWarp = null;
    }
  }

  function showWarpError(message, keepExistingView) {
    if (warpError) {
      warpError.textContent = message;
      warpError.hidden = false;
    }

    if (warpContainer) {
      warpContainer.hidden = false;
      warpContainer.setAttribute(
        "data-status",
        keepExistingView ? "warning" : "error"
      );
    }
  }

  function clearWarpError() {
    if (warpError) {
      warpError.textContent = "";
      warpError.hidden = true;
    }

    if (warpContainer) {
      warpContainer.removeAttribute("data-status");
    }
  }

  function setWarpReprojectionMessage(meanError) {
    if (!warpReprojection) {
      return;
    }

    if (!isFinite(meanError)) {
      warpReprojection.textContent = "";
      warpReprojection.removeAttribute("data-status");
      if (warpContainer) {
        warpContainer.removeAttribute("data-status");
      }
      return;
    }

    var message = "Mean reprojection error: " + meanError.toFixed(2) + " px";

    if (meanError > 5) {
      message += " (adjust corners for best accuracy)";
      warpReprojection.setAttribute("data-status", "warning");
      if (warpContainer && !warpContainer.hasAttribute("data-status")) {
        warpContainer.setAttribute("data-status", "warning");
      }
    } else {
      warpReprojection.removeAttribute("data-status");
      if (warpContainer && warpContainer.getAttribute("data-status") === "warning") {
        warpContainer.removeAttribute("data-status");
      }
    }

    warpReprojection.textContent = message;
  }

  function buildPaperSpecForWarp(corners, calibration) {
    var physical = getPaperPhysicalDimensions();
    if (!physical) {
      return { widthMM: 215.9, heightMM: 279.4 };
    }

    var orientation = calibration && calibration.orientation;

    if (!orientation && corners && corners.length >= 4) {
      var topWidth = distanceBetweenPoints(corners[0], corners[1]);
      var leftHeight = distanceBetweenPoints(corners[0], corners[3]);

      if (isFinite(topWidth) && isFinite(leftHeight)) {
        orientation = topWidth >= leftHeight ? "landscape" : "portrait";
      }
    }

    if (orientation === "landscape") {
      return { widthMM: physical.long, heightMM: physical.short };
    }

    return { widthMM: physical.short, heightMM: physical.long };
  }

  function handlePendingHomography() {
    if (!pendingHomographyRequest) {
      return;
    }

    var request = pendingHomographyRequest;
    pendingHomographyRequest = null;

    computeAndDisplayHomography(
      request.fourPts,
      request.paperSpec,
      request.pixelsPerMM,
      request.srcImage,
      true
    );
  }

  function ensureCvInitialization() {
    if (cvReady) {
      if (cvCheckIntervalId && typeof window !== "undefined") {
        window.clearInterval(cvCheckIntervalId);
        cvCheckIntervalId = null;
      }
      return;
    }

    if (
      typeof cv !== "undefined" &&
      cv &&
      typeof cv.Mat === "function" &&
      typeof cv.getPerspectiveTransform === "function"
    ) {
      cvReady = true;
      if (cvCheckIntervalId && typeof window !== "undefined") {
        window.clearInterval(cvCheckIntervalId);
        cvCheckIntervalId = null;
      }
      handlePendingHomography();
      return;
    }

    if (
      !cvCheckIntervalId &&
      typeof window !== "undefined" &&
      typeof window.setInterval === "function"
    ) {
      cvCheckIntervalId = window.setInterval(function () {
        if (
          typeof cv !== "undefined" &&
          cv &&
          typeof cv.Mat === "function" &&
          typeof cv.getPerspectiveTransform === "function"
        ) {
          cvReady = true;
          window.clearInterval(cvCheckIntervalId);
          cvCheckIntervalId = null;
          handlePendingHomography();
        }
      }, 250);
    }
  }

  function scheduleHomographyComputation(
    corners,
    paperSpec,
    pixelsPerMM,
    srcImageElOrMat
  ) {
    if (!corners || corners.length < 4 || !srcImageElOrMat) {
      if (!warpState) {
        resetWarpState();
      }
      return;
    }

    var copiedCorners = corners.map(function (point) {
      return { x: point.x, y: point.y };
    });

    var specCopy = paperSpec
      ? { widthMM: paperSpec.widthMM, heightMM: paperSpec.heightMM }
      : null;

    var invokeComputation = function () {
      computeAndDisplayHomography(
        copiedCorners,
        specCopy,
        pixelsPerMM,
        srcImageElOrMat,
        false
      );
    };

    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      window.requestAnimationFrame(invokeComputation);
    } else {
      invokeComputation();
    }
  }

  function transformPointWithMatrix(point, matrixData) {
    if (!point || !matrixData || matrixData.length !== 9) {
      return null;
    }

    if (typeof cv === "undefined" || !cv.matFromArray || !cv.perspectiveTransform) {
      return null;
    }

    var srcMat = null;
    var dstMat = null;
    var matrix = null;

    try {
      var x = Number(point.x);
      var y = Number(point.y);

      if (!isFinite(x) || !isFinite(y)) {
        return null;
      }

      srcMat = cv.matFromArray(1, 1, cv.CV_32FC2, [x, y]);
      matrix = cv.matFromArray(3, 3, cv.CV_64F, matrixData);
      dstMat = new cv.Mat();
      cv.perspectiveTransform(srcMat, dstMat, matrix);

      if (!dstMat.data32F || dstMat.data32F.length < 2) {
        return null;
      }

      return { x: dstMat.data32F[0], y: dstMat.data32F[1] };
    } catch (error) {
      return null;
    } finally {
      if (srcMat) {
        srcMat.delete();
      }
      if (dstMat) {
        dstMat.delete();
      }
      if (matrix) {
        matrix.delete();
      }
    }
  }

  function createTransformFunction(matrixData) {
    if (!matrixData) {
      return function () {
        return null;
      };
    }

    var storedMatrix = matrixData.slice();
    return function (point) {
      return transformPointWithMatrix(point, storedMatrix);
    };
  }

  function computeAndDisplayHomography(
    fourPts,
    paperSpec,
    pixelsPerMM,
    srcImageElOrMat,
    isRetry
  ) {
    if (!isRetry) {
      pendingHomographyRequest = null;
    }

    if (!fourPts || fourPts.length < 4) {
      if (warpState && warpState.warpedImageUrl) {
        showWarpError(
          "Select four valid corners to compute the perspective view.",
          true
        );
      } else {
        resetWarpState();
      }
      return;
    }

    var ordered = orderQuad(fourPts);
    if (!ordered || ordered.length !== 4) {
      if (warpState && warpState.warpedImageUrl) {
        showWarpError(
          "Corner order is invalid. Please adjust the markers and try again.",
          true
        );
      } else {
        resetWarpState();
      }
      return;
    }

    var spec = paperSpec;
    if (!spec || !isFinite(spec.widthMM) || !isFinite(spec.heightMM)) {
      spec = buildPaperSpecForWarp(ordered, calibrationState);
    }

    var widthMM = Number(spec.widthMM);
    var heightMM = Number(spec.heightMM);

    if (!isFinite(widthMM) || widthMM <= 0 || !isFinite(heightMM) || heightMM <= 0) {
      showWarpError("Paper dimensions are invalid.", Boolean(warpState));
      return;
    }

    var effectivePixelsPerMM =
      typeof pixelsPerMM === "number" && isFinite(pixelsPerMM) && pixelsPerMM > 0
        ? pixelsPerMM
        : 3; // TODO: Replace fallback density once calibration is finalized.

    var srcWidth = 0;
    var srcHeight = 0;

    if (srcImageElOrMat) {
      if (
        typeof srcImageElOrMat.cols === "number" &&
        typeof srcImageElOrMat.rows === "number"
      ) {
        srcWidth = Number(srcImageElOrMat.cols);
        srcHeight = Number(srcImageElOrMat.rows);
      } else if (
        typeof srcImageElOrMat.naturalWidth === "number" &&
        typeof srcImageElOrMat.naturalHeight === "number"
      ) {
        srcWidth = Number(srcImageElOrMat.naturalWidth);
        srcHeight = Number(srcImageElOrMat.naturalHeight);
      } else if (
        typeof srcImageElOrMat.videoWidth === "number" &&
        typeof srcImageElOrMat.videoHeight === "number"
      ) {
        srcWidth = Number(srcImageElOrMat.videoWidth);
        srcHeight = Number(srcImageElOrMat.videoHeight);
      } else if (
        typeof srcImageElOrMat.width === "number" &&
        typeof srcImageElOrMat.height === "number"
      ) {
        srcWidth = Number(srcImageElOrMat.width);
        srcHeight = Number(srcImageElOrMat.height);
      }
    }

    if (!isFinite(srcWidth) || !isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
      showWarpError("Source image data is unavailable for warping.", Boolean(warpState));
      return;
    }

    var destinationWidth = Math.max(1, Math.round(widthMM * effectivePixelsPerMM));
    var destinationHeight = Math.max(1, Math.round(heightMM * effectivePixelsPerMM));

    if (destinationWidth <= 0 || destinationHeight <= 0) {
      showWarpError("Computed warp dimensions are invalid.", Boolean(warpState));
      return;
    }

    var maxOutputSide = 4000;
    var largestSide = Math.max(destinationWidth, destinationHeight);
    if (largestSide > maxOutputSide) {
      var downscale = maxOutputSide / largestSide;
      destinationWidth = Math.max(1, Math.round(destinationWidth * downscale));
      destinationHeight = Math.max(1, Math.round(destinationHeight * downscale));
      effectivePixelsPerMM *= downscale;
    }

    var destinationCorners = [
      { x: 0, y: 0 },
      { x: destinationWidth - 1, y: 0 },
      { x: destinationWidth - 1, y: destinationHeight - 1 },
      { x: 0, y: destinationHeight - 1 }
    ];

    var destinationArray = [
      0,
      0,
      destinationWidth - 1,
      0,
      destinationWidth - 1,
      destinationHeight - 1,
      0,
      destinationHeight - 1
    ];

    var signatureParts = [];
    for (var sigIndex = 0; sigIndex < ordered.length; sigIndex++) {
      signatureParts.push(ordered[sigIndex].x.toFixed(3));
      signatureParts.push(ordered[sigIndex].y.toFixed(3));
    }
    signatureParts.push(widthMM.toFixed(3));
    signatureParts.push(heightMM.toFixed(3));
    signatureParts.push(effectivePixelsPerMM.toFixed(4));
    signatureParts.push(String(srcWidth));
    signatureParts.push(String(srcHeight));

    var signature = signatureParts.join("|");

    if (
      !isRetry &&
      warpState &&
      warpState.signature === signature &&
      warpState.warpedImageUrl
    ) {
      if (warpContainer) {
        warpContainer.hidden = false;
      }
      clearWarpError();
      setWarpReprojectionMessage(warpState.reprojectionError);
      return;
    }

    if (!cvReady) {
      if (!isRetry) {
        pendingHomographyRequest = {
          fourPts: ordered.map(function (point) {
            return { x: point.x, y: point.y };
          }),
          paperSpec: { widthMM: widthMM, heightMM: heightMM },
          pixelsPerMM: pixelsPerMM,
          srcImage: srcImageElOrMat
        };
      }

      ensureCvInitialization();
      showWarpError("Loading computer vision engine…", Boolean(warpState));
      return;
    }

    var srcCornersMat = null;
    var dstCornersMat = null;
    var homography = null;
    var projected = null;
    var srcMat = null;
    var dstMat = null;
    var inverseHomography = null;
    var releaseSourceMat = false;

    try {
      srcCornersMat = cv.matFromArray(4, 1, cv.CV_32FC2, [
        ordered[0].x,
        ordered[0].y,
        ordered[1].x,
        ordered[1].y,
        ordered[2].x,
        ordered[2].y,
        ordered[3].x,
        ordered[3].y
      ]);
      dstCornersMat = cv.matFromArray(4, 1, cv.CV_32FC2, destinationArray);

      homography = cv.getPerspectiveTransform(srcCornersMat, dstCornersMat);
      if (!homography || homography.empty()) {
        showWarpError(
          "Unable to compute the perspective transform.",
          Boolean(warpState && warpState.warpedImageUrl)
        );
        return;
      }

      if (
        srcImageElOrMat &&
        typeof srcImageElOrMat.type === "number" &&
        typeof srcImageElOrMat.rows === "number" &&
        typeof srcImageElOrMat.cols === "number"
      ) {
        srcMat = srcImageElOrMat;
      } else {
        srcMat = cv.imread(srcImageElOrMat);
        releaseSourceMat = true;
      }

      if (!srcMat || srcMat.empty()) {
        showWarpError(
          "Unable to read source pixels for warping.",
          Boolean(warpState)
        );
        return;
      }

      dstMat = new cv.Mat();

      if (warpCanvas) {
        warpCanvas.width = destinationWidth;
        warpCanvas.height = destinationHeight;
      }

      cv.warpPerspective(
        srcMat,
        dstMat,
        homography,
        new cv.Size(destinationWidth, destinationHeight),
        cv.INTER_LINEAR,
        cv.BORDER_CONSTANT,
        new cv.Scalar(0, 0, 0, 0)
      );

      if (!dstMat || dstMat.empty()) {
        showWarpError(
          "Warping failed. Please adjust the selected corners.",
          Boolean(warpState && warpState.warpedImageUrl)
        );
        return;
      }

      cv.imshow("warped-canvas", dstMat);

      if (warpContainer) {
        warpContainer.hidden = false;
      }

      projected = new cv.Mat();
      cv.perspectiveTransform(srcCornersMat, projected, homography);

      var meanError = NaN;
      if (projected && projected.data32F && projected.data32F.length >= 8) {
        var totalError = 0;
        for (var errorIndex = 0; errorIndex < 4; errorIndex++) {
          var px = projected.data32F[errorIndex * 2];
          var py = projected.data32F[errorIndex * 2 + 1];
          var dx = px - destinationArray[errorIndex * 2];
          var dy = py - destinationArray[errorIndex * 2 + 1];
          totalError += Math.sqrt(dx * dx + dy * dy);
        }
        meanError = totalError / 4;
      }

      clearWarpError();
      setWarpReprojectionMessage(meanError);

      var homographyData = homography.data64F
        ? Array.from(homography.data64F)
        : Array.from(homography.data32F);

      var inverseData = null;
      inverseHomography = new cv.Mat();
      var invertStatus = cv.invert(
        homography,
        inverseHomography,
        cv.DECOMP_SVD
      );

      if (invertStatus !== 0) {
        inverseData = inverseHomography.data64F
          ? Array.from(inverseHomography.data64F)
          : Array.from(inverseHomography.data32F);
      } else {
        showWarpError(
          "Computed homography is not invertible.",
          Boolean(warpState && warpState.warpedImageUrl)
        );
      }

      var warpedImageUrl = null;
      if (warpCanvas) {
        try {
          warpedImageUrl = warpCanvas.toDataURL("image/png");
        } catch (canvasError) {
          warpedImageUrl = null;
        }
      }

      warpState = {
        homography: homographyData,
        inverseHomography: inverseData,
        dstWidth: destinationWidth,
        dstHeight: destinationHeight,
        pixelsPerMM: effectivePixelsPerMM,
        reprojectionError: meanError,
        warpedImageUrl: warpedImageUrl,
        paperSpec: { widthMM: widthMM, heightMM: heightMM },
        sourceSize: { width: srcWidth, height: srcHeight },
        destinationCorners: destinationCorners,
        sourceCorners: ordered.map(function (point) {
          return { x: point.x, y: point.y };
        }),
        signature: signature,
        timestamp: Date.now()
      };

      warpState.toWarped = createTransformFunction(homographyData);
      warpState.toOriginal = inverseData
        ? createTransformFunction(inverseData)
        : function () {
            return null;
          };

      lastWarpSignature = signature;
      pendingHomographyRequest = null;

      if (typeof window !== "undefined") {
        window.gridFiniumWarp = warpState;
      }
    } catch (error) {
      console.error("Homography computation failed", error);
      showWarpError(
        "Unable to compute the perspective transform.",
        Boolean(warpState && warpState.warpedImageUrl)
      );
    } finally {
      if (srcCornersMat) {
        srcCornersMat.delete();
      }
      if (dstCornersMat) {
        dstCornersMat.delete();
      }
      if (projected) {
        projected.delete();
      }
      if (inverseHomography) {
        inverseHomography.delete();
      }
      if (homography) {
        homography.delete();
      }
      if (dstMat) {
        dstMat.delete();
      }
      if (releaseSourceMat && srcMat) {
        srcMat.delete();
      }
    }
  }

  function detectPaperBounds(image) {
    if (!detectionContext) {
      return null;
    }

    var maxDimension = 640;
    var scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    if (!isFinite(scale) || scale <= 0) {
      scale = 1;
    }

    var scaledWidth = Math.max(1, Math.round(image.width * scale));
    var scaledHeight = Math.max(1, Math.round(image.height * scale));

    detectionCanvas.width = scaledWidth;
    detectionCanvas.height = scaledHeight;
    detectionContext.drawImage(image, 0, 0, scaledWidth, scaledHeight);

    var imageData = detectionContext.getImageData(0, 0, scaledWidth, scaledHeight);
    var data = imageData.data;
    var totalPixels = scaledWidth * scaledHeight;

    var histogram = new Uint32Array(256);
    for (var i = 0, offset = 0; i < totalPixels; i++, offset += 4) {
      var r = data[offset];
      var g = data[offset + 1];
      var b = data[offset + 2];
      var brightness = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      histogram[brightness]++;
    }

    var targetCount = totalPixels * 0.12;
    var cumulative = 0;
    var brightnessThreshold = 210;
    for (var level = 255; level >= 0; level--) {
      cumulative += histogram[level];
      if (cumulative >= targetCount) {
        brightnessThreshold = Math.max(level, 200);
        break;
      }
    }

    var mask = new Uint8Array(totalPixels);
    var whitePixelCount = 0;
    for (var j = 0, ptr = 0; j < totalPixels; j++, ptr += 4) {
      var red = data[ptr];
      var green = data[ptr + 1];
      var blue = data[ptr + 2];
      var pixelBrightness = Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
      var maxChannel = Math.max(red, green, blue);
      var minChannel = Math.min(red, green, blue);
      var chroma = maxChannel - minChannel;

      if (pixelBrightness >= brightnessThreshold && chroma <= 45 && minChannel >= 70) {
        mask[j] = 1;
        whitePixelCount++;
      }
    }

    if (whitePixelCount === 0) {
      return null;
    }

    var visited = new Uint8Array(totalPixels);
    var largestRegion = {
      area: 0,
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      pixels: null,
      sumX: 0,
      sumY: 0,
      sumXX: 0,
      sumYY: 0,
      sumXY: 0
    };

    for (var start = 0; start < totalPixels; start++) {
      if (!mask[start] || visited[start]) {
        continue;
      }

      var stack = [start];
      visited[start] = 1;

      var area = 0;
      var minX = scaledWidth - 1;
      var maxX = 0;
      var minY = scaledHeight - 1;
      var maxY = 0;
      var sumX = 0;
      var sumY = 0;
      var sumXX = 0;
      var sumYY = 0;
      var sumXY = 0;
      var componentPixels = [];

      while (stack.length) {
        var index = stack.pop();
        componentPixels.push(index);

        var x = index % scaledWidth;
        var y = (index - x) / scaledWidth;

        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;

        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumYY += y * y;
        sumXY += x * y;

        if (y > 0) {
          var up = index - scaledWidth;
          if (!visited[up] && mask[up]) {
            visited[up] = 1;
            stack.push(up);
          }
        }
        if (y < scaledHeight - 1) {
          var down = index + scaledWidth;
          if (!visited[down] && mask[down]) {
            visited[down] = 1;
            stack.push(down);
          }
        }
        if (x > 0) {
          var left = index - 1;
          if (!visited[left] && mask[left]) {
            visited[left] = 1;
            stack.push(left);
          }
        }
        if (x < scaledWidth - 1) {
          var right = index + 1;
          if (!visited[right] && mask[right]) {
            visited[right] = 1;
            stack.push(right);
          }
        }
      }

      if (area > largestRegion.area) {
        largestRegion = {
          area: area,
          minX: minX,
          maxX: maxX,
          minY: minY,
          maxY: maxY,
          pixels: componentPixels,
          sumX: sumX,
          sumY: sumY,
          sumXX: sumXX,
          sumYY: sumYY,
          sumXY: sumXY
        };
      }
    }

    if (!largestRegion.area || !largestRegion.pixels) {
      return null;
    }

    var areaRatio = largestRegion.area / totalPixels;
    if (areaRatio < 0.01) {
      return null;
    }

    var meanX = largestRegion.sumX / largestRegion.area;
    var meanY = largestRegion.sumY / largestRegion.area;
    var covXX = largestRegion.sumXX / largestRegion.area - meanX * meanX;
    var covYY = largestRegion.sumYY / largestRegion.area - meanY * meanY;
    var covXY = largestRegion.sumXY / largestRegion.area - meanX * meanY;

    var angle = 0;
    if (Math.abs(covXY) > 1e-3 || Math.abs(covXX - covYY) > 1e-3) {
      angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    }

    var cosA = Math.cos(angle);
    var sinA = Math.sin(angle);

    var minProj = Infinity;
    var maxProj = -Infinity;
    var minPerp = Infinity;
    var maxPerp = -Infinity;

    var pixels = largestRegion.pixels;
    for (var p = 0; p < pixels.length; p++) {
      var idx = pixels[p];
      var px = idx % scaledWidth;
      var py = (idx - px) / scaledWidth;

      var proj = px * cosA + py * sinA;
      var perp = -px * sinA + py * cosA;

      if (proj < minProj) minProj = proj;
      if (proj > maxProj) maxProj = proj;
      if (perp < minPerp) minPerp = perp;
      if (perp > maxPerp) maxPerp = perp;
    }

    var padding = 0.04;
    var widthProj = maxProj - minProj;
    var heightPerp = maxPerp - minPerp;
    minProj -= widthProj * padding;
    maxProj += widthProj * padding;
    minPerp -= heightPerp * padding;
    maxPerp += heightPerp * padding;

    var centerProj = (minProj + maxProj) / 2;
    var centerPerp = (minPerp + maxPerp) / 2;
    var halfWidth = (maxProj - minProj) / 2;
    var halfHeight = (maxPerp - minPerp) / 2;

    var corners = [];
    var offsets = [
      { proj: -halfWidth, perp: -halfHeight },
      { proj: halfWidth, perp: -halfHeight },
      { proj: halfWidth, perp: halfHeight },
      { proj: -halfWidth, perp: halfHeight }
    ];

    var invScale = scale > 0 ? 1 / scale : 1;

    for (var c = 0; c < offsets.length; c++) {
      var projVal = centerProj + offsets[c].proj;
      var perpVal = centerPerp + offsets[c].perp;
      var cornerX = projVal * cosA - perpVal * sinA;
      var cornerY = projVal * sinA + perpVal * cosA;

      cornerX = Math.min(Math.max(cornerX, 0), scaledWidth);
      cornerY = Math.min(Math.max(cornerY, 0), scaledHeight);

      corners.push({ x: cornerX * invScale, y: cornerY * invScale });
    }

    var bboxPaddingX = Math.round((largestRegion.maxX - largestRegion.minX) * padding);
    var bboxPaddingY = Math.round((largestRegion.maxY - largestRegion.minY) * padding);
    var bboxX = Math.max(0, largestRegion.minX - bboxPaddingX);
    var bboxY = Math.max(0, largestRegion.minY - bboxPaddingY);
    var bboxWidth = Math.min(scaledWidth, largestRegion.maxX + bboxPaddingX) - bboxX;
    var bboxHeight = Math.min(scaledHeight, largestRegion.maxY + bboxPaddingY) - bboxY;

    return {
      corners: corners,
      boundingBox: {
        x: bboxX * invScale,
        y: bboxY * invScale,
        width: bboxWidth * invScale,
        height: bboxHeight * invScale
      }
    };
  }

  function drawAnalysisOverlay(image, detectedRegion) {
    if (!calibrationCanvas || !canvasContext) {
      return;
    }

    var availableWidth =
      (preview && preview.clientWidth) ||
      (previewImage && previewImage.clientWidth) ||
      image.width;
    var scale = Math.min(1, availableWidth / image.width);
    if (!isFinite(scale) || scale <= 0) {
      scale = 1;
    }

    var canvasWidth = Math.round(image.width * scale);
    var canvasHeight = Math.round(image.height * scale);

    if (!canvasWidth || !canvasHeight) {
      canvasWidth = image.width;
      canvasHeight = image.height;
    }

    calibrationCanvas.width = canvasWidth;
    calibrationCanvas.height = canvasHeight;
    lastOverlayScale = scale;
    lastOverlayCanvasWidth = canvasWidth;
    lastOverlayCanvasHeight = canvasHeight;

    canvasContext.save();
    canvasContext.clearRect(0, 0, canvasWidth, canvasHeight);
    canvasContext.drawImage(image, 0, 0, canvasWidth, canvasHeight);

    var overlayCorners = null;
    var overlayBounds = null;

    if (detectedRegion && detectedRegion.corners) {
      var orderedCorners = orderPoints(detectedRegion.corners);
      if (orderedCorners.length >= 4) {
        overlayCorners = orderedCorners.map(function (point) {
          return { x: point.x * scale, y: point.y * scale };
        });
      }

      if (detectedRegion.boundingBox) {
        overlayBounds = {
          width: detectedRegion.boundingBox.width * scale,
          height: detectedRegion.boundingBox.height * scale
        };
      }
    }

    if (!overlayCorners) {
      var paperRatio = getPaperAspectRatio();
      var fallbackWidth = canvasWidth;
      var fallbackHeight = fallbackWidth * paperRatio;

      if (fallbackHeight > canvasHeight) {
        fallbackHeight = canvasHeight;
        fallbackWidth = fallbackHeight / paperRatio;
      }

      var fallbackX = (canvasWidth - fallbackWidth) / 2;
      var fallbackY = (canvasHeight - fallbackHeight) / 2;

      overlayCorners = [
        { x: fallbackX, y: fallbackY },
        { x: fallbackX + fallbackWidth, y: fallbackY },
        { x: fallbackX + fallbackWidth, y: fallbackY + fallbackHeight },
        { x: fallbackX, y: fallbackY + fallbackHeight }
      ];

      overlayBounds = {
        width: fallbackWidth,
        height: fallbackHeight
      };
    }

    var diagLength = overlayBounds
      ? Math.max(overlayBounds.width, overlayBounds.height)
      : Math.max(canvasWidth, canvasHeight);
    var lineWidth = Math.max(3, Math.round(diagLength * 0.008));
    var baseCornerLength = Math.max(18, Math.round(diagLength * 0.12));

    canvasContext.strokeStyle = "#2fff7f";
    canvasContext.lineWidth = lineWidth;
    canvasContext.lineJoin = "round";
    canvasContext.shadowColor = "rgba(0, 255, 128, 0.35)";
    canvasContext.shadowBlur = lineWidth * 1.5;

    canvasContext.beginPath();
    canvasContext.moveTo(overlayCorners[0].x, overlayCorners[0].y);
    for (var i = 1; i < overlayCorners.length; i++) {
      canvasContext.lineTo(overlayCorners[i].x, overlayCorners[i].y);
    }
    canvasContext.closePath();
    canvasContext.stroke();

    canvasContext.shadowBlur = 0;
    canvasContext.beginPath();

    for (var cIdx = 0; cIdx < overlayCorners.length; cIdx++) {
      var current = overlayCorners[cIdx];
      var next = overlayCorners[(cIdx + 1) % overlayCorners.length];
      var previous = overlayCorners[(cIdx + overlayCorners.length - 1) % overlayCorners.length];

      var dxNext = next.x - current.x;
      var dyNext = next.y - current.y;
      var lenNext = Math.sqrt(dxNext * dxNext + dyNext * dyNext) || 1;
      dxNext /= lenNext;
      dyNext /= lenNext;

      var dxPrev = previous.x - current.x;
      var dyPrev = previous.y - current.y;
      var lenPrev = Math.sqrt(dxPrev * dxPrev + dyPrev * dyPrev) || 1;
      dxPrev /= lenPrev;
      dyPrev /= lenPrev;

      var nextCornerLength = Math.min(baseCornerLength, lenNext * 0.35);
      var prevCornerLength = Math.min(baseCornerLength, lenPrev * 0.35);

      canvasContext.moveTo(current.x, current.y);
      canvasContext.lineTo(
        current.x + dxPrev * prevCornerLength,
        current.y + dyPrev * prevCornerLength
      );

      canvasContext.moveTo(current.x, current.y);
      canvasContext.lineTo(
        current.x + dxNext * nextCornerLength,
        current.y + dyNext * nextCornerLength
      );
    }

    canvasContext.stroke();

    drawMeasurementLabels(overlayCorners, diagLength);
    canvasContext.restore();
  }

  function drawMeasurementLabels(corners, diagLength) {
    if (!corners || corners.length < 4) {
      return;
    }

    var edges = [];

    for (var i = 0; i < corners.length; i++) {
      var start = corners[i];
      var end = corners[(i + 1) % corners.length];
      var dx = end.x - start.x;
      var dy = end.y - start.y;
      var length = Math.sqrt(dx * dx + dy * dy);
      edges.push({
        start: start,
        end: end,
        dx: dx,
        dy: dy,
        length: length
      });
    }

    if (!edges.length) {
      return;
    }

    if (edges.length < 4) {
      return;
    }

    var widthAvg = (edges[0].length + edges[2].length) / 2;
    var heightAvg = (edges[1].length + edges[3].length) / 2;
    var measurements = getPaperMeasurements();
    var widthLabel = widthAvg >= heightAvg ? measurements.longLabel : measurements.shortLabel;
    var heightLabel = widthAvg >= heightAvg ? measurements.shortLabel : measurements.longLabel;
    var fontSize = Math.max(14, Math.round(diagLength * 0.04));

    canvasContext.save();
    canvasContext.font = fontSize + "px 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
    canvasContext.textAlign = "center";
    canvasContext.textBaseline = "middle";

    edges.forEach(function (edge, index) {
      var midX = (edge.start.x + edge.end.x) / 2;
      var midY = (edge.start.y + edge.end.y) / 2;
      var angle = Math.atan2(edge.dy, edge.dx);
      var label = index % 2 === 0 ? widthLabel : heightLabel;

      if (angle > Math.PI / 2 || angle < -Math.PI / 2) {
        angle += Math.PI;
      }

      canvasContext.save();
      canvasContext.translate(midX, midY);
      canvasContext.rotate(angle);
      var paddingX = fontSize * 0.6;
      var paddingY = fontSize * 0.35;
      var textMetrics = canvasContext.measureText(label);
      var textWidth = textMetrics.width;
      var boxWidth = textWidth + paddingX * 2;
      var boxHeight = fontSize + paddingY * 2;
      canvasContext.fillStyle = "rgba(0, 0, 0, 0.75)";
      canvasContext.fillRect(-boxWidth / 2, -boxHeight / 2, boxWidth, boxHeight);
      canvasContext.fillStyle = "#ffffff";
      canvasContext.strokeStyle = "rgba(0, 0, 0, 0.9)";
      canvasContext.lineWidth = Math.max(2, Math.round(fontSize * 0.15));
      canvasContext.lineJoin = "round";
      canvasContext.strokeText(label, 0, 0);
      canvasContext.fillText(label, 0, 0);
      canvasContext.restore();
    });

    canvasContext.restore();
  }

  function updateHandleVisibility() {
    if (!cornerHandles.length) {
      return false;
    }

    var ready =
      preview &&
      !preview.hidden &&
      previewStage &&
      lastDetectedRegion &&
      lastDetectedRegion.corners &&
      lastDetectedRegion.corners.length >= 4 &&
      lastAnalyzedImage &&
      lastOverlayCanvasWidth > 0 &&
      lastOverlayCanvasHeight > 0;

    for (var i = 0; i < cornerHandles.length; i++) {
      var handle = cornerHandles[i];
      if (!handle) {
        continue;
      }

      if (ready) {
        handle.classList.add("quad-handle--active");
      } else {
        handle.classList.remove("quad-handle--active");
        handle.style.left = "";
        handle.style.top = "";
      }
    }

    return ready;
  }

  function updateHandlePositions() {
    if (!cornerHandles.length) {
      return;
    }

    var ready = updateHandleVisibility();
    if (!ready) {
      return;
    }

    var stageWidth = previewStage ? previewStage.clientWidth : 0;
    var stageHeight = previewStage ? previewStage.clientHeight : 0;
    if (!stageWidth || !stageHeight) {
      return;
    }

    var displayScale = lastOverlayCanvasWidth ? stageWidth / lastOverlayCanvasWidth : 1;
    if (!isFinite(displayScale) || displayScale <= 0) {
      displayScale = 1;
    }

    var combinedScale = lastOverlayScale * displayScale;
    if (!isFinite(combinedScale) || combinedScale <= 0) {
      combinedScale = stageWidth / (lastAnalyzedImage && lastAnalyzedImage.width ? lastAnalyzedImage.width : 1);
    }

    var corners = lastDetectedRegion.corners;

    for (var index = 0; index < cornerHandles.length; index++) {
      var handle = cornerHandles[index];
      var corner = corners[index];
      if (!handle || !corner) {
        continue;
      }

      handle.style.left = corner.x * combinedScale + "px";
      handle.style.top = corner.y * combinedScale + "px";
    }
  }

  function pointerPositionToImageCoords(event) {
    if (!previewStage || !lastAnalyzedImage) {
      return null;
    }

    var rect = previewStage.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) {
      return null;
    }

    var stageX = event.clientX - rect.left;
    var stageY = event.clientY - rect.top;

    if (!isFinite(stageX) || !isFinite(stageY)) {
      return null;
    }

    stageX = Math.max(0, Math.min(rect.width, stageX));
    stageY = Math.max(0, Math.min(rect.height, stageY));

    var displayScale = lastOverlayCanvasWidth ? rect.width / lastOverlayCanvasWidth : 1;
    if (!isFinite(displayScale) || displayScale <= 0) {
      displayScale = 1;
    }

    var combinedScale = lastOverlayScale * displayScale;
    if (!isFinite(combinedScale) || combinedScale <= 0) {
      combinedScale = rect.width / (lastAnalyzedImage.width || 1);
    }

    var imageX = stageX / combinedScale;
    var imageY = stageY / combinedScale;

    imageX = Math.max(0, Math.min(lastAnalyzedImage.width, imageX));
    imageY = Math.max(0, Math.min(lastAnalyzedImage.height, imageY));

    return { x: imageX, y: imageY };
  }

  function computeCornerBoundingBox(corners) {
    if (!corners || corners.length < 4) {
      return null;
    }

    var minX = corners[0].x;
    var minY = corners[0].y;
    var maxX = corners[0].x;
    var maxY = corners[0].y;

    for (var i = 1; i < corners.length; i++) {
      var point = corners[i];
      if (!point) {
        continue;
      }

      if (point.x < minX) {
        minX = point.x;
      }
      if (point.y < minY) {
        minY = point.y;
      }
      if (point.x > maxX) {
        maxX = point.x;
      }
      if (point.y > maxY) {
        maxY = point.y;
      }
    }

    return {
      x: minX,
      y: minY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY)
    };
  }

  function refreshCalibrationAfterHandleChange() {
    if (!lastAnalyzedImage || !lastDetectedRegion) {
      calibrationState = null;
    } else {
      calibrationState = computeCalibration(
        lastDetectedRegion,
        lastAnalyzedImage.width,
        lastAnalyzedImage.height
      );
    }

    if (typeof window !== "undefined") {
      window.gridFiniumCalibration = calibrationState || null;
    }

    updateCalibrationMetrics(calibrationState);
    updateExportButtonState();
  }

  function updatePreviewFromCanvas() {
    if (!calibrationCanvas || !previewImage) {
      return;
    }

    var dataUrl = "";
    try {
      dataUrl = calibrationCanvas.toDataURL("image/png");
    } catch (error) {
      dataUrl = "";
    }

    if (!dataUrl) {
      return;
    }

    lastPreviewDataUrl = dataUrl;
    previewImage.src = dataUrl;
    preview.hidden = false;
  }

  function renderOverlay(image, detectedRegion) {
    if (!image) {
      return;
    }

    pendingOverlayRender = false;
    drawAnalysisOverlay(image, detectedRegion);
    updatePreviewFromCanvas();
    updateHandlePositions();
  }

  function requestOverlayRender() {
    if (!lastAnalyzedImage) {
      return;
    }

    if (typeof window === "undefined") {
      renderOverlay(lastAnalyzedImage, lastDetectedRegion);
      return;
    }

    if (pendingOverlayRender) {
      return;
    }

    pendingOverlayRender = true;

    window.requestAnimationFrame(function () {
      pendingOverlayRender = false;
      renderOverlay(lastAnalyzedImage, lastDetectedRegion);
    });
  }

  function applyCornerUpdateFromEvent(index, event) {
    if (!lastDetectedRegion || !lastDetectedRegion.corners || lastDetectedRegion.corners.length <= index) {
      return;
    }

    var point = pointerPositionToImageCoords(event);
    if (!point) {
      return;
    }

    var corners = lastDetectedRegion.corners;
    var current = corners[index] || { x: point.x, y: point.y };
    current.x = point.x;
    current.y = point.y;
    corners[index] = current;
    lastDetectedRegion.boundingBox = computeCornerBoundingBox(corners);

    refreshCalibrationAfterHandleChange();
    updateHandlePositions();
    requestOverlayRender();
  }

  function onHandlePointerDown(event) {
    if (!event || !event.currentTarget) {
      return;
    }

    var handle = event.currentTarget;
    var index = Number(handle.dataset.index || handle.getAttribute("data-index"));

    if (!isFinite(index) || index < 0) {
      return;
    }

    if (!lastDetectedRegion || !lastDetectedRegion.corners || lastDetectedRegion.corners.length <= index) {
      return;
    }

    event.preventDefault();

    if (typeof handle.focus === "function") {
      handle.focus();
    }

    if (typeof handle.setPointerCapture === "function") {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignore pointer capture errors.
      }
    }

    handle.classList.add("quad-handle--dragging");

    activeHandle = {
      index: index,
      pointerId: event.pointerId,
      element: handle
    };

    applyCornerUpdateFromEvent(index, event);
  }

  function onHandlePointerMove(event) {
    if (!activeHandle || activeHandle.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    applyCornerUpdateFromEvent(activeHandle.index, event);
  }

  function onHandlePointerUp(event) {
    if (!activeHandle || activeHandle.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();

    if (activeHandle.element && typeof activeHandle.element.releasePointerCapture === "function") {
      try {
        activeHandle.element.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Ignore pointer capture errors.
      }
    }

    if (activeHandle.element) {
      activeHandle.element.classList.remove("quad-handle--dragging");
    }

    activeHandle = null;
  }

  function computeCalibration(detectedRegion, imageWidth, imageHeight) {
    if (!detectedRegion || !detectedRegion.corners || detectedRegion.corners.length < 4) {
      return null;
    }

    var corners = orderPoints(detectedRegion.corners);
    if (!corners || corners.length < 4) {
      return null;
    }

    var edges = [];

    for (var edgeIndex = 0; edgeIndex < corners.length; edgeIndex++) {
      var startCorner = corners[edgeIndex];
      var endCorner = corners[(edgeIndex + 1) % corners.length];
      var edgeDx = endCorner.x - startCorner.x;
      var edgeDy = endCorner.y - startCorner.y;
      var edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);

      edges.push(edgeLength);
    }

    if (edges.length < 4) {
      return null;
    }

    var widthPixels = (edges[0] + edges[2]) / 2;
    var heightPixels = (edges[1] + edges[3]) / 2;

    if (!isFinite(widthPixels) || !isFinite(heightPixels) || widthPixels <= 0 || heightPixels <= 0) {
      return null;
    }

    var ratio = widthPixels > heightPixels ? widthPixels / heightPixels : heightPixels / widthPixels;
    var targetRatio = getPaperAspectRatio();
    if (!isFinite(ratio) || Math.abs(ratio - targetRatio) > 0.25) {
      return null;
    }

    var centroidX = 0;
    var centroidY = 0;
    for (var i = 0; i < corners.length; i++) {
      centroidX += corners[i].x;
      centroidY += corners[i].y;
    }
    centroidX /= corners.length;
    centroidY /= corners.length;

    if (imageWidth && imageHeight) {
      var centerX = imageWidth / 2;
      var centerY = imageHeight / 2;
      var toleranceX = imageWidth * 0.35;
      var toleranceY = imageHeight * 0.35;
      if (Math.abs(centroidX - centerX) > toleranceX || Math.abs(centroidY - centerY) > toleranceY) {
        return null;
      }
    }

    var physical = getPaperPhysicalDimensions();
    var longSide = physical.long;
    var shortSide = physical.short;

    var landscape = widthPixels >= heightPixels;
    var widthPhysical = landscape ? longSide : shortSide;
    var heightPhysical = landscape ? shortSide : longSide;

    var mmPerPixelX = widthPhysical / widthPixels;
    var mmPerPixelY = heightPhysical / heightPixels;
    var mmPerPixel = (mmPerPixelX + mmPerPixelY) / 2;
    var pxPerMm = mmPerPixel > 0 ? 1 / mmPerPixel : null;

    if (!isFinite(mmPerPixel) || mmPerPixel <= 0) {
      return null;
    }

    var coverage = null;
    if (detectedRegion.boundingBox && imageWidth && imageHeight) {
      var bboxArea = detectedRegion.boundingBox.width * detectedRegion.boundingBox.height;
      var imageArea = imageWidth * imageHeight;

      if (isFinite(bboxArea) && isFinite(imageArea) && bboxArea > 0 && imageArea > 0) {
        coverage = Math.max(0, Math.min(100, (bboxArea / imageArea) * 100));
      }
    }

    return {
      mmPerPixel: mmPerPixel,
      mmPerPixelX: mmPerPixelX,
      mmPerPixelY: mmPerPixelY,
      pxPerMm: pxPerMm,
      widthPixels: widthPixels,
      heightPixels: heightPixels,
      orientation: landscape ? "landscape" : "portrait",
      coverage: coverage,
      unit: physical.unit,
      corners: corners,
      boundingBox: detectedRegion.boundingBox || null,
      imageWidth: imageWidth,
      imageHeight: imageHeight
    };
  }

  function updateCornerCoordinatesDisplay(corners) {
    if (!metricCornerLabels) {
      return;
    }

    for (var index = 0; index < handleCornerKeys.length; index++) {
      var key = handleCornerKeys[index];
      var labelElement = metricCornerLabels[key];
      if (!labelElement) {
        continue;
      }

      var prefix = key.toUpperCase();
      var corner = corners && corners[index];
      if (
        corner &&
        typeof corner.x === "number" &&
        isFinite(corner.x) &&
        typeof corner.y === "number" &&
        isFinite(corner.y)
      ) {
        labelElement.textContent =
          prefix + ": (" + corner.x.toFixed(1) + ", " + corner.y.toFixed(1) + ")";
      } else {
        labelElement.textContent = prefix + ": --";
      }
    }
  }

  function updateCalibrationMetrics(calibration) {
    if (metricCornerLabels) {
      var cornersToDisplay = null;

      if (calibration && calibration.corners && calibration.corners.length >= 4) {
        cornersToDisplay = calibration.corners;
      } else if (
        lastDetectedRegion &&
        lastDetectedRegion.corners &&
        lastDetectedRegion.corners.length >= 4
      ) {
        cornersToDisplay = orderPoints(lastDetectedRegion.corners);
      }

      updateCornerCoordinatesDisplay(cornersToDisplay);
    }

    if (metricScale) {
      if (calibration && calibration.mmPerPixel) {
        var pixelsPerMm = 1 / calibration.mmPerPixel;
        if (isFinite(pixelsPerMm) && pixelsPerMm > 0) {
          metricScale.textContent = pixelsPerMm.toFixed(2) + " px/mm";
        } else {
          metricScale.textContent = "--";
        }
      } else {
        metricScale.textContent = "--";
      }
    }

    if (metricCoverage) {
      if (calibration && calibration.coverage !== null && calibration.coverage !== undefined) {
        metricCoverage.textContent = calibration.coverage.toFixed(1) + "%";
      } else {
        metricCoverage.textContent = "--";
      }
    }

    var warpCorners = null;
    if (calibration && calibration.corners && calibration.corners.length >= 4) {
      warpCorners = calibration.corners;
    } else if (
      lastDetectedRegion &&
      lastDetectedRegion.corners &&
      lastDetectedRegion.corners.length >= 4
    ) {
      warpCorners = orderPoints(lastDetectedRegion.corners);
    }

    var warpPaperSpec = warpCorners
      ? buildPaperSpecForWarp(warpCorners, calibration)
      : null;

    var warpPixelsPerMM =
      calibration &&
      typeof calibration.pxPerMm === "number" &&
      isFinite(calibration.pxPerMm) &&
      calibration.pxPerMm > 0
        ? calibration.pxPerMm
        : null;

    if (warpCorners && warpCorners.length >= 4 && lastAnalyzedImage) {
      scheduleHomographyComputation(
        warpCorners,
        warpPaperSpec,
        warpPixelsPerMM,
        lastAnalyzedImage
      );
    } else if (!warpState) {
      resetWarpState();
    }
  }

  function updateExportButtonState() {
    if (!exportButton) {
      return;
    }

    var ready = Boolean(
      calibrationState &&
      calibrationState.corners &&
      calibrationState.corners.length >= 4 &&
      typeof calibrationState.pxPerMm === "number" &&
      isFinite(calibrationState.pxPerMm) &&
      lastDetectedRegion &&
      lastDetectedRegion.corners &&
      lastDetectedRegion.corners.length >= 4
    );

    exportButton.disabled = !ready;
  }

  function runAnalysis() {
    if (!currentImageDataUrl) {
      return;
    }

    var image = new Image();
    image.onload = function () {
      lastAnalyzedImage = image;
      pendingOverlayRender = false;

      var detectedRegion = detectPaperBounds(image);
      if (detectedRegion && detectedRegion.corners) {
        detectedRegion.corners = orderPoints(detectedRegion.corners);
      }
      lastDetectedRegion = detectedRegion;
      updateHandlePositions();

      calibrationState = computeCalibration(detectedRegion, image.width, image.height);
      updateExportButtonState();

      if (typeof window !== "undefined") {
        window.gridFiniumCalibration = calibrationState;
      }

      window.requestAnimationFrame(function () {
        renderOverlay(image, detectedRegion);

        updateCalibrationMetrics(calibrationState);
      });
    };
    image.src = currentImageDataUrl;
  }

  function buildExportPayload() {
    if (!calibrationState || !lastDetectedRegion || !lastDetectedRegion.corners) {
      return null;
    }

    if (typeof calibrationState.pxPerMm !== "number" || !isFinite(calibrationState.pxPerMm)) {
      return null;
    }

    var orderedCorners = orderPoints(lastDetectedRegion.corners);
    if (!orderedCorners || orderedCorners.length < 4) {
      return null;
    }

    return {
      paper: {
        size: paperSizeSelect ? paperSizeSelect.value : "letter",
        pxPerMM: calibrationState.pxPerMm,
        coverage: calibrationState.coverage
      },
      quad: {
        tl: orderedCorners[0],
        tr: orderedCorners[1],
        br: orderedCorners[2],
        bl: orderedCorners[3]
      },
      image: {
        width: calibrationState.imageWidth,
        height: calibrationState.imageHeight
      }
    };
  }

  function downloadJSON(obj, filename) {
    if (!obj) {
      return;
    }

    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
  }

  if (exportButton) {
    exportButton.addEventListener("click", function () {
      var payload = buildExportPayload();
      if (!payload) {
        if (typeof window !== "undefined" && window.alert) {
          window.alert("Run Gridify first.");
        } else {
          console.warn("Run Gridify first.");
        }
        return;
      }

      downloadJSON(payload, "gridfinium_export.json");

      // Placeholder for future backend integration:
      // fetch("/api/export", {
      //   method: "POST",
      //   headers: { "Content-Type": "application/json" },
      //   body: JSON.stringify(payload)
      // });
    });
  }

  dropzone.addEventListener("dragover", function (event) {
    event.preventDefault();
    dropzone.classList.add("active");
  });

  dropzone.addEventListener("dragleave", function () {
    dropzone.classList.remove("active");
  });

  dropzone.addEventListener("drop", function (event) {
    event.preventDefault();
    dropzone.classList.remove("active");
    var file = event.dataTransfer.files && event.dataTransfer.files[0];
    handleFile(file);
  });

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    handleFile(file);
  });

  clearButton.addEventListener("click", resetPreview);
  analyzeButton.addEventListener("click", runAnalysis);

  if (paperSizeSelect) {
    paperSizeSelect.addEventListener("change", function () {
      if (!currentImageDataUrl) {
        return;
      }

      var image = new Image();
      image.onload = function () {
        window.requestAnimationFrame(function () {
          renderOverlay(image, lastDetectedRegion);

          calibrationState = computeCalibration(lastDetectedRegion, image.width, image.height);
          updateExportButtonState();

          if (typeof window !== "undefined") {
            window.gridFiniumCalibration = calibrationState;
          }

          updateCalibrationMetrics(calibrationState);
        });
      };
      image.src = currentImageDataUrl;
    });
  }

  updateExportButtonState();
})();















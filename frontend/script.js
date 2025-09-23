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
  var calibrationCanvas = document.createElement("canvas");
  var canvasContext = calibrationCanvas.getContext("2d");
  var currentImageDataUrl = "";
  var cornerHandles = [];
  var handleCornerKeys = ["tl", "tr", "br", "bl"];
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
  var themeToggle = document.getElementById("theme-toggle");
  var themeLabel = document.getElementById("theme-toggle-label");
  var deploymentInfo = document.getElementById("deployment-info");
  var deploymentTimestamp = document.getElementById("deployment-timestamp");
  var themeStorageKey = "gridfinium-theme";
  var themeMediaQuery =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;

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

  function orderPoints(corners) {
    if (!corners || corners.length < 4) {
      return corners ? corners.slice() : [];
    }

    var indexTl = 0;
    var indexTr = 0;
    var indexBr = 0;
    var indexBl = 0;
    var minSum = Infinity;
    var maxSum = -Infinity;
    var minDiff = Infinity;
    var maxDiff = -Infinity;

    for (var i = 0; i < corners.length; i++) {
      var point = corners[i];
      var sum = point.x + point.y;
      var diff = point.x - point.y;

      if (sum < minSum) {
        minSum = sum;
        indexTl = i;
      }
      if (sum > maxSum) {
        maxSum = sum;
        indexBr = i;
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        indexTr = i;
      }
      if (diff < minDiff) {
        minDiff = diff;
        indexBl = i;
      }
    }

    return [
      { x: corners[indexTl].x, y: corners[indexTl].y },
      { x: corners[indexTr].x, y: corners[indexTr].y },
      { x: corners[indexBr].x, y: corners[indexBr].y },
      { x: corners[indexBl].x, y: corners[indexBl].y }
    ];
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

  function updateCalibrationMetrics(calibration) {
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















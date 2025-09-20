(function () {
  var dropzone = document.getElementById("upload-dropzone");
  var fileInput = document.getElementById("file-input");
  var preview = document.getElementById("preview");
  var previewImage = document.getElementById("preview-image");
  var clearButton = document.getElementById("clear-button");
  var analyzeButton = document.getElementById("analyze-button");
  var calibrationPreview = document.getElementById("calibration-preview");
  var calibrationCanvas = document.getElementById("calibration-canvas");
  var paperSizeSelect = document.getElementById("paper-size");
  var canvasContext = calibrationCanvas ? calibrationCanvas.getContext("2d") : null;
  var currentImageDataUrl = "";
  var detectionCanvas = document.createElement("canvas");
  var detectionContext =
    detectionCanvas.getContext("2d", { willReadFrequently: true }) ||
    detectionCanvas.getContext("2d");
  var lastDetectedRegion = null;

  if (fileInput && typeof navigator !== "undefined") {
    var isIOS = /iP(ad|hone|od)/.test(navigator.platform || "") ||
      (navigator.userAgent && navigator.userAgent.includes("Mac") &&
        "ontouchend" in document);

    if (isIOS) {
      fileInput.removeAttribute("capture");
    }
  }

  function resetAnalysis() {
    if (!calibrationPreview || !calibrationCanvas || !canvasContext) {
      return;
    }

    lastDetectedRegion = null;
    calibrationPreview.hidden = true;
    calibrationCanvas.width = 0;
    calibrationCanvas.height = 0;
    canvasContext.clearRect(0, 0, calibrationCanvas.width, calibrationCanvas.height);
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
      preview.hidden = false;
      analyzeButton.disabled = false;
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
    if (!calibrationPreview || !calibrationCanvas || !canvasContext) {
      return;
    }

    var availableWidth = calibrationPreview.clientWidth || image.width;
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

    canvasContext.save();
    canvasContext.clearRect(0, 0, canvasWidth, canvasHeight);
    canvasContext.drawImage(image, 0, 0, canvasWidth, canvasHeight);

    var overlayCorners = null;
    var overlayBounds = null;

    if (detectedRegion && detectedRegion.corners) {
      overlayCorners = detectedRegion.corners.map(function (point) {
        return { x: point.x * scale, y: point.y * scale };
      });

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
    var cornerLength = Math.max(18, Math.round(diagLength * 0.12));

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

      canvasContext.moveTo(current.x, current.y);
      canvasContext.lineTo(
        current.x + dxPrev * cornerLength,
        current.y + dyPrev * cornerLength
      );

      canvasContext.moveTo(current.x, current.y);
      canvasContext.lineTo(
        current.x + dxNext * cornerLength,
        current.y + dyNext * cornerLength
      );
    }

    canvasContext.stroke();
    canvasContext.restore();
  }

  function runAnalysis() {
    if (!currentImageDataUrl) {
      return;
    }

    var image = new Image();
    image.onload = function () {
      var detectedRegion = detectPaperBounds(image);
      lastDetectedRegion = detectedRegion;

      if (calibrationPreview) {
        calibrationPreview.hidden = false;
      }

      window.requestAnimationFrame(function () {
        drawAnalysisOverlay(image, detectedRegion);
      });
    };
    image.src = currentImageDataUrl;
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
      if (!calibrationPreview || calibrationPreview.hidden) {
        return;
      }

      if (!currentImageDataUrl) {
        return;
      }

      if (lastDetectedRegion) {
        var image = new Image();
        image.onload = function () {
          window.requestAnimationFrame(function () {
            drawAnalysisOverlay(image, lastDetectedRegion);
          });
        };
        image.src = currentImageDataUrl;
      } else {
        runAnalysis();
      }
    });
  }
})();

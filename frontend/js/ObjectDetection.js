/**
 * ObjectDetection.js
 *
 * Detects the main object placed on a piece of letter paper.
 *
 * Strategy:
 *  1. Build a mask from the paper contour and erode it inward to avoid
 *     picking up the paper's own border as an edge.
 *  2. Run Canny edge detection only inside the masked region.
 *  3. Dilate edges to close small gaps.
 *  4. Find the largest external contour that is neither too tiny nor
 *     suspiciously close in size to the whole paper.
 *  5. Simplify with approxPolyDP at a loose epsilon so the returned
 *     polygon is smooth and printable-friendly.
 */

/**
 * @param {cv.Mat} src           - RGBA source image (from cv.imread)
 * @param {cv.Mat} paperContour  - 4-corner paper polygon from detectPaperContour
 * @returns {cv.Mat|null}        - Caller must .delete() the returned Mat
 */
export function detectObjectContour(src, paperContour) {
  if (!paperContour) return null;

  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  // Mat.zeros must be assigned after declaration because it returns a new Mat
  const mask = cv.Mat.zeros(src.rows, src.cols, cv.CV_8U);

  try {
    // 1. Fill the paper polygon into the mask
    const pv = new cv.MatVector();
    pv.push_back(paperContour);
    cv.fillPoly(mask, pv, new cv.Scalar(255));
    pv.delete();

    // 2. Erode inward to avoid the paper border triggering as an edge
    const erodeKernel = cv.Mat.ones(15, 15, cv.CV_8U);
    cv.erode(mask, mask, erodeKernel);
    erodeKernel.delete();

    // 3. Grayscale and blur the full image (no masking yet)
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(7, 7), 0);

    // 4. Edge detection on the full image — masking BEFORE Canny would create
    //    a hard pixel transition at the mask boundary, which Canny detects as
    //    the outermost contour. With RETR_EXTERNAL that swallows all inner
    //    object contours, so nothing is ever returned.
    cv.Canny(blurred, edges, 20, 60);

    // 5. Zero out edges outside the eroded paper region
    cv.bitwise_and(edges, mask, edges);

    // 6. Dilate to close small gaps in the object outline
    const dilateKernel = cv.Mat.ones(7, 7, cv.CV_8U);
    cv.dilate(edges, edges, dilateKernel);
    dilateKernel.delete();

    // 7. Find external contours only
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const paperArea = cv.contourArea(paperContour);
    // Ignore anything smaller than 0.3% of the image (noise specks)
    const minArea = src.rows * src.cols * 0.003;

    let bestContour = null;
    let bestArea = 0;

    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);

      // Skip too small or suspiciously close to full-paper size (the paper border)
      if (area < minArea || area > paperArea * 0.85) {
        c.delete();
        continue;
      }

      if (area > bestArea) {
        if (bestContour) bestContour.delete();
        bestContour = c.clone();
        bestArea = area;
      }
      c.delete();
    }

    if (!bestContour) return null;

    // 8. Simplify to a loose polygon: 2.5% of perimeter as epsilon
    //    Higher epsilon = fewer points = smoother, more printable shape
    const simplified = new cv.Mat();
    const perimeter = cv.arcLength(bestContour, true);
    cv.approxPolyDP(bestContour, simplified, 0.025 * perimeter, true);
    bestContour.delete();

    return simplified;
  } finally {
    gray.delete();
    blurred.delete();
    edges.delete();
    contours.delete();
    hierarchy.delete();
    mask.delete();
  }
}

/**
 * Converts a cv.Mat contour to an array of {x, y} points.
 * @param {cv.Mat} contour
 * @returns {{ x: number, y: number }[]}
 */
export function extractPoints(contour) {
  const data = contour.data32S;
  const pts = [];
  for (let i = 0; i < data.length; i += 2) {
    pts.push({ x: data[i], y: data[i + 1] });
  }
  return pts;
}

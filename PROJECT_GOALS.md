# Gridfinium — Project Goals

**Goal**
Make it fast and easy to create true-scale outlines of real objects (placed on standard paper) and export vector files suitable for Gridfinity-compatible inserts and trays.

**Reference**

* Gridfinity standard: https://gridfinity.xyz/
* Current site: https://gridfinium.com/

---

## Product Vision

A browser-only tool where a user shoots/loads a photo of an object on Letter/A4 paper, confirms the paper corners, taps a few dots on the object, previews the mask, and exports a **true-scale SVG** (and later DXF/STL). No account or upload required for the MVP; everything runs locally for speed, privacy, and simplicity.

---

## Scope (MVP v0)

**In scope**

* Paper selection & scaling via known paper size
* Interactive, user-guided segmentation (“dots on the tool”)
* Vectorization to clean paths with holes preserved
* **True-scale SVG export** (millimeters)
* Optional Gridfinity snapping guidance (dimensions only, not full 3D)

**Out of scope (for v0)**

* Server processing, queues, or user accounts
* DXF/STL export reliability guarantees (may be experimental)
* Automatic multi-object detection without user hints

---

## User Flow (v0)

1. **Load image** → fix EXIF orientation → show on canvas.
2. **Select Paper** (Letter/A4/Custom); auto-guess corners; user drags 4 handles if needed.
3. **Compute Homography & Scale** (mm/px) → show rectified preview overlay.
4. **Add Tool/Object** → user seeds 3–6 foreground dots (optional background dots/box).
5. **Preview Mask** (fast) → user adds/removes dots until it looks right.
6. **Vectorize** → contour → simplify → (optional) offset → mm coordinates.
7. **Export** → download **SVG** (true scale, metadata embedded).

---

## Technical Plan (Client-Only)

### Core modules

* **Paper Quad**: detect largest quad (Canny → contours), then user-adjustable handles.
* **Homography**: 4-point DLT mapping image→paper plane; derive `scale_mm_per_px`.
* **Segmentation (seeded)**: GrabCut/GraphCut or region-growing driven by user seeds; morphological cleanup.
* **Vectorization**: contours → Ramer–Douglas–Peucker simplify → ring/holes hierarchy; optional kerf offsets (Clipper).
* **SVG Export**: `<svg width="Wmm" height="Hmm" viewBox="0 0 W H">` + `<path>` with `fill-rule="evenodd"`.

### Browser tech

* WebAssembly + Web Workers (`opencv.js`, `clipper`/wasm, simple path ops)
* Canvas / OffscreenCanvas for previews
* React/Next.js UI; lightweight state (e.g., Zustand)
* No network calls unless user chooses to save/share

### Suggested function interfaces (pseudo)

```ts
type Point = { x:number, y:number }; // pixels
type Quad  = { tl:Point, tr:Point, br:Point, bl:Point };

detectPaperQuad(imageBitmap): Quad | null
refineQuadWithUserDrag(initial: Quad, userQuad: Quad): Quad

computeHomography(src: Quad, dstSizeMM:{w:number,h:number}): { H:number[][], mmPerPx:number }

segmentWithSeeds(imageBitmap, roi?:DOMRect, seeds:{fg:Point[], bg:Point[]}): ImageData /*mask*/
cleanMask(mask:ImageData): ImageData

maskToContours(mask:ImageData): Array<Array<Point>>
simplifyPath(path:Array<Point>, tolMM:number, mmPerPx:number): Array<Point>
offsetPaths(paths:Array<Array<Point>>, offsetMM:number): Array<Array<Point>>

pathsToSVG(pathsMM:Array<Array<Point>>, sizeMM:{w:number,h:number}, meta:Record<string,string>): string
```

---

## Milestones

**v0.1 — Paper & Scale**

* Load image + EXIF fix
* Auto quad + draggable corners
* Homography + mm/px scale
* Rectified overlay preview

**v0.2 — Segmentation Loop**

* Seed-based segmentation + fast preview overlay
* Mask cleanup (open/close, hole fill)
* UX polish: zoom/pan, undo last dot

**v0.3 — Vectorization & Export**

* Contours → simplify → holes preserved
* Optional kerf offset (+/- mm)
* **SVG export (true scale)**
* Session metadata saved to browser (IndexedDB)

**v0.4 — Gridfinity Helpers (2D)**

* Show object W×H in mm and closest Gridfinity footprint (e.g., 2×4 base)
* Optional snap-to footprint outline in preview (2D only)

**v0.5 — Experimental**

* DXF export (client-side; best effort)
* Advanced seed modes: background scribble, ROI box
* “Detail mode” for thin features

---

## Future Path (when needed)

* **Tiny server add-on** for robust DXF/STL export only (no image upload)
* **One-endpoint job** for heavy images (optional)
* Full 3D Gridfinity insert generation (parametric extrude + magnets) after SVG is stable

---

## Risks & Downsides (Client-Only)

* **Performance ceilings:** large photos (12–48MP) are slow; mitigate with downscaled previews + high-res ROI only for final vectorization.
* **Bundle size:** `opencv.js`/WASM can be several MB; use lazy load + Workers.
* **Battery/thermals:** long runs on mobile heat devices; provide progress + cancel.
* **Segmentation edge cases:** low contrast, glare, shadows, translucent tools; rely on more seeds/ROI and offer a “detail” mode.
* **Precision on touch devices:** require zoom/pan and fat hit-targets for dots.
* **DXF reliability:** browser DXF libraries vary; treat as beta until server helper exists.
* **No persistence by default:** add IndexedDB for local session saves (no cloud).
* **CORS/tainted canvas:** only process local files or same-origin resources.

---

## Success Metrics (MVP)

* Time-to-first-SVG ≤ **90s** for a single tool on mid-range laptop
* **≥90%** of trial images produce acceptable outlines with ≤ 8 user dots
* SVG path node count reduced by **≥60%** vs raw contours (after simplify)
* Exported dimensions within **±1.0 mm** of ground-truth for standard photos

---

## Open Questions

* Minimum viable **DXF** quality threshold for v0 vs. defer to server?
* Do we need **kerf/clearance presets** per printer/material in v0?
* Should we include **camera capture** in-app, or require file upload only?

---

## Next Actions

1. Scaffold Next.js page with canvas + image loader + EXIF fix.
2. Implement quad detect + draggable handles; compute homography & scale.
3. Add seeded segmentation worker; overlay mask preview; iterative dots UX.
4. Implement contour → simplify → offset → SVG export (millimeters).
5. Add Gridfinity footprint helper and basic kerf offset options.
6. Ship public MVP; gather images that fail and tune “detail mode.”

---

**Non-Goals (for now)**

* Multi-tenant cloud accounts, payments, or long-term storage
* Full automated detection of multiple tools without user hints
* Cloud-based heavy processing

---

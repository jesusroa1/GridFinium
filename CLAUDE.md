# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step, no npm, no dependencies to install. Serve the repo root as a static site:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

Any static file server works. OpenCV.js and Three.js are loaded from CDN at runtime.

## Testing

There is no automated CI yet. Testing happens two ways:

**In-browser Tests tab** — open the app, click the Tests tab, hit Run All. The tab reports PASS/FAIL/SKIPPED per stage. To drive it headlessly, append `?runTests=1` to the URL; the runner sets `window.__GRIDFINIUM_TEST_RESULTS__` and toggles `document.documentElement.dataset.testsDone` when complete.

**Browser console API** — for regression-testing hint tuning parameters without touching source:

```js
window.GridFinium.hintTuning.getConfig();           // inspect live config
window.GridFinium.hintTuning.apply({ enableAutoCanny: false }); // override and rerun
window.GridFinium.hintTuning.reset();               // restore defaults
```

## Architecture

The entire app is a single-page static frontend with no framework and no build step. Entry point is `index.html` → `frontend/js/MainScript.js` (loaded as an ES module).

### Module responsibilities

| Module | Role |
|--------|------|
| `MainScript.js` | Boot, event wiring, UI state, orchestrates the pipeline |
| `PaperOutlining.js` | Detects the letter-paper contour (grayscale → blur → Canny → largest 4-sided contour) |
| `ObjectDetection.js` | Detects the object on the paper (masks paper region, runs Canny inside mask, finds largest external contour) |
| `ObjectOutlining.js` | Renders visual overlays on the canvas |
| `STLLogic.js` | Exports the detected outline as a 3D STL using Three.js (loaded lazily from CDN) |
| `TestRunner.js` | In-app test framework with per-stage timeouts and autorun support |

### Image processing pipeline

```
processUrl(src)
  → loadImage → downscale to MAX_DIMENSION (1280px) if needed
  → cv.imread (RGBA Mat)
  → detectPaperContour → largest 4-sided contour
  → detectObjectContour → largest contour inside paper mask
  → render overlays on canvas
```

All OpenCV Mats must be `.delete()`d after use — callers own returned Mats.

### Key design constraints

- **Browser-only**: no backend, no server-side compute. Everything runs in the user's browser via WebAssembly (OpenCV.js) and JS.
- **Images are downscaled to 1280px** before canvas rendering (not before detection) to avoid Safari memory crashes on zoom.
- **SVG/STL scale factor**: paper pixel perimeter → real perimeter (8.5"×11" = 990.6 mm) gives ~0.102 mm/px conversion for physical export accuracy.

### Hint-based selection

Clicking the canvas triggers a secondary mini-pipeline in `MainScript.js` (`findContourAtPoint`): tuned Canny thresholds (10/50), 5×5 morphology kernel, then picks the **smallest contour that contains the click point** while excluding contours that are close in size to the full paper (±10% tolerance). Tunable via the Tuning Parameters panel in the UI.

## Deployment

Vercel is connected via the GitHub App and deploys automatically:
- **Production**: on every push/merge to `main`
- **Preview**: on every pull request (Vercel posts a preview URL as a PR check)

To publish a change: merge to `main`. No build command or output directory needs configuring — Vercel serves the repo root as static files.

## Code conventions

- **Readable over clever** — add comments only for non-obvious logic (algorithm quirks, magic numbers).
- **No breadcrumbs** — when deleting or moving code, remove it cleanly. No `// moved to X` or `// removed` comments.
- Ask before making architectural changes; keep PRs small and focused on one phase item.

## Roadmap context

`frontend/PROJECT_PLAN.md` has the active phased roadmap (Phases 0–5). The current state is roughly between Phase 1 and 2: the Tests tab exists but golden dataset scaffolding (Phase 2) and the MainScript refactor (Phase 3) are not yet done. Phase 4 (GitHub Actions CI via Playwright) does not exist yet.

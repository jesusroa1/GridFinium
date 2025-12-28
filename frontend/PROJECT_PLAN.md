# GridFinium Frontend Project Plan (Test-First Roadmap)

This plan describes the current frontend architecture and a phased, test-first roadmap for improving reliability and developer velocity. It is written to support small, focused Codex PRs.

## Current Architecture Snapshot
- **Single-page static frontend**: `index.html` with ES modules (no framework, no build step).
- **Entrypoint**: `frontend/js/MainScript.js`.
- **Core modules**:
  - `frontend/js/PaperOutlining.js`
  - `frontend/js/ObjectOutlining.js`
  - `frontend/js/STLLogic.js`
- **Docs sync note**: `frontend/readme.md` and `frontend/docs.md` previously referenced `scripts.js` and should reference the current ES module entrypoint instead.

## Goals
- **Browser-only**: no backend services, no server-side compute, everything runs in the browser.
- **Testable, sustainable enhancements**: every improvement is accompanied by Codex PRs with measurable outcomes.
- **Regression protection**: an in-UI **Tests** tab + CI to ensure pipeline regressions are caught early.

## Phased Roadmap
Each phase is intended to be a small, reviewable PR with clear acceptance criteria.

### Phase 0: Stabilize the pipeline result contract
**Deliverables**
- Define and document a single output object shape for the pipeline results.
- Add schema checks (runtime validation + clear error logging) before rendering results.

**Acceptance criteria**
- A documented result object shape exists (including required/optional fields).
- Pipeline execution emits a clear error for invalid output shape.
- UI shows a readable error when schema validation fails.

### Phase 1: Add a “Tests” tab to the UI
**Deliverables**
- Add a Tests tab with **Run All** / **Run Selected** controls.
- Per-sample stage PASS/FAIL status.
- Per-sample metrics summary.
- Debug previews per stage (where relevant).

**Acceptance criteria**
- Tests tab renders in the UI without breaking existing workflows.
- User can run all tests or a selected subset from the tab.
- PASS/FAIL status and metrics render per sample and per stage.

### Phase 2: Add golden dataset scaffolding
**Deliverables**
- Add 5–8 golden samples (S1–S8) in a stable location.
- Create per-sample golden JSON expectations.
- Implement tolerance-based assertions per sample.

**Acceptance criteria**
- Golden dataset is versioned with the repo.
- Each sample has a corresponding expectations JSON file.
- Tests use tolerance-based assertions instead of pixel-perfect matching.

### Phase 3: Refactor MainScript into UI + pipeline layers (no framework)
**Deliverables**
- Split `MainScript.js` into:
  - UI adapter (DOM wiring, event handling)
  - Pipeline orchestrator (processing steps + result contract)
  - Renderers (per-stage rendering helpers)

**Acceptance criteria**
- Functionality unchanged for end users.
- Clear separation of responsibilities with ES module exports.
- The Tests tab can call the pipeline orchestrator directly.

### Phase 4: Add GitHub Actions CI
**Deliverables**
- GitHub Actions workflow to run the Tests tab via Playwright (headless).
- Fail CI on any test failure.
- Upload artifacts on failure (screenshots + logs).

**Acceptance criteria**
- CI runs on pull requests.
- A failing golden test fails the workflow.
- Artifacts are accessible from the workflow run.

### Phase 5: Update docs
**Deliverables**
- Sync `frontend/readme.md` and `frontend/docs.md` to current file names and architecture.
- Add instructions for how to add samples/tests.

**Acceptance criteria**
- Documentation references the ES module entrypoint and current modules.
- A short guide exists for adding new golden samples + expectations.

## Golden Test Strategy
- Prefer **tolerance-based metrics** over pixel-perfect asserts.
- Suggested expectations per sample:
  - `paperDetected` boolean
  - Quadrilateral corner tolerance (px)
  - Contour area range
  - Timing thresholds per stage
  - STL export non-empty with basic stats (bounding box dimensions, triangle count)

### Sample categories (S1–S8)
- **S1**: clean, well-lit
- **S2**: skewed / angled
- **S3**: shadows
- **S4**: busy background
- **S5**: partial crop
- **S6**: low contrast
- **S7**: glare
- **S8**: fail / no paper

## How we review/merge Codex PRs
- Every feature PR **must update or add tests** when touching pipeline logic or UI wiring.
- **CI green required** for merge.
- Prefer **small PRs** that deliver one phase item at a time.


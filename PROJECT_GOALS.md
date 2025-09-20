# Project Goals

Goal: Make it easy to create objects that work with the Gridfinity 3D printing system.

Reference: https://gridfinity.xyz/

## Initial Milestones
- Place object on paper and generate an outline of it.
- Convert the outline into an STL file.
- Convert the STL file into a 3D‑printer‑ready Gridfinity block.

## Notes / Assumptions
- Paper outline capture can start with a photo + calibration (e.g., known paper size) to derive scale.
- STL generation may use a simple 2D polygon to 3D extrusion pipeline.
- Gridfinity compliance covers base geometry, magnet/fastener holes, and standard dimensions.

## Nice‑to‑Haves (Future)
- Auto-clean and smooth polygon outlines.
- Parametric options (height in "u", chamfer/fillet, magnet/bolt variants).
- Preview in browser before export.


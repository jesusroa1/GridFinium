# GridFinium

The repository now contains a static browser-based prototype for GridFinium under the `frontend/` directory. The project is configured so the static assets can be deployed with Vercel.

## Frontend
- Source files live in `frontend/`.
- Run `npm run build` to copy the static assets into the `dist/` folder that Vercel serves.

## Deployment
1. Push changes to GitHub.
2. In Vercel, set the project **Root Directory** to the repository root (do not point to `frontend/`).
3. Confirm the **Framework Preset** is **Other** (Vercel will use `npm run build`).
4. Leave the **Build Command** as `npm run build` and **Output Directory** as `dist` (these values are also present in `vercel.json`).
5. Trigger a new deployment.

Vercel will run the build script, copy the contents of `frontend/` into `dist/`, and publish the static site.

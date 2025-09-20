# 📋 Project Plan for Gridfinium (Hybrid v1 - Supabase Path)

## 1. Core Flow

1. **Browser**

   * Capture photo → OpenCV.js (WASM) in a Web Worker rectifies paper and extracts millimeter dimensions locally.
   * Send only `{dims, options}` plus JWT to backend (no photo leaves the browser).
2. **Backend API**

   * FastAPI receives the payload → CadQuery generates the STL → trimesh validates/repairs → uploads to Supabase Storage bucket `stl-bins`.
   * Returns a short-lived pre-signed download URL.
3. **Frontend**

   * three.js + STL loader render the preview and expose a “Download STL” CTA backed by the pre-signed URL.

---

## 2. Services & Sign-Ups You’ll Need

Here’s the checklist of signups you’ll want to do:

### 🔹 Frontend Hosting

* **Vercel** (preferred).

  * Hosts the Next.js PWA with automatic preview deploys from GitHub.

### 🔹 Backend API & Compute

* **Google Cloud Run** (primary) — **Fly.io** or **Render** as simpler fallbacks.

  * Dockerized FastAPI + Uvicorn runtime.
  * Integrate Google Secret Manager for configuration.

### 🔹 Storage, Database & Auth (Supabase)

* **Supabase Storage** bucket `stl-bins` (private) for STL outputs with pre-signed URL access.
* **Supabase Postgres** for user profiles, bin configs, and job records with RLS enabled.
* **Supabase Auth** for email + Google logins, issuing JWTs for API access.

### 🔹 Git/CI/CD

* **GitHub** (repo + Actions).

  * Workflows: lint, test, build Docker, deploy to Vercel/Cloud Run.

### 🔹 Monitoring & Error Tracking

* **Sentry** (free tier).

  * Frontend + backend error tracking.
* **Cloudflare (optional)** if you want WAF + rate limiting in front of your API.
* **gitleaks** pre-commit hook to avoid secret leakage.

---

## 3. Tooling Breakdown

* **Frontend stack**: Next.js (React) for routing/SSR/PWA, Zustand for state, Radix UI or MUI for components, OpenCV.js (WASM) vision worker, three.js + STL loader for previews.
* **Backend stack**: FastAPI with CadQuery geometry engine, trimesh for mesh validation, Uvicorn inside Docker.
* **Infrastructure**: Containerized API on Google Cloud Run (alt: Fly.io/Render), secrets sourced from Google Secret Manager.
* **Storage/DB/Auth**: Supabase Postgres + Auth + Storage with RLS and pre-signed URL access.
* **CI/CD & Monitoring**: GitHub Actions, Vercel integration, Docker build pipeline, Sentry for observability, gitleaks for secret scanning.

---

## 4. Step-by-Step Signup Flow

1. **GitHub** — create repo for Gridfinium.
2. **Vercel** — connect repo → instant frontend deploys.
3. **Supabase** — one project = Auth + Postgres + Storage (easy path).

   * Create bucket `stl-bins` (private) and define RLS policies.
   * Enable email + Google login providers.
4. **Google Cloud Run** (or Fly.io/Render) — deploy Dockerized FastAPI + Uvicorn.

   * Wire up Supabase keys via Google Secret Manager → environment variables.
5. **Sentry** — set up frontend + backend monitoring.
6. *(Optional)* **Cloudflare** — proxy your domain, add free SSL + rate limiting.

---

## 5. Early Deliverables (2-3 Weeks MVP)

* ✅ Camera capture + OpenCV.js Web Worker measurement in-browser (no photo upload).
* ✅ `/stl` FastAPI endpoint → CadQuery STL generation → trimesh validation → Supabase Storage upload.
* ✅ Frontend three.js STL preview + “Download STL” button using pre-signed URL.
* ✅ Supabase Auth (email + Google) with JWT-secured API calls and DB RLS for saved bin configs.
* ✅ Deployments: Vercel (frontend) + Cloud Run (backend) with GitHub Actions CI/CD.

---

> Want a **signup decision matrix** (Supabase vs AWS vs Firebase) or a **visual architecture diagram** (boxes + arrows) for docs and pitch decks?

# 📋 Project Plan for Gridfinium (Hybrid v1)

## 1. Core Flow

1. **Browser**

   * Capture photo → run OpenCV.js (vision pipeline) → extract dimensions.
   * Send only the dimensions + options (not the photo) to backend.
2. **Backend API**

   * Accept dimensions → generate Gridfinity STL via CadQuery → save STL → return pre-signed download link.
3. **Storage**

   * Generated STL lives in object storage (S3/Supabase).
4. **Frontend**

   * Download STL directly, or view STL preview (three.js).

---

## 2. Services & Sign-Ups You’ll Need

Here’s the checklist of signups you’ll want to do:

### 🔹 Frontend Hosting

* **Vercel** (preferred) or **Netlify**.

  * Hosts the React/Next.js app.
  * Handles PWA support and automatic deployments from GitHub.

### 🔹 Backend API & Compute

* **Railway**, **Render**, **Fly.io**, or **Google Cloud Run**.

  * Use FastAPI (Python) in Docker.
  * Cloud Run or Fly.io scale well with containerized CadQuery jobs.

### 🔹 Storage for STL Files

* **Amazon S3** (AWS free tier fine) *or* **Supabase Storage** (simpler dev experience).

  * Purpose: save generated STL files and hand out pre-signed download links.

### 🔹 Authentication

* **Supabase Auth** (built-in if you already use Supabase for storage/DB).

  * Alternatives: Clerk or Auth0 if you want polished login widgets.
  * Needed for: keeping user projects private and preventing API abuse.

### 🔹 Database (optional for v1, but handy)

* **Supabase Postgres** (bundled with Auth/Storage).

  * Use to save user presets, saved dimensions, and history of generated bins.

### 🔹 Git/CI/CD

* **GitHub** (repo + Actions).

  * Hook GitHub Actions to: lint, test, build Docker, deploy frontend/backend.

### 🔹 Monitoring & Error Tracking

* **Sentry** (free tier).

  * Frontend + backend error tracking.
* **Cloudflare (optional)** if you want WAF + rate limiting in front of your API.

---

## 3. Tooling Breakdown

* **Frontend stack**: Next.js (React), opencv.js (WASM), Zustand (state), three.js/STL viewer, PWA support.
* **Backend stack**: FastAPI, CadQuery, trimesh (mesh validation), Uvicorn/Gunicorn.
* **Infrastructure**: Dockerized API, deployed on Cloud Run/Fly.io.
* **Storage/DB/Auth**: Supabase (all-in-one) or AWS (S3 + Cognito + RDS if you want to stay in AWS land).
* **CI/CD**: GitHub Actions + Vercel integration + Docker build pipeline.

---

## 4. Step-by-Step Signup Flow

1. **GitHub** — create repo for Gridfinium.
2. **Vercel** — connect repo → instant frontend deploys.
3. **Supabase** — one project = Auth + Postgres + Storage (easy path).

   * Create bucket `stl-bins`.
   * Enable email login or OAuth (Google/GitHub).
4. **Railway/Render/Fly.io/Cloud Run** — deploy FastAPI in Docker.

   * Add Supabase/Storage creds as secrets.
5. **Sentry** — set up frontend + backend monitoring.
6. *(Optional)* **Cloudflare** — proxy your domain, add free SSL + rate limiting.

---

## 5. Early Deliverables (2-3 Weeks MVP)

* ✅ Camera capture + opencv.js measurement in browser.
* ✅ `/stl` FastAPI endpoint → generate STL → upload to storage → return URL.
* ✅ Frontend download button → STL viewer.
* ✅ Supabase Auth → login and save bin configs.
* ✅ Deployed on Vercel (frontend) + Cloud Run (backend).

---

> Want a **signup decision matrix** (Supabase vs AWS vs Firebase) to pick a stack and avoid doubling up? That way you’ll know exactly which services to register before coding.

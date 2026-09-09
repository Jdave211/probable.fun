# Probable Groups

A private, group-native prediction markets, built with Vite, Tailwind CSS, and FastAPI.

## What it does

- Create private groups
- Add yes/no markets inside a group
- Place fake-point picks for group members
- Track probability history, liquidity, and traded volume
- Resolve markets through AI, manual fallback, or group vote
- Update a leaderboard automatically from winning picks
- Persist groups, markets, trades, and balances in Supabase Postgres

## Stack

- Vite for the frontend toolchain
- Tailwind CSS for styling
- Chart.js for market history charts
- Motion for UI transitions
- FastAPI for the Python backend
- Supabase Postgres for persistence

## Environment

Copy `.env.example` to `.env.local` for local development. The backend should use a server-only Supabase service-role key in production:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_PUBLISHABLE_KEY=...
VITE_API_BASE_URL=https://your-render-service.onrender.com
VITE_PUBLIC_APP_BASE_URL=https://your-domain.com
VITE_PUBLIC_SHARE_BASE_URL=https://your-render-service.onrender.com
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ALLOWED_ORIGINS=https://your-domain.com
FRONTEND_BASE_URL=https://your-domain.com
PUBLIC_SHARE_BASE_URL=https://your-render-service.onrender.com
```

Auth uses Supabase Auth on the frontend. Enable the Google provider for Google sign-in and add your local and deployed app URLs to the Supabase Auth redirect URL allow list.

Before deploying the identity-aware API, run `backend/migrations/20260820_stable_user_identity.sql` in the Supabase SQL editor. It adds durable user IDs without removing legacy display-name data.

Market rule drafting uses `OPENAI_API_KEY`. Do not commit `.env.local` or any real API keys.

AI oracle resolution uses `ANTHROPIC_API_KEY`. `BRAVE_SEARCH_API_KEY` is optional and improves source lookup. If `ANTHROPIC_API_KEY` is missing, AI markets show a manual fallback path.

## Backend Ship Notes

- Deploy the FastAPI backend as a web service with `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`.
- Set `APP_ENV=production` so the backend refuses to run without `SUPABASE_SERVICE_ROLE_KEY`.
- Set `ALLOWED_ORIGINS` to the deployed frontend origin(s), comma-separated.
- Set `FRONTEND_BASE_URL` to the public app URL.
- Set `PUBLIC_SHARE_BASE_URL` to the public backend URL so Open Graph images resolve on WhatsApp/iMessage.
- Before public launch, do not leave Supabase tables open to the anon role. Once the backend has `SUPABASE_SERVICE_ROLE_KEY`, run `backend/schema_public_lockdown.sql` in Supabase SQL editor so browser clients cannot write directly to tables/RPCs.

### Production readiness check

After both services are live, verify readiness:

```bash
curl https://your-backend-domain.com/api/ready
```

Expect:
- `200` and `"ready": true` for a fully bootable deployment.
- `503` with `"ready": false` and `"issues"` when required env vars, CORS config, or Supabase connectivity is missing.

For day-to-day health probes, use `/api/health` (simple liveness) and `/api/ready` (startup dependency checks).

## Vercel Frontend Notes

- Link the GitHub repo to Vercel with framework preset `Vite`.
- Build command: `npm run build`.
- Output directory: `dist`.
- Set `VITE_API_BASE_URL` for a separate API host, or leave it empty to use the same-origin `/api` rewrite in `vercel.json`.
- Set `VITE_PUBLIC_APP_BASE_URL` to the frontend URL, for example `https://probable.live`.
- Set `VITE_PUBLIC_SHARE_BASE_URL` to the Render backend URL so shared market links and preview images resolve.
- `vercel.json` rewrites all routes to `index.html` so refreshes on `/market/...`, `/portfolio`, and invite links work.

## Local Dev

From this repo root, after creating `.env.local`, you can boot the full app with:

```bash
npm run dev:all
```

This starts both the FastAPI backend (default `127.0.0.1:8000`) and Vite frontend (default `127.0.0.1:5173`) and keeps both logs and sessions together.

If you prefer separate terminals, use the existing two-step flow below.

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
cp .env.example .env.local
uvicorn backend.main:app --reload
```

In a second terminal:

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
source .venv/bin/activate
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

For the explicit local-only fake sign-in, set both `VITE_ENABLE_DEV_AUTH_BYPASS=true` and `ALLOW_DEV_AUTH_BYPASS=true`. Never enable the backend flag in production.

## Build

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
npm run build
```

The frontend build is written to `dist/`.

If you want FastAPI to serve the built frontend, run:

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
source .venv/bin/activate
uvicorn backend.main:app --reload
```

## Production integrity update

Apply `supabase/migrations/20260909000000_production_integrity.sql` before deploying the updated backend. Fresh databases require `backend/schema.sql` first, followed by the migrations. The migration makes multi-outcome NO trades atomic and limits all application tables and trading RPCs to the backend service role. Do not reapply historical migrations after the lockdown. `/api/ready` checks database access, schema support, and browser-role restrictions and must return HTTP 200 before routing traffic. `/api/health` is process liveness only.

Browser database subscriptions are deliberately denied by the lockdown; the existing authenticated API polling remains the update mechanism. Add scoped RLS read policies before enabling direct Realtime subscriptions. Never expose the service-role key as a `VITE_` variable.

Production regression commands: `npm run test:unit`, `npm run test:db`, `npm run test:api`, `npm run test:ui`, and `npm run build`. Browser tests start their own Vite server and intercept API/auth responses for deterministic recovery and interaction tests; they are not evidence of a live OAuth or deployed-database test. Install Chromium with `npx playwright install chromium --only-shell` first.

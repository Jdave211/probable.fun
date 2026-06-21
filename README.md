# Probable Groups

A lightweight MVP for private, group-native prediction markets, built with Vite, Tailwind CSS, and FastAPI.

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

Market rule drafting uses `OPENAI_API_KEY`. Do not commit `.env.local` or any real API keys.

AI oracle resolution uses `ANTHROPIC_API_KEY`. `BRAVE_SEARCH_API_KEY` is optional and improves source lookup. If `ANTHROPIC_API_KEY` is missing, AI markets show a manual fallback path.

## Backend Ship Notes

- Deploy the FastAPI backend as a web service with `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`.
- Set `APP_ENV=production` so the backend refuses to run without `SUPABASE_SERVICE_ROLE_KEY`.
- Set `ALLOWED_ORIGINS` to the deployed frontend origin(s), comma-separated.
- Set `FRONTEND_BASE_URL` to the public app URL.
- Set `PUBLIC_SHARE_BASE_URL` to the public backend URL so Open Graph images resolve on WhatsApp/iMessage.
- Before public launch, do not leave Supabase tables open to the anon role. Once the backend has `SUPABASE_SERVICE_ROLE_KEY`, run `backend/schema_public_lockdown.sql` in Supabase SQL editor so browser clients cannot write directly to tables/RPCs.

## Vercel Frontend Notes

- Link the GitHub repo to Vercel with framework preset `Vite`.
- Build command: `npm run build`.
- Output directory: `dist`.
- Set `VITE_API_BASE_URL` to the Render backend URL. Do not leave it blank in production.
- Set `VITE_PUBLIC_APP_BASE_URL` to the frontend URL, for example `https://probable.live`.
- Set `VITE_PUBLIC_SHARE_BASE_URL` to the Render backend URL so shared market links and preview images resolve.
- `vercel.json` rewrites all routes to `index.html` so refreshes on `/market/...`, `/portfolio`, and invite links work.

## Local Dev

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
uvicorn backend.main:app --reload
```

In a second terminal:

```bash
cd /Users/davejaga/Desktop/startups/probable.fun
source .venv/bin/activate
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173).

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

# Deploying SiteSight (Railway, one service)

One Railway service runs everything in a single Node process (`pnpm start:prod`):

- runs the database migrations,
- serves the built web app (`apps/web/dist`) at `/`, with `index.html` for client-side routes,
- serves the API under `/api` (the web app calls `/api/...`, same origin),
- runs the worker loop (agent runs, drawing imports, transcription),

plus a Railway **Postgres** database and a **volume** at `/data` for photos, masks, drawing pages and PDF reports.

```
browser ──► https://<domain>/            web app (static, hashed assets cached for a year)
        ├─► https://<domain>/api/*       API (login cookie, live trace stream)
        └─► https://<domain>/api/storage/*  signed photo / mask / PDF URLs
                         │
                 Railway service (Dockerfile) ──► Railway Postgres
                         └── volume /data  (STORAGE_LOCAL_DIR=/data/storage)
```

## 1. Postgres

In the Railway project: **+ New → Database → PostgreSQL**. The service runs migrations itself at every start.

## 2. The service

1. **+ New → GitHub Repo →** this repository (or use the auto-detected service). **Root directory: the repo root**
   (leave empty). Railway uses [`railway.json`](railway.json): it builds the [`Dockerfile`](Dockerfile) (web build +
   API) and health-checks `/healthz`.
2. **Volume**: **Settings → Volumes → + New Volume**, mount path **`/data`**. Keep **1 replica** (a volume attaches
   to one instance, and the worker runs in the same process).
3. **Networking → Generate Domain**, e.g. `sitesight-production.up.railway.app`.
4. **Variables** (Raw Editor):

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
STORAGE_LOCAL_DIR=/data/storage
WEB_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
PUBLIC_API_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}/api
ALLOW_LAN_ORIGINS=false
DEMO_PASSWORD=<a long random passphrase>
SESSION_SECRET=<random, e.g. openssl rand -base64 48>
STORAGE_SIGNING_SECRET=<random, e.g. openssl rand -base64 48>
DAILY_SPEND_CAP_USD=5

META_API_KEY=<from the Meta dashboard>
META_BASE_URL=https://api.meta.ai/v1
SPARK_MODEL=muse-spark-1.3
SAM_MODEL=sam-3.1
VOICE_MODEL=muse-voice-transcribe-1.0
SPARK_INPUT_USD_PER_MTOK=1.25
SPARK_OUTPUT_USD_PER_MTOK=4.25
SAM_USD_PER_IMAGE=0.0025
```

`PORT` is set by Railway. The login cookie is signed with a key derived from `SESSION_SECRET` and `DEMO_PASSWORD`
(changing either logs everyone out). Signed storage URLs use `STORAGE_SIGNING_SECRET`, so links keep working across
restarts; without it a per-process key is used and links expire at every redeploy.

The service refuses to start (the deploy log says why) when `DATABASE_URL` isn't Postgres, there's no volume
(`STORAGE_LOCAL_DIR`) or R2, `WEB_ORIGIN` isn't `https://<host>`, `PUBLIC_API_URL` isn't `<WEB_ORIGIN>/api`,
`ALLOW_LAN_ORIGINS` is on, the Meta key/URL or prices are missing, or the web build is missing.

Startup log on success:

```
[prod] running migrations…
[prod] migrations done
[prod] API on :8080
[worker] started
```

## Meta proxy (when Meta refuses Railway's network)

Meta's Model API lists **no models** for requests from Railway's outbound IP (152.55.180.78, Ashburn, AS400940
Railway) and answers `model_not_found`, in every Railway region, while the same key works from India. The fix is a tiny
proxy on Vercel pinned to Mumbai: [meta-proxy/](meta-proxy/README.md). It forwards only `POST /v1/responses` and
`POST /v1/asr/transcribe`, requires a shared secret header, holds the real key, caps bodies at 4.4 MB, logs nothing.

1. `cd meta-proxy && vercel link --yes --project sitesight-meta-proxy`
2. Vercel env (production, sensitive): `META_API_KEY`, `META_PROXY_SECRET` (random).
3. `vercel deploy --prod` → `https://sitesight-meta-proxy.vercel.app` (region `bom1`).
4. Railway variables: `META_BASE_URL=https://sitesight-meta-proxy.vercel.app/v1`, `META_PROXY_SECRET=<same value>`.

Functions may run 300 s (`maxDuration`, the Hobby + Fluid maximum); the longest calls (long Spark answers) take about
2 minutes. Before a demo, log in and open `https://<domain>/healthz?deep=1`: it makes one tiny Spark call through the
proxy and answers `{"ok":true,"spark":{"ok":true,"latencyMs":…,"via":"proxy"}}` (503 with an HTTP status if Meta fails).

## Environment variables

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Strict startup checks, secure cookies, generic 500 messages. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Railway Postgres service. |
| `STORAGE_LOCAL_DIR` | `/data/storage` | On the volume mounted at `/data`. (Or leave empty and set `R2_*`.) |
| `WEB_ORIGIN` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | The public origin; CORS and write requests are limited to it. |
| `PUBLIC_API_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}/api` | Base of signed storage URLs: the origin + `/api`. |
| `ALLOW_LAN_ORIGINS` | `false` | Must stay false. |
| `DEMO_PASSWORD` | random passphrase | Login screen; 7-day sessions. Changing it logs everyone out. |
| `SESSION_SECRET` | random | Optional but recommended: part of the login-cookie key. |
| `STORAGE_SIGNING_SECRET` | random | Optional but recommended: signs storage URLs so they survive restarts. |
| `DAILY_SPEND_CAP_USD` | `5` | Meta spend per UTC day from the spend ledger (agent runs, drawing imports, spreadsheet BOQ parses; kept when projects are deleted). |
| `META_API_KEY`, `META_BASE_URL` | — | Meta Model API. |
| `META_PROXY_SECRET` | random | Only with the Meta proxy: sent as `X-Meta-Proxy-Secret`; `META_BASE_URL` points at the proxy. |
| `SPARK_MODEL`, `SAM_MODEL`, `VOICE_MODEL` | `muse-spark-1.3`, `sam-3.1`, `muse-voice-transcribe-1.0` | Never a `-contributor` variant. |
| `SPARK_INPUT_USD_PER_MTOK`, `SPARK_OUTPUT_USD_PER_MTOK`, `SAM_USD_PER_IMAGE` | `1.25`, `4.25`, `0.0025` | Required, > 0. |
| `MAX_COST_PER_VISIT_USD` | `1.50` | Optional (default 1.50). |
| `MAX_COST_PER_DRAWING_IMPORT_USD` | `1.00` | Optional (default 1.00). |
| `WEB_DIST_DIR` | — | Optional; defaults to `apps/web/dist` in the image. |
| Agent and worker tunables | see `.env.example` | All optional. |

## Post-deploy checklist

1. `curl https://<domain>/healthz` → `{"ok":true}`; `curl https://<domain>/api/projects` → `401`. Logged in,
   `/healthz?deep=1` checks the Meta path end to end (one tiny Spark call, logged as `health_check` spend).
2. Open `https://<domain>` → "Demo access" → log in with `DEMO_PASSWORD` → Projects with "AI spend today".
3. Create a project, a zone and a BOQ.
4. New visit → take/upload a photo → the thumbnail appears.
5. Run the agent → the live trace fills in step by step.
6. Review → accept → Create report → Generate PDF → Download PDF.
7. Restart the service → the project, photos and PDF are still there.

## Troubleshooting

- **403 "Storage URL rejected"**: signed URLs expire (1 h views, 10 min uploads); without `STORAGE_SIGNING_SECRET`
  they also stop working at every redeploy. Reload the page.
- **"Origin not allowed"**: `WEB_ORIGIN` must be exactly `https://<domain>`.
- **"Today's demo budget is used up"**: `DAILY_SPEND_CAP_USD` reached; resets at midnight UTC.
- **Local development** is unchanged: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web` (README).

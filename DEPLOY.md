# Deploying SiteSight

Target:

- **Railway**: one service running the API **and** the worker in a single Node process (`pnpm start:prod`), so both
  read and write the same storage volume; plus a Railway **Postgres** database.
- **Vercel**: the web app. A rewrite sends `/api/*` to the Railway API, so the browser stays on one origin (the
  login cookie and the live trace work without cross-site cookies).

```
browser ──► https://<app>.vercel.app            (static web app)
        ├─► https://<app>.vercel.app/api/*      ──rewrite──►  Railway API + worker ──► Railway Postgres
        └─► https://<api>.up.railway.app/storage/* (signed photo/mask/PDF URLs, straight to Railway)
                                                              └── volume /data (photos, masks, drawings, reports)
```

Photos are uploaded and viewed through short-lived signed URLs that point straight at Railway (`PUBLIC_API_URL`),
so large files don't pass through Vercel.

---

## 1. Railway: Postgres

1. In a new Railway project: **+ New → Database → PostgreSQL**.
2. Nothing else to do: the API runs migrations itself at every start.

## 2. Railway: API + worker service

1. **+ New → GitHub Repo →** this repository. Root directory: the repository root (leave empty).
   Railway picks up [`railway.json`](railway.json): it builds the [`Dockerfile`](Dockerfile) and health-checks
   `/healthz`.
2. **Volume**: on the service, **Settings → Volumes → + New Volume**, mount path **`/data`**. Photos, masks,
   drawing pages and PDF reports live under `/data/storage` and survive redeploys. Keep the service at
   **1 replica** (a volume attaches to one instance; the worker runs in the same process).
3. **Networking → Generate Domain**. Note it, e.g. `sitesight-api.up.railway.app`.
4. **Variables** (Raw Editor), then deploy:

```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
STORAGE_LOCAL_DIR=/data/storage
PUBLIC_API_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
WEB_ORIGIN=https://sitesight.vercel.app
DEMO_PASSWORD=pick-a-long-passphrase
DAILY_SPEND_CAP_USD=5

META_API_KEY=sk-...
META_BASE_URL=https://api.meta.ai/v1
SPARK_MODEL=muse-spark-1.3
SAM_MODEL=sam-3.1
VOICE_MODEL=muse-voice-transcribe-1.0
SPARK_INPUT_USD_PER_MTOK=1.25
SPARK_OUTPUT_USD_PER_MTOK=4.25
SAM_USD_PER_IMAGE=0.0025
```

`PORT` is set by Railway; don't set it. `WEB_ORIGIN` must be the exact Vercel URL (scheme, no trailing slash); fill
in a placeholder now and correct it after step 3 if Vercel gives a different domain.

The service refuses to start (and the deploy log says why) if `DATABASE_URL` is not Postgres, `STORAGE_LOCAL_DIR`
is unset without R2 credentials, `PUBLIC_API_URL` is missing or not https, `WEB_ORIGIN` is still localhost,
`ALLOW_LAN_ORIGINS` is true, or the Meta key/URL or prices are missing.

Startup log on success:

```
[prod] running migrations…
[prod] migrations done
[prod] API on :8080
[worker] started
```

## 3. Vercel: web app

1. Edit [`apps/web/vercel.json`](apps/web/vercel.json): replace
   `REPLACE-WITH-YOUR-RAILWAY-DOMAIN.up.railway.app` with the Railway domain from step 2.3. Commit and push.
   (Vercel rewrites can't read environment variables, so the domain lives in this file.)
2. **Add New → Project →** this repository. **Root Directory: `apps/web`**. Framework: Vite (detected).
   Install and build commands come from `vercel.json` (`pnpm install --frozen-lockfile`, `pnpm build`), output `dist`.
3. **Environment variables: none.** Leave `VITE_API_URL` unset so the app calls `/api` through the rewrite.
   Never put secrets in `VITE_*` variables: they end up in the public JavaScript.
4. Deploy, note the URL (e.g. `https://sitesight.vercel.app`) and make sure Railway's `WEB_ORIGIN` matches it
   exactly. Redeploy the Railway service if you changed it.

---

## Environment variables

### Railway (API + worker)

| Variable | Example | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Strict startup checks, LAN origins off, secure cookies, generic 500 messages. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Railway reference to the Postgres service. |
| `STORAGE_LOCAL_DIR` | `/data/storage` | On the mounted volume. (Alternatively leave empty and set the `R2_*` variables.) |
| `PUBLIC_API_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Base of signed storage URLs. Must be https. |
| `WEB_ORIGIN` | `https://sitesight.vercel.app` | Only origin allowed by CORS and for writes. Comma-separate several. |
| `ALLOW_LAN_ORIGINS` | `false` | Default `false` in production; must stay false. |
| `DEMO_PASSWORD` | `pick-a-long-passphrase` | Login screen; sessions last 7 days. Changing it logs everyone out. Empty = no login. |
| `DAILY_SPEND_CAP_USD` | `5` | Meta spend per UTC day across all visits and drawing imports. |
| `META_API_KEY` | `sk-...` | Meta Model API key. |
| `META_BASE_URL` | `https://api.meta.ai/v1` | From the Meta dashboard. |
| `SPARK_MODEL` | `muse-spark-1.3` | Never a `-contributor` variant (the API refuses to start). |
| `SAM_MODEL` | `sam-3.1` | |
| `VOICE_MODEL` | `muse-voice-transcribe-1.0` | |
| `SPARK_INPUT_USD_PER_MTOK` | `1.25` | Required, > 0. From the Meta pricing page. |
| `SPARK_OUTPUT_USD_PER_MTOK` | `4.25` | Required, > 0. |
| `SAM_USD_PER_IMAGE` | `0.0025` | Required, > 0. |
| `MAX_COST_PER_VISIT_USD` | `1.50` | Per-visit cap (default 1.50). |
| `MAX_COST_PER_DRAWING_IMPORT_USD` | `1.00` | Per-import cap (default 1.00). |
| `MAX_AGENT_STEPS` | `30` | Model turns per run (default 30). |
| `ASK_BACK_THRESHOLD` | `0.6` | Below this confidence the agent asks for a photo. |
| `MAX_IMAGE_EDGE_PX` | `1600` | Photo size sent to the models. |
| `VISUAL_ONLY_MAX_CONFIDENCE` | `0.7` | Cap for items judged by eye. |
| `SAM_CONCURRENCY` | `3` | Parallel SAM requests. |
| `MAX_IMAGES_IN_CONTEXT` | `3` | Images kept in the agent conversation. |
| `DRAWING_MAX_PAGES` | `40` | Largest drawing PDF accepted. |
| `DRAWING_CONCURRENCY` | `3` | Parallel Spark calls per drawing import. |
| `WORKER_POLL_MS` | `1000` | How often the worker checks for jobs. |
| `JOB_MAX_ATTEMPTS` | `3` | Retries per job. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | — | Only if you use R2 instead of the volume. |
| `PORT` | — | Set by Railway. |

### Vercel (web)

| Variable | Example | Notes |
|---|---|---|
| `VITE_API_URL` | *(unset)* | Leave unset: the app calls `/api`, rewritten to Railway. |

---

## Post-deploy checklist

Run through these on a phone if you can (the capture screen is built for it).

1. **Health**: `curl https://<railway-domain>/healthz` → `{"ok":true}` (checks the database too).
   `curl https://<railway-domain>/projects` → `401 {"error":"Log in to use the demo.","authRequired":true}`.
2. **Login**: open `https://<vercel-domain>` → the "Demo access" screen. A wrong password says so; the right one
   opens the Projects screen, with **AI spend today $0.00 of $5.00** at the top.
3. **Create project**: New project → name + city → add a zone → Set up the BOQ (spreadsheet, or From drawings
   with a PDF; watch the pages being read and the cost).
4. **Upload photo**: New visit → pick the zone → Take a photo → Upload & take next. The thumbnail appears in the
   strip (the upload goes straight to Railway through a signed URL).
5. **Run agent**: Done · run agent. The live trace fills in step by step (if it only appears all at once at the
   end, the stream is being buffered on the way; see Troubleshooting). Today's spend on the Projects screen goes up.
6. **Review + PDF**: Review → accept the items → Create report → Generate PDF → Download PDF opens the report with
   the evidence photos.
7. **Restart survives**: redeploy the Railway service; the project, photos and PDF are still there (volume +
   Postgres). The deploy log shows `[prod] SIGTERM: shutting down` … `[prod] bye` on the old instance.

## Troubleshooting

- **CORS / "Origin not allowed" on uploads**: `WEB_ORIGIN` must equal the Vercel URL exactly.
- **Images or uploads fail with 403 "Storage URL rejected"**: signed URLs expire (1 h for views, 10 min for uploads)
  and are tied to the running process, so URLs handed out before a redeploy stop working. Reload the page.
- **Live trace arrives only at the end**: the trace is a server-sent event stream through the Vercel rewrite. The API
  sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`; if a proxy still buffers it, the run itself is
  unaffected: reload the visit page to see the results.
- **Large drawing PDFs fail through `/api`**: drawing uploads (up to 25 MB) go through the Vercel rewrite. If Vercel
  rejects large request bodies on your plan, upload a smaller PDF (split the set, or only the structural sheets).
- **"Today's demo budget is used up"**: `DAILY_SPEND_CAP_USD` was reached; it resets at midnight UTC. Raise the
  variable to continue today.
- **Local development** is unchanged: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:web` (see README).

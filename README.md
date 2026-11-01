# SiteSight

AI site-progress auditor for small construction contractors. Upload a BOQ, snap site photos per zone,
and an agent (Muse Spark + SAM 3.1) estimates progress per BOQ item with evidence, asks for extra photos
when unsure, and produces a bill-ready PDF.

See [DESIGN.md](DESIGN.md) for the full design. It is the source of truth.

## Layout

```
packages/shared   zod schemas + types shared by api and web
apps/api          Express API, Postgres job worker, agent, Meta Model API layer (src/meta/)
apps/web          React + Vite + Tailwind PWA
samples/          anonymised demo photos + BOQ
```

## Setup

Requires Node 20+, pnpm 10, and a Postgres database.

```sh
pnpm install
cp .env.example .env          # fill in META_* and prices; R2_* or STORAGE_LOCAL_DIR (see below)
docker compose up -d          # local Postgres on :5432 (or point DATABASE_URL at an existing Postgres)
pnpm db:migrate               # apply migrations (after schema changes: pnpm db:generate first)
pnpm seed                     # optional demo project
pnpm seed --boq samples/boq-demo-residence.json --name "Demo Residence"   # or a project from a BOQ JSON
```

No R2 account? Set `STORAGE_LOCAL_DIR=samples/out/storage` in `.env`. Photos, masks and reports are then stored as
files, and the API serves short-lived signed `/storage/…` URLs for uploads and downloads in place of R2's.

## Run

```sh
pnpm dev:api      # http://localhost:8787
pnpm dev:worker   # polls the jobs table and runs the agent
pnpm dev:web      # http://localhost:5173, also on your LAN (prints the phone URL)
```

In dev the web app calls `/api/*` and Vite proxies it to the API, so leave `VITE_API_URL` empty locally.

### Testing on a phone

1. Phone and computer on the same Wi-Fi. Run the API and worker as above.
2. `pnpm dev:web:https` (self-signed HTTPS; most phones only allow camera capture over HTTPS). It prints
   `Phone (same Wi-Fi): https://192.168.x.x:5173/`.
3. Open that URL on the phone and accept the certificate warning once (it is a dev-only self-signed certificate).
4. If the phone cannot connect, allow Node.js through the Windows firewall for private networks.

The API accepts browser origins on private networks in dev (`ALLOW_LAN_ORIGINS`, off when `NODE_ENV=production`).

## End-to-end smoke test

```sh
pnpm e2e-smoke          # defaults: --boq samples/boq-demo-residence.json --visits "samples/demo-residence/v1,samples/demo-residence/v2"
```

Starts the real API and worker (local file storage, port 8799) against your `DATABASE_URL`, then over HTTP: creates a
project from the BOQ; for each visit uploads photos via presign + register, runs the agent, follows the live trace until
assessed / needs input and accepts the assessments; finally generates the PDF for the last visit and prints its path.
It stops at the first failing step with the API and worker log tails. Real Meta calls: up to `MAX_COST_PER_VISIT_USD`
per visit.

## SAM spike

```sh
pnpm sam-spike --concepts "brickwork,exposed brick wall" --dir samples/site-a [--min-score 0.5]
```

Writes overlays and a `run-<time>.json` summary to `samples/out/` (gitignored).

## Agent dry run

Runs the real agent loop against Meta on a folder of photos, with no Docker, API server, worker or R2:

```sh
pnpm agent-dry-run --photos samples/site-a --boq samples/boq-demo.json
```

Several visits of the same project, in order:

```sh
pnpm agent-dry-run --visits samples/demo-residence/v1,samples/demo-residence/v2 --boq samples/boq-demo-residence.json
```

Before each visit the previous visit's assessments are accepted (as an engineer would), so the agent sees them; after each visit from the second on, a "progress since last visit" table shows previous | now | change.

- Each subfolder of `--photos` becomes a zone; photos directly in the folder form one zone. A `<photo>.txt` next to a photo is used as its voice-note transcript.
- `--boq` takes JSON (see [samples/boq-demo.json](samples/boq-demo.json), [samples/boq-demo-residence.json](samples/boq-demo-residence.json)) or an `.xlsx`, which Muse Spark parses first. A JSON BOQ may declare `"zones"`; loose photos then go into its single zone, so every visit uses the same zone.
- Uses an in-memory database (`DATABASE_URL=pglite:memory`) and local file storage (`STORAGE_LOCAL_DIR`), both set by the script.
- Streams every trace step with the running cost, then prints a results table, photo requests, total steps and cost. Masks and a full JSON report go to `samples/out/dry-run-<time>/`.
- Spend is capped by `MAX_COST_PER_VISIT_USD` in `.env`.

## BOQ from drawings

On the BOQ page, **From drawings** takes a PDF drawing set (≤ 25 MB, ≤ `DRAWING_MAX_PAGES` pages). The API rasterises
each page (pdfjs-dist + @napi-rs/canvas: no system installs), then the worker has Muse Spark sort every sheet and read the
structural ones (schedules, layout counts). Code, not the model, turns that into proposed BOQ items with their source
page, evidence and confidence. Quantities the drawings don't state, or where a schedule and a layout disagree, are marked
"needs input" (a disagreement is listed as a drawing discrepancy). The saved items keep a `drawing_source` line that the
agent cites ("drawings specify 12 columns; 10 visible as cast"). Spend is capped by `MAX_COST_PER_DRAWING_IMPORT_USD`
(default $1.00).

Dry run, without the database:

```sh
pnpm boq-from-drawings --pdf drawings.pdf [--out samples/out/drawings] [--max-cost 0.50]
```

## Evaluation

`pnpm eval` runs labelled cases ([samples/eval/cases.json](samples/eval/cases.json)) through the real agent (photo cases,
in-memory DB) and the drawing import (drawing cases), and scores them: stage exact-match, count within tolerance,
evidence basis, drawing totals, how many SAM detections the agent rejected (and whether the labelled false positives
were among them), consistency across runs, cost and latency. Report: `samples/out/eval/<time>/report.md` + `report.json`;
the console ends with a table to paste here.

```sh
pnpm eval                 # every case once
pnpm eval --runs 3        # consistency
pnpm eval --only demo-residence-drawings
pnpm eval --max-cost 5    # hard cap on Meta spend for the whole eval (default $10)
```

Each run's own cap is shrunk to what is left of `--max-cost`, so a run can overshoot it by at most one model call; runs
are skipped once it is spent. The labels in `cases.json` are drafts to be confirmed by the site engineer.

## Deploying

Railway (API + worker in one process, Postgres, a volume for files) and Vercel (web): see [DEPLOY.md](DEPLOY.md).

## Rules

- Nothing outside `apps/api/src/meta/` imports the `openai` SDK.
- Never use a `-contributor` model variant (the API refuses to start with one).
- Never commit `.env`, real client names, rates or addresses.

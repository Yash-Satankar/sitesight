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
cp .env.example .env          # fill in META_*, R2_* (DATABASE_URL already points at the local container)
docker compose up -d          # local Postgres on :5432
pnpm db:migrate               # apply migrations (after schema changes: pnpm db:generate first)
pnpm seed                     # optional demo project
```

## Run

```sh
pnpm dev:api      # http://localhost:8787
pnpm dev:worker   # polls the jobs table and runs the agent
pnpm dev:web      # http://localhost:5173 (also exposed on your LAN for phone testing)
```

Camera capture on a phone needs HTTPS (or localhost). For on-device testing use the deployed web app,
or a tunnel such as `cloudflared tunnel --url http://localhost:5173`.

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

- Each subfolder of `--photos` becomes a zone; photos directly in the folder form one zone. A `<photo>.txt` next to a photo is used as its voice-note transcript.
- `--boq` takes JSON (see [samples/boq-demo.json](samples/boq-demo.json)) or an `.xlsx`, which Muse Spark parses first.
- Uses an in-memory database (`DATABASE_URL=pglite:memory`) and local file storage (`STORAGE_LOCAL_DIR`), both set by the script.
- Streams every trace step with the running cost, then prints a results table, photo requests, total steps and cost. Masks and a full JSON report go to `samples/out/dry-run-<time>/`.
- Spend is capped by `MAX_COST_PER_VISIT_USD` in `.env`.

## Rules

- Nothing outside `apps/api/src/meta/` imports the `openai` SDK.
- Never use a `-contributor` model variant (the API refuses to start with one).
- Never commit `.env`, real client names, rates or addresses.

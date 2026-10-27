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

## Day-1 SAM spike

```sh
pnpm sam-spike ../../samples/photos "concrete column" "brick wall" "A4 sheet of paper"
```

Writes masks and overlays to `apps/api/spike-out/`. The SAM 3.1 wire format is not confirmed yet:
implement `callSam` in [apps/api/src/meta/sam.ts](apps/api/src/meta/sam.ts) first.

## Rules

- Nothing outside `apps/api/src/meta/` imports the `openai` SDK.
- Never use a `-contributor` model variant (the API refuses to start with one).
- Never commit `.env`, real client names, rates or addresses.

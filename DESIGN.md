# SiteSight — Codebase Design

AI site-progress auditor for small construction contractors.
Meta Global AI Developer Hackathon 2026 · Indie track · Submission due Nov 4, 9:00 PM ET (Nov 5, 07:30 IST)

> Keep this file in the repo root. It is the source of truth for Claude Code / Muse Code prompts.

---

## 1. Scope

### MVP (must ship)
1. Create a project and upload a BOQ (.xlsx). Muse Spark parses it into structured line items.
2. Define zones (e.g. "Floor 3 – East").
3. Start a site visit, then capture photos per zone (phone camera, PWA) with an optional voice note.
4. The agent runs: SAM 3.1 segments → Muse Spark reasons with tools → per-BOQ-item progress with confidence + evidence.
5. Ask-back: when confidence is low, the agent requests a specific photo. The engineer uploads it and the agent resumes.
6. The engineer reviews and accepts or edits each assessment.
7. Generate a bill-ready PDF progress report with evidence photos.
8. Live agent trace in the UI (every tool call visible). This doubles as the demo's "wow" moment.

### Stretch (only if MVP is done by Nov 2)
- Visit-to-visit comparison ("slab S3 poured since last visit").
- Deviation flags against the drawing sequence (work done out of order).
- Hindi/Marathi voice notes.

### Explicit non-goals
- Exact quantity surveying. Output is an evidence-backed estimate that the engineer confirms.
- Multi-tenant auth, billing, roles. One demo login is enough.
- Native mobile app. A PWA covers camera access.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces | Shared types between api and web |
| API | Node 20, Express, TypeScript | Strongest stack, fast to build |
| Validation | zod | Validates both HTTP input and every LLM output |
| DB | PostgreSQL + Drizzle ORM | Typed SQL, simple migrations |
| Jobs | Postgres-backed job table + worker loop | No Redis needed; one fewer service |
| Storage | Cloudflare R2 (S3 API) | Free tier, presigned uploads |
| Images | sharp | Resize, mask overlays, crops for evidence |
| Excel | exceljs | BOQ parsing input |
| PDF | pdfkit | Server-side report |
| LLM SDK | `openai` npm package pointed at Meta Model API | Meta API is OpenAI-compatible |
| Web | React + Vite + Tailwind, PWA plugin | Camera capture on phone |
| Live trace | Server-Sent Events | Simpler than websockets |
| Deploy | API + worker + Postgres on Railway, web on Vercel | Already familiar |

---

## 3. Repo layout

```
sitesight/
├─ DESIGN.md
├─ README.md
├─ .env.example
├─ pnpm-workspace.yaml
├─ packages/
│  └─ shared/                 # zod schemas + TS types used by api and web
│     └─ src/
│        ├─ schemas/          # boq.ts, assessment.ts, agent.ts, api.ts
│        └─ index.ts
├─ apps/
│  ├─ api/
│  │  ├─ src/
│  │  │  ├─ index.ts          # express bootstrap
│  │  │  ├─ config.ts         # env parsing (zod), all tunables live here
│  │  │  ├─ db/
│  │  │  │  ├─ schema.ts      # drizzle tables
│  │  │  │  └─ migrations/
│  │  │  ├─ routes/           # projects, boq, zones, visits, photos, reports, trace
│  │  │  ├─ services/
│  │  │  │  ├─ storage.ts     # R2 presign/get/put
│  │  │  │  ├─ boq-parser.ts  # xlsx → rows → Muse Spark → BoqItem[]
│  │  │  │  ├─ measure.ts     # pixel → metre conversion, counts, areas
│  │  │  │  ├─ overlay.ts     # sharp: draw masks + labels on photos
│  │  │  │  └─ report.ts      # pdfkit report
│  │  │  ├─ meta/             # ALL Meta Model API access goes through here
│  │  │  │  ├─ client.ts      # OpenAI SDK instance, baseURL from env
│  │  │  │  ├─ spark.ts       # responses.create wrapper, retries, cost tracking
│  │  │  │  ├─ sam.ts         # segment(image, concepts) → Segment[]
│  │  │  │  └─ voice.ts       # transcribe(audio) → text
│  │  │  ├─ agent/
│  │  │  │  ├─ run.ts         # the agent loop
│  │  │  │  ├─ tools.ts       # tool JSON schemas + handlers
│  │  │  │  ├─ prompts.ts     # system prompt + templates
│  │  │  │  └─ trace.ts       # writes agent_steps, emits SSE
│  │  │  └─ worker/
│  │  │     └─ index.ts       # polls jobs table, runs agent
│  │  └─ scripts/
│  │     ├─ sam-spike.ts      # DAY 1: run SAM 3.1 on sample photos
│  │     └─ seed.ts           # demo project, BOQ, zones
│  └─ web/
│     └─ src/
│        ├─ pages/            # Projects, Project, Visit, Capture, Review, Report
│        ├─ components/       # BoqTable, PhotoWithMasks, AgentTrace, AskBackCard
│        └─ lib/api.ts
└─ samples/                   # anonymised demo photos + BOQ (no client names/rates)
```

---

## 4. Data model

```sql
projects      (id, name, location_label, created_at)

zones         (id, project_id, name, sort_order)

boq_items     (id, project_id, zone_id NULL, code, description,
               unit,                 -- 'nos' | 'm2' | 'm3' | 'rmt' | 'kg'
               planned_qty NUMERIC,
               measure_mode,         -- 'count' | 'area' | 'visual_only'
               sam_concepts TEXT[],  -- e.g. {'concrete column'}
               sequence_no INT NULL) -- for out-of-order detection (stretch)

visits        (id, project_id, visit_date,
               status,               -- see state machine §5
               created_at)

photos        (id, visit_id, zone_id, storage_key, width, height,
               voice_note_key NULL, transcript NULL,
               ask_back_id NULL,     -- set if uploaded in response to an ask-back
               created_at)

segments      (id, photo_id, concept, instance_idx,
               mask_key,             -- PNG mask in storage
               bbox JSONB, area_px INT, score REAL)

assessments   (id, visit_id, boq_item_id,
               percent_complete REAL, qty_done NUMERIC NULL,
               confidence REAL,      -- 0..1
               rationale TEXT,
               deviation TEXT NULL,
               status,               -- 'proposed' | 'accepted' | 'edited'
               engineer_note TEXT NULL)

assessment_evidence (assessment_id, photo_id, segment_ids INT[])

ask_backs     (id, visit_id, zone_id, boq_item_id NULL,
               instruction TEXT, reason TEXT,
               status)               -- 'open' | 'fulfilled' | 'skipped'

agent_runs    (id, visit_id, status, steps INT,
               input_tokens INT, output_tokens INT, cost_usd NUMERIC,
               started_at, finished_at, error TEXT NULL)

agent_steps   (id, run_id, idx, kind,  -- 'model' | 'tool_call' | 'tool_result'
               name TEXT NULL, payload JSONB, created_at)

jobs          (id, kind, payload JSONB, status, attempts, run_after, locked_at)

reports       (id, visit_id, storage_key, created_at)
```

`agent_steps` is not optional. It powers the live trace, debugging, and the demo video.

---

## 5. Visit state machine

```
draft ──photos uploaded──▶ queued ──worker picks──▶ processing
                                                     │
                       ┌───────── needs_input ◀──────┤ (agent called request_photo)
                       │   (engineer uploads photo /  │
                       │    skips ask-back)           │
                       └──────▶ queued                ▼
                                                  assessed ──engineer review──▶ reviewed ──▶ reported
```

- An agent run ends either with `finish` → `assessed`, or with ≥1 open ask-back → `needs_input`.
- When all ask-backs are fulfilled or skipped, a new run starts with previous assessments as context.

---

## 6. Meta Model API layer (`apps/api/src/meta/`)

**Rule: nothing outside `meta/` imports the OpenAI SDK.**

- `client.ts`: `new OpenAI({ apiKey: env.META_API_KEY, baseURL: env.META_BASE_URL })`. Take the base URL from the Meta dashboard; don't hardcode it.
- `spark.ts`: wraps the Responses API (Meta's recommended surface).
  - Known constraints: reasoning cannot be turned off; `tool_choice` only supports `auto`; stop sequences are ignored. The loop must never depend on forcing a specific tool.
  - Retries with backoff on 429/5xx.
  - Every call records tokens + cost in `agent_runs`. Abort if `cost_usd > env.MAX_COST_PER_VISIT_USD`.
  - Never use a `-contributor` model variant (it permits training on request data).
- `sam.ts`: `segment(image: Buffer, concepts: string[]): Promise<Segment[]>`
  - **The request/response shape is unverified. Confirm it on day 1 from the docs** and keep this signature stable regardless.
  - Cache results by `(photo_id, concept)` so the agent never pays twice.
- `voice.ts`: `transcribe(audio: Buffer): Promise<string>` via Muse Voice Transcribe. Stretch priority.
- **Do not use Muse Image.** It is geo-blocked in India.

Images go to Spark as base64 (resized to ≤1600px long edge with sharp), not public URLs, so site photos never become publicly reachable.

---

## 7. Agent design (`apps/api/src/agent/`)

### Loop
```
load visit context (zones, BOQ items, photos, transcripts, prior assessments, ask-back answers)
messages = [system, context]
for step in 1..MAX_AGENT_STEPS:
    resp = spark.respond(messages, tools)
    trace(resp)
    if no tool calls: nudge once ("call finish or request_photo"), then fail the run
    for each tool call:
        validate args with zod → on failure return the error to the model as a tool result
        result = handler(args); trace(result)
        if tool == finish: end run
messages += tool results
```

### Tools

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `list_boq_items` | `zone_id?` | items with unit, planned_qty, measure_mode, concepts | |
| `list_photos` | `zone_id?` | id, zone, transcript, has_segments | |
| `view_photo` | `photo_id`, `with_masks?: bool` | image (as input_image) + mask legend | Overlay drawn by `overlay.ts` |
| `segment_photo` | `photo_id`, `concepts: string[]` (≤5) | per concept: instance count, areas_px, scores | Calls SAM 3.1, cached |
| `measure` | `photo_id`, `segment_ids`, `reference: 'a4' \| 'tape_1m' \| 'brick'` | count, area_m2 (approx), scale_confidence | Pure code, no model |
| `get_previous_assessment` | `boq_item_id` | last accepted assessment | |
| `record_assessment` | `boq_item_id, percent_complete, qty_done?, confidence, rationale, evidence: [{photo_id, segment_ids}], deviation?` | ok | Upsert per visit |
| `request_photo` | `zone_id, boq_item_id?, instruction, reason` | ask_back_id | Instruction must be physically specific |
| `finish` | `summary` | — | Ends run |

### Measurement approach (`services/measure.ts`)
- **count** items (columns, openings, slabs poured): instance count from SAM, deduped across photos of the same zone by asking Spark to confirm overlaps.
- **area** items (brickwork, plaster): segment the reference object (A4 sheet = 0.0624 m², 1 m tape) → px²→m² ratio → apply to target masks. Ignores perspective, so `scale_confidence` drops if the reference is far from the target or heavily skewed. Documented limitation.
- **visual_only** items: Spark judges stage from the image (e.g. "shuttering done, not cast"). Confidence is capped at 0.7.

### System prompt principles (`prompts.ts`)
- You are a site progress auditor. Every claim must cite photo + segment evidence.
- Prefer `segment_photo` + `measure` over eyeballing whenever measure_mode is count/area.
- If confidence < `ASK_BACK_THRESHOLD`, call `request_photo` with an instruction a site engineer can follow in 30 seconds.
- Never invent BOQ items. Never exceed 100%.

---

## 8. HTTP API

```
POST   /projects                         create
GET    /projects/:id                     project + zones + BOQ + latest progress
POST   /projects/:id/boq                 multipart .xlsx → parsed items (returned for review)
PUT    /projects/:id/boq                 save reviewed items
POST   /projects/:id/zones
POST   /projects/:id/visits              → visit (draft)
POST   /visits/:id/photos/presign        → { uploadUrl, storageKey }
POST   /visits/:id/photos                register uploaded photo (+ zone, voice note key)
POST   /visits/:id/run                   enqueue agent job
GET    /visits/:id                       visit + assessments + ask-backs
GET    /visits/:id/trace                 SSE stream of agent_steps
POST   /ask-backs/:id/fulfil             { photoId }  → re-enqueue when all resolved
POST   /ask-backs/:id/skip
PATCH  /assessments/:id                  accept / edit
POST   /visits/:id/report                → PDF, returns download URL
```

Request and response bodies are defined in `packages/shared/src/schemas/api.ts` and imported by both sides.

---

## 9. Web screens

1. **Projects:** list + create.
2. **Project:** BOQ table with progress bars per item, zones, visit history.
3. **BOQ review:** parsed table, inline edit of unit/qty/measure_mode/concepts before save.
4. **Capture (mobile-first):** pick zone → camera → optional hold-to-record voice note → next. Uploads go straight to R2 via presigned URL.
5. **Visit:** left side is the live agent trace (tool calls appear as they happen); right side is assessments as they land. Ask-back cards show "Take this photo" with a camera button.
6. **Review:** per item: photo with mask overlay, %, confidence, rationale, then Accept/Edit.
7. **Report:** preview + download PDF.

---

## 10. Environment (`.env.example`)

```
# Meta Model API
META_API_KEY=
META_BASE_URL=               # copy from Meta dashboard
SPARK_MODEL=muse-spark-1.3
SAM_MODEL=sam-3.1
VOICE_MODEL=muse-voice-transcribe-1.0

# Pricing (USD) — REQUIRED, must be > 0 or the API/worker refuse to start. Copy from the Meta pricing page.
SPARK_INPUT_USD_PER_MTOK=
SPARK_OUTPUT_USD_PER_MTOK=
SAM_USD_PER_IMAGE=0.0025

# Agent tunables
MAX_AGENT_STEPS=25
MAX_COST_PER_VISIT_USD=1.50
ASK_BACK_THRESHOLD=0.6
MAX_IMAGE_EDGE_PX=1600
SAM_CONCURRENCY=3            # parallel SAM requests per segment() call

# Infra
DATABASE_URL=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=sitesight
WEB_ORIGIN=http://localhost:5173
```

---

## 11. Build order

| Date | Deliverable | Done when |
|---|---|---|
| Oct 27 | `meta/client.ts`, `scripts/sam-spike.ts` on 20 real photos | Masks saved to disk for columns/brickwork; go/no-go decided |
| Oct 28 | Monorepo, DB schema, R2, BOQ upload + Spark parsing | Real BOQ parses into clean items |
| Oct 29 | Agent loop + tools (segment, measure, record, finish) via CLI | One visit assessed end-to-end from the terminal |
| Oct 30 | Ask-back + re-run, agent_steps trace, cost guard | Low-confidence item triggers a sensible photo request |
| Oct 31 | HTTP API + worker + SSE | Same flow driven over HTTP |
| Nov 1 | Web: projects, BOQ review, capture, visit trace | Full flow on a phone |
| Nov 2 | Review screen, PDF report, deploy (Railway + Vercel) | Public URL works on mobile data |
| Nov 3 | Seed demo data, record demo video, README | Video ≤ 3 min uploaded |
| Nov 4 | Buffer, fixes, submit before 21:00 ET | Submitted |

---

## 12. Demo video outline (≤ 3 min)

1. **Problem (20s):** WhatsApp photos + Excel BOQ → disputed running bills.
2. **Upload BOQ (15s):** messy Excel → clean items.
3. **Site visit (30s):** engineer snaps 4 photos on a phone, adds a voice note.
4. **Agent at work (45s):** live trace: SAM masks appear on columns/brickwork, measurement, assessments land with confidence.
5. **Ask-back (25s):** "Photograph the east face of column C4 with the tape visible" → upload → confidence jumps.
6. **Report (20s):** bill-ready PDF with evidence crops.
7. **Meta stack + impact (25s):** Muse Spark 1.3 + SAM 3.1 + Voice Transcribe (+ built with Muse Code); who it helps and what it costs per visit.

---

## 13. Data handling

- Contractor's written OK before using real photos/BOQs.
- Strip client names, rates, and addresses from `samples/` and the demo. Hackathon rules grant organisers a perpetual licence to anything shared.
- Never commit `.env`. The R2 bucket is private; access only via presigned URLs.

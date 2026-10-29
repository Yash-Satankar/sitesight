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
│  │  │  │  ├─ concepts.ts    # segment targets → SAM prompt variants, IoU merge
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
               unit,                 -- 'nos' | 'm2' | 'm3' | 'rmt' | 'kg' | 'lot'
               planned_qty NUMERIC,
               measure_mode,         -- 'count' | 'area' | 'visual_only'
               segment_targets TEXT[], -- {'column'} | {'brickwork'} | {} (visual_only), see §7
               panel_planned_qty NUMERIC NULL, -- area items: planned qty in one photographed panel
               stages JSONB NULL,    -- visual_only items: [{name, weight}], weights sum to 1
               sequence_no INT NULL) -- for out-of-order detection (stretch)

visits        (id, project_id, visit_date,
               status,               -- see state machine §5
               created_at)

photos        (id, visit_id, zone_id, storage_key, width, height,
               voice_note_key NULL, transcript NULL,
               ask_back_id NULL,     -- set if uploaded in response to an ask-back
               created_at)

segments      (id, photo_id, concept, instance_idx,  -- concept = target name or reference prompt
               mask_key,             -- PNG mask in storage
               bbox JSONB, area_px INT, score REAL,
               verified BOOL NULL,   -- set by verify_segments; measure needs true
               reject_reason TEXT NULL)

assessments   (id, visit_id, boq_item_id,
               percent_complete REAL, qty_done NUMERIC NULL,
               confidence REAL,      -- 0..1
               rationale TEXT,
               deviation TEXT NULL,
               status,               -- 'proposed' | 'accepted' | 'edited'
               engineer_note TEXT NULL,
               stage_reached TEXT NULL, -- staged items: latest completed stage
               basis)                -- 'observed' | 'inferred' (hidden earlier-sequence work; not billable until observed)

assessment_evidence (assessment_id, photo_id, segment_ids INT[])

panel_measurements (id, visit_id, photo_id, run_id NULL, target_segment_ids INT[],
               panel JSONB,          -- column pair + y-range, or 4-point polygon
               panel_area_px INT, covered_area_px INT, fraction REAL,
               clipped BOOL, warnings JSONB, created_at)

ask_backs     (id, visit_id, zone_id, boq_item_id NULL,
               instruction TEXT, reason TEXT,
               status)               -- 'open' | 'fulfilled' | 'skipped'

agent_runs    (id, visit_id, status, steps INT,
               input_tokens INT, output_tokens INT, cost_usd NUMERIC,
               started_at, finished_at, error TEXT NULL)

agent_steps   (id, run_id, idx, kind,  -- 'model' | 'tool_call' | 'tool_result' | 'rejection' | 'error'
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
for turn in 1..MAX_AGENT_STEPS:                       # model turns only; tool calls in a turn do not count (default 30)
    if 4 turns are left: append the wrap-up message once (notice step "wrap_up")
    check visit budget (cost.ts) → abort with a cost_limit trace step if exhausted
    resp = spark.respond(messages, tools)
    trace(resp + usage + context size: input items, images in context)
    if no tool calls: nudge once (notice step), then fail the run
    for each tool call:
        validate args with zod → on failure return every issue with its path to the model
            ("Invalid arguments for verify_segments: decisions[1].reason: required when keep is false")
        result = handler(args); trace(result); trace(result.events)   # e.g. one `rejection` step per rejected segment
        if tool == finish: end run
    messages += tool results, then one image message per photo from view_photo
    for each photo fully verified this turn: replace its image messages with a text summary (compaction)
end: open ask-backs → needs_input · finish → assessed · out of turns → partial (assessments kept, visit goes to review)
```

### Step budget and wrap-up
The first real dry run spent all 25 turns verifying segments one call at a time and recorded nothing. Now:
- `MAX_AGENT_STEPS` counts model turns only, default 30.
- When 4 turns are left the loop sends: "Step budget nearly used. Record assessments for every BOQ item you have evidence for (mark others with low confidence or skip), then call finish."
- If the loop still ends without `finish`, the run is `partial` (not `failed`): recorded assessments are kept, the visit moves to `assessed` for review, and a `step_budget` notice says how many were kept. The worker does not retry it.

### Context compaction
Images dominate input tokens, and every turn resends the whole conversation. So:
- Mask/panel overlays from `view_photo` are resized to at most 1280 px on the long edge (plain photos stay at `MAX_IMAGE_EDGE_PX`). When an overlay is shrunk, the tool result says how to convert coordinates back to photo pixels.
- **Image budget:** at most one image per photo stays in the conversation — a new `view_photo` (incl. a panel preview) replaces that photo's older image with `[photo N: earlier image removed — a newer view follows]` — and at most `MAX_IMAGES_IN_CONTEXT` (default 3) images overall; beyond that the oldest is dropped with `[photo N: image dropped to save context — call view_photo again if you need it]`. Runs 2 and 3 grew input tokens with repeated previews of the same photo.
- Once `verify_segments` has decided every segment of a photo, its image message is replaced by a placeholder such as `[photo 2 image removed — verified: kept 2, 3, 4; rejected 1 (scaffolding pole). Call view_photo again to see it.]`. A new `view_photo` call sends the image again.
- Every model step logs input tokens and images in context (trace payload `context`, worker log, dry-run output) to show the effect.

### Segment targets (`concepts.ts`)
SAM only segments two **targets**. Each target runs every prompt variant listed for it; instances from different variants whose mask IoU > 0.5 are the same object, and the higher-score one is kept. Segments are stored under the target name, not the prompt.

| Target | SAM prompts | BOQ measure_mode |
|---|---|---|
| `column` | "concrete column" | `count` |
| `brickwork` | "exposed brick wall", "brickwork" | `area` |

Chosen from the day-1 spike (`pnpm sam-spike`, 19 site photos). Not segmented, because SAM was unreliable on them: **rebar** (best prompt hit 1/19 photos) and **slab** (best prompt 8/19, mean score 0.58). BOQ items for rebar, slabs and everything else without a target (plaster, openings, waterproofing, …) use `measure_mode = 'visual_only'`. `boq_items.segment_targets` links an item to its target; count/area items must have a matching target (enforced on BOQ parse and save).

### Verify before measure
SAM also finds things that look like the target: scaffolding poles, trees, steel columns, safety nets/tarps, neighbouring buildings. So every instance is checked by the agent before it counts:
1. `segment_photo(photo_id, targets)` → instances with segment ids, `verified = null`. For a photo it will segment, the agent segments first and skips a plain `view_photo`.
2. `view_photo(photo_id, with_masks=true)` → overlay labelled `#<segment_id> <target> <SAM score>`; rejected masks are hidden.
3. `verify_segments(photo_id, decisions)` → **one photo per call, covering all its segments**: a decision for every unverified segment of that photo, or the call is refused with the missing ids and nothing is saved. `reason` is required to reject (stored in `segments.reject_reason`) and optional to keep. Prompt rules: a keep with score < 0.6 needs a specific visual reason; no identical boilerplate reasons; duplicate/overlapping detections of the same element are rejected ("duplicate of #id"). Each rejection is its own `rejection` trace step. Ids from another photo fail the whole call.
4. `measure` only accepts segments with `verified = true`; otherwise it returns an error telling the model to verify first.

### Tools

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `list_boq_items` | `zone_id?` | items with unit, planned_qty, measure_mode, segment_targets | |
| `list_photos` | `zone_id?` | id, zone, transcript, has_segments | |
| `view_photo` | `photo_id`, `with_masks?: bool`, `draw_panel?: panel` | image (as input_image) + mask legend (segment id, target, score, verified) + panel size/warnings | Overlay drawn by `overlay.ts`, labels `#<segment_id> <target> <score>`, max 1280 px; rejected masks hidden; `draw_panel` outlines a panel so the model checks it before measuring |
| `segment_photo` | `photo_id`, `targets: ('column' \| 'brickwork')[]` | per target: instances with segment ids, areas_px, scores, verified | All prompt variants via SAM 3.1 (concurrent, budget-gated), IoU-merged, cached per (photo, target) |
| `verify_segments` | `photo_id`, `decisions: [{segment_id, keep, reason?}]` | kept, rejected, unverified_remaining | Must cover every unverified segment of the photo; reason required to reject; all-or-nothing; triggers context compaction for the photo |
| `measure` | `photo_id`, `mode: 'panel' | 'reference'`; panel: `target_segment_ids`, `panel`; reference: `segment_ids`, `reference: 'a4' | 'tape_1m' | 'brick'` | panel: `measurement_id`, panel_area_px, covered_area_px, fraction, clipped, warnings. reference: count, area_m2 (approx), scale_confidence | Pure code, no model. Verified segments only. Panel results stored in `panel_measurements` |
| `get_previous_assessment` | `boq_item_id` | last accepted assessment | |
| `record_assessment` | `boq_item_id, percent_complete, qty_done?, panel_measurement_ids?, panel_measurement_id?, confidence, rationale, evidence: [{photo_id, segment_ids}], deviation?` | ok, qty_done, qty_basis | Upsert per visit. qty_done is computed by code (panel: Σ fractions × panel_planned_qty; visual: percent × planned_qty); model value used only for count items. Panel photos + targets added to evidence |
| `request_photo` | `zone_id, boq_item_id?, instruction, reason` | ask_back_id | Must be doable with only a phone ("square-on photo of the whole bay between columns X and Y, including the beam above and the plinth below"); requests mentioning tapes, A4 sheets or measuring tools are refused |
| `finish` | `summary` | — | Ends run |

### Measurement approach (`services/measure.ts`)
- **count** items (columns): verified `column` instances, deduped across photos of the same zone by asking Spark to confirm overlaps.
- **area** items (brickwork), **panel mode (default)**: measure what fraction of one wall panel is covered, which needs no real-world scale. The day-1 spike found no usable scale reference (no tape or A4 hit in any of 19 photos), so this replaced the reference path as the default.
  - **A panel is the FULL designed wall area of ONE bay**: between two cast columns, from the top of the plinth (`bottom_y`) to the underside of the beam/slab above (`top_y`). It is never drawn around the existing masonry only (that always gives ~100%). If the bay's beam/slab or columns are not visible or not built yet, panel mode is not used: the agent records a visual estimate, confidence ≤ 0.5 (enforced for area items without a panel measurement), and says why.
  - At most 2 `draw_panel` previews per photo per run; the second says it is the last, a third is refused with "measure now or move on".
  - Panel = the space between two **verified** `column` segments (x-bounds = each row's inner edges of the two column masks, so leaning columns are followed; y from `top_y` to `bottom_y` in image pixels), or a model-provided 4-point polygon. Pixel rules are shared so both forms agree: columns cover `x ∈ [inner edge L, inner edge R)`, `y ∈ [top_y, bottom_y)`; a polygon covers pixels whose centre is inside it.
  - `covered = |union(target masks) ∩ panel|`, `fraction = covered / panel_area`. `clipped` when the panel ran past the image edge.
  - Warnings: panel < 2% of the image; fraction > 0.98 (panel likely drawn too small); target mask mostly (> 25%) or entirely outside the panel; crossed polygon corners (reordered); columns given right-to-left (swapped).
  - Workflow: `view_photo(draw_panel)` to check the panel → `measure(mode='panel')` once per visible bay → `record_assessment(panel_measurement_ids)`. Code computes `qty_done = Σ fraction_i × panel_planned_qty` (planned quantity inside one bay), capped at `planned_qty`. Several bays need `panel_planned_qty`; the same panel twice is refused. A single bay without `panel_planned_qty` uses `planned_qty` (noted in the result). `panel_measurement_id` (single) still works. The model supplies percent_complete only and never does the arithmetic; a model-supplied qty_done is ignored, and a percent far from the implied one is flagged.
  - Limitation: the fraction is in image space, so a panel seen at a steep angle over- or under-weights near/far parts. Ask for a square-on photo when that matters.
- **area** items, **reference mode (optional)**: segment a reference object (A4 sheet = 0.0624 m², 1 m tape, brick) → px²→m² ratio → apply to verified `brickwork` masks. Ignores perspective, so `scale_confidence` drops if the reference is far from the target or heavily skewed. Only useful when a reference is clearly in shot.
- **visual_only** items (rebar, slab, plaster, openings, …): Spark judges stage from the image (e.g. "shuttering done, not cast") and gives percent_complete only; code computes `qty_done = percent/100 × planned_qty` and ignores a model-supplied value. Confidence is capped at 0.7. Area items without a panel measurement get the same percent-based qty, capped at confidence 0.5. Count items keep the model's count.
- **Staged items** (`boq_items.stages`, e.g. slab: shuttering 0.25 → reinforcement 0.35 → concreting 0.40; visual_only only, weights sum to 1, names unique, "none" reserved): the agent passes `stage_reached` = the latest COMPLETED stage (or "none") and names it with its evidence in the rationale. Code sets `percent_complete` = cumulative weight up to and including that stage and `qty_done = percent × planned_qty`; a model-supplied percent is ignored and noted. The BOQ review page shows stages read-only for now.
- **Previous visits:** the agent context lists `previous_visit_assessments` (latest engineer-accepted assessment per item from other visits; `get_previous_assessment` also returns `stage_reached`). The rationale states what changed. If progress is lower than the previous accepted value, code records it as a deviation (`Progress went backwards: 60% (reinforcement) at the visit of …, now 25% (shuttering).`), appended to any deviation the model gave.
- **Evidence basis:** assessments are `observed` (default: visible in this visit's photos) or `inferred`. `inferred` is only allowed for an item whose `sequence_no` is lower than an item already recorded as observed in this visit (e.g. footings under a cast plinth beam); the rationale must name that observed item, confidence is capped at 0.5, and panel measurements cannot be cited. Inferred items show as "inferred — not billable until observed" in the dry-run table/JSON, the review page and the PDF; the PDF's bill summary lists observed quantities only and puts inferred items in their own section.
- **Ask-backs across visits:** one open request per BOQ item per project. `request_photo` for an item that already has an open ask-back (from any visit) returns that one with a note instead of creating another. Open ask-backs from earlier visits are listed in the agent's starting context (`open_ask_backs_from_earlier_visits`). A photo from any visit of the project can fulfil an ask-back: from the same visit it re-runs that visit as before; from a later visit it closes the request and, if the earlier visit was only waiting on requests, moves it to `assessed` (the new photo is assessed by the later visit).
- **Material check:** the agent compares the visible material with the BOQ spec (clay brick vs concrete/fly-ash block vs AAC, …); on mismatch it still assesses progress but sets `deviation`.
- **Floor scoping:** a BOQ item covers only the floor/element it names; work on other floors is not credited to it.
- **Results:** an item with no assessment but an open ask-back reports `awaiting photo (ask-back #N)` (dry-run table and JSON, PDF "Awaiting photos" section; `lib/item-status.ts`).

### System prompt principles (`prompts.ts`)
- You are a site progress auditor. Every claim must cite photo + segment evidence.
- `segment_photo` only finds the targets above; everything else is visual_only.
- After segmenting, view the masks and verify every instance; reject scaffolding poles, trees, steel columns, nets/tarps and anything not part of the structure being assessed, with a short reason.
- Use verified segments + `measure` over eyeballing whenever measure_mode is count/area.
- If confidence < `ASK_BACK_THRESHOLD`, call `request_photo` with a phone-only instruction a site engineer can follow in 30 seconds; never ask for tapes, A4 sheets or measuring tools.
- Compare visible materials with the BOQ spec and set `deviation` on mismatch; credit work only to the floor/element an item names.
- Never invent BOQ items, photo ids or segment ids. Never exceed 100%.

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
POST   /ask-backs/:id/fulfil             { photoId } (any visit of the project) → re-enqueue when all resolved
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
MAX_AGENT_STEPS=30            # model turns per run; tool calls do not count
MAX_COST_PER_VISIT_USD=1.50
ASK_BACK_THRESHOLD=0.6
MAX_IMAGE_EDGE_PX=1600
SAM_CONCURRENCY=3            # parallel SAM requests per segment() call
MAX_IMAGES_IN_CONTEXT=3      # images kept in the agent conversation; oldest dropped

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
5. **Ask-back (25s):** "Square-on photo of the whole bay between columns C3 and C4, including the beam above and the plinth below" → upload → panel measured, confidence jumps.
6. **Report (20s):** bill-ready PDF with evidence crops.
7. **Meta stack + impact (25s):** Muse Spark 1.3 + SAM 3.1 + Voice Transcribe (+ built with Muse Code); who it helps and what it costs per visit.

---

## 13. Data handling

- Contractor's written OK before using real photos/BOQs.
- Strip client names, rates, and addresses from `samples/` and the demo. Hackathon rules grant organisers a perpetual licence to anything shared.
- Never commit `.env`. The R2 bucket is private; access only via presigned URLs.

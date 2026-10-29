/**
 * Turns raw agent trace steps into readable cards for the live trace (the demo's centrepiece).
 * Pure: the web app renders the cards; the API tests cover the wording.
 */

export type CardTone = "neutral" | "agent" | "rejection" | "assessment" | "askback" | "notice" | "error";

export interface TraceCard {
  /** Id of the step the card was built from (the tool result for tool cards). */
  id: number;
  tone: CardTone;
  title: string;
  subtitle?: string;
  /** Thumbnail: the photo with these masks / panels drawn (GET /photos/:id/overlay). */
  overlay?: { photoId: number; segmentIds?: number[]; panelIds?: number[] };
  /** Raw payloads for the "details" toggle. */
  details: { args?: unknown; result?: unknown };
}

export interface TraceStepLike {
  id: number;
  kind: string;
  name: string | null;
  payload?: unknown;
}

export interface CardContext {
  /** BOQ code for an item id (e.g. "SLB-GF"), if known. */
  itemCode?: (boqItemId: number) => string | undefined;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;

export function truncateText(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

const TARGET_LABEL: Record<string, string> = { column: "columns", brickwork: "brickwork" };

/** Build cards from steps in order. tool_call steps are folded into the card of their result. */
export function buildTraceCards(steps: TraceStepLike[], ctx: CardContext = {}): TraceCard[] {
  const cards: TraceCard[] = [];
  const pendingArgs = new Map<string, unknown[]>();
  const code = (id: unknown) => (typeof id === "number" ? (ctx.itemCode?.(id) ?? `item #${id}`) : "item");

  for (const step of steps) {
    const p = obj(step.payload);
    switch (step.kind) {
      case "tool_call": {
        const list = pendingArgs.get(step.name ?? "") ?? [];
        list.push(step.payload);
        pendingArgs.set(step.name ?? "", list);
        break;
      }
      case "tool_result": {
        const args = obj(pendingArgs.get(step.name ?? "")?.shift());
        cards.push(toolCard(step, step.name ?? "tool", args, p, code));
        break;
      }
      case "model": {
        const text = str(p.text)?.trim();
        if (text) cards.push({ id: step.id, tone: "agent", title: truncateText(text, 160), details: { result: step.payload } });
        break;
      }
      case "rejection":
        cards.push({
          id: step.id,
          tone: "rejection",
          title: `Rejected #${num(p.segment_id) ?? "?"}: ${str(p.reason) ?? "no reason"}`,
          subtitle: `${str(p.target) ?? "segment"} on photo ${num(p.photo_id) ?? "?"}`,
          details: { result: step.payload },
        });
        break;
      case "notice":
        cards.push({ id: step.id, tone: "notice", ...noticeText(step.name, p), details: { result: step.payload } });
        break;
      case "error":
        cards.push({
          id: step.id,
          tone: "error",
          title: step.name === "cost_limit" ? "Stopped: cost limit reached" : "Run stopped by an error",
          subtitle: str(p.message),
          details: { result: step.payload },
        });
        break;
    }
  }
  return cards;
}

function toolCard(step: TraceStepLike, name: string, a: Obj, r: Obj, code: (id: unknown) => string): TraceCard {
  const base = { id: step.id, details: { args: a, result: r } };
  if (typeof r.error === "string") {
    return { ...base, tone: "error", title: `${name.replace(/_/g, " ")} failed`, subtitle: truncateText(r.error, 220) };
  }
  const photoId = num(a.photo_id) ?? num(r.photo_id);

  switch (name) {
    case "list_boq_items":
      return { ...base, tone: "neutral", title: "Read the BOQ", subtitle: plural(Array.isArray(step.payload) ? step.payload.length : 0, "item") };
    case "list_photos":
      return { ...base, tone: "neutral", title: "Listed the photos", subtitle: plural(Array.isArray(step.payload) ? step.payload.length : 0, "photo") };
    case "view_photo": {
      const legend = (Array.isArray(r.mask_legend) ? r.mask_legend : []).map((l) => num(obj(l).segment_id)).filter((x): x is number => x != null);
      const extra = a.draw_panel ? " with a panel preview" : a.with_masks ? " with masks" : "";
      return {
        ...base,
        tone: "neutral",
        title: `Looking at photo ${photoId ?? "?"}${extra}`,
        overlay: a.with_masks && photoId != null && legend.length ? { photoId, segmentIds: legend } : undefined,
      };
    }
    case "segment_photo": {
      const targets = Array.isArray(r.targets) ? r.targets.map(obj) : [];
      const asked = (Array.isArray(a.targets) ? a.targets : targets.map((t) => t.target)).map((t) => TARGET_LABEL[String(t)] ?? String(t));
      const found = targets.map((t) => `${(Array.isArray(t.instances) ? t.instances : []).length} ${TARGET_LABEL[String(t.target)] ?? String(t.target)}`);
      const segIds = targets.flatMap((t) => (Array.isArray(t.instances) ? t.instances : []).map((i) => num(obj(i).segment_id))).filter((x): x is number => x != null);
      return {
        ...base,
        tone: "neutral",
        title: `Segmenting photo ${photoId ?? "?"} — ${asked.join(", ")}`,
        subtitle: found.length ? `found ${found.join(", ")}` : undefined,
        overlay: photoId != null && segIds.length ? { photoId, segmentIds: segIds } : undefined,
      };
    }
    case "verify_segments": {
      const kept = ids(r.kept);
      const rejected = ids(r.rejected);
      return {
        ...base,
        tone: "neutral",
        title: `Verified photo ${photoId ?? "?"}: kept ${kept.length}, rejected ${rejected.length}`,
        overlay: photoId != null && kept.length ? { photoId, segmentIds: kept } : undefined,
      };
    }
    case "measure": {
      if (r.mode === "panel") {
        const warnings = (Array.isArray(r.warnings) ? r.warnings : []).map(String);
        const measurementId = num(r.measurement_id);
        return {
          ...base,
          tone: "neutral",
          title: `Measured panel: ${pct(num(r.fraction) ?? 0)} filled`,
          subtitle: warnings.length ? truncateText(warnings.join(" · "), 220) : undefined,
          overlay:
            photoId != null ? { photoId, segmentIds: ids(a.target_segment_ids), panelIds: measurementId != null ? [measurementId] : [] } : undefined,
        };
      }
      const area = num(r.area_m2);
      return {
        ...base,
        tone: "neutral",
        title: `Measured: ${plural(num(r.count) ?? 0, "instance")}${area != null ? `, ${area} m²` : ""}`,
        overlay: photoId != null ? { photoId, segmentIds: ids(a.segment_ids) } : undefined,
      };
    }
    case "record_assessment": {
      const percent = num(r.percent_complete) ?? num(a.percent_complete);
      const stage = str(r.stage_reached) ?? str(a.stage_reached);
      const inferred = (r.basis ?? a.basis) === "inferred";
      const qty = num(r.qty_done);
      const head = stage ? `${code(a.boq_item_id)} → ${stage} stage (${percent ?? "?"}%)` : `${code(a.boq_item_id)} → ${percent ?? "?"}%`;
      return {
        ...base,
        tone: "assessment",
        title: `${head}${inferred ? " · inferred" : ""}`,
        subtitle: truncateText(
          [qty != null ? `qty ${qty}` : null, num(r.confidence) != null ? `confidence ${num(r.confidence)}` : null, str(a.rationale)].filter(Boolean).join(" · "),
          220,
        ),
      };
    }
    case "request_photo": {
      const instruction = str(r.instruction) ?? str(a.instruction) ?? "";
      return {
        ...base,
        tone: "askback",
        title: r.reused ? `Photo request already open: ${truncateText(instruction, 140)}` : `Requested photo: ${truncateText(instruction, 140)}`,
        subtitle: str(a.reason) ? `why: ${truncateText(String(a.reason), 160)}` : undefined,
      };
    }
    case "get_previous_assessment":
      return {
        ...base,
        tone: "neutral",
        title: r.found
          ? `Checked last visit: ${code(a.boq_item_id)} was ${num(r.percent_complete) ?? "?"}%${str(r.stage_reached) ? ` (${r.stage_reached})` : ""}`
          : `Checked last visit: no accepted assessment of ${code(a.boq_item_id)}`,
      };
    case "finish":
      return { ...base, tone: "notice", title: "Finished", subtitle: str(a.summary) ?? str(r.summary) };
    default:
      return { ...base, tone: "neutral", title: name.replace(/_/g, " ") };
  }
}

function noticeText(name: string | null, p: Obj): { title: string; subtitle?: string } {
  switch (name) {
    case "wrap_up":
      return { title: "Step budget nearly used: wrapping up", subtitle: str(p.message) };
    case "context_compacted":
      return { title: "Photo verified: image replaced by a summary", subtitle: str(p.message) };
    case "images_trimmed":
      return { title: "Trimmed older images from the conversation", subtitle: str(p.message) };
    case "nudge":
      return { title: "Nudged the agent to keep using tools" };
    case "step_budget":
      return { title: "Stopped: step budget used", subtitle: str(p.message) };
    default:
      return { title: str(p.message) ?? name ?? "notice" };
  }
}

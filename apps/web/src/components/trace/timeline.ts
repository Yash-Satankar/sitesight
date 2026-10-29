/**
 * Pure display helper: agent trace steps → human-language timeline items for the live trace.
 * A tool call appears immediately as "in progress" and is completed in place by its result;
 * rejections are folded into the verify card they belong to.
 */
import type { Tone } from "../ui";

export interface TraceStep {
  id: number;
  runId?: number;
  idx?: number;
  kind: string;
  name: string | null;
  payload?: unknown;
}

export type StepIcon = "boq" | "photos" | "view" | "search" | "verify" | "measure" | "assess" | "request" | "history" | "finish" | "error" | "note";

export interface Rejection {
  segmentId: number | null;
  reason: string;
}

export interface TimelineItem {
  id: number;
  type: "thinking" | "note" | "step";
  tone: Tone;
  icon: StepIcon;
  title: string;
  /** Result line under the title ("Found 3 columns, 3 brickwork areas"). */
  result?: string;
  /** Longer text, clamped (rationale, error message). */
  body?: string;
  /** Small metadata line (qty, confidence). */
  meta?: string;
  chip?: { tone: Tone; label: string };
  rejections?: Rejection[];
  overlay?: { photoId: number; segmentIds: number[]; panelIds: number[] };
  pending?: boolean;
  details: { steps: string[]; args?: unknown; result?: unknown };
}

export interface TimelineContext {
  itemCode?: (boqItemId: number) => string | undefined;
  /** "photo 2": position within the visit. */
  photoName?: (photoId: number) => string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
const round = (n: number) => Math.round(n * 10) / 10;

const TARGET: Record<string, [string, string]> = {
  column: ["column", "columns"],
  brickwork: ["brickwork area", "brickwork areas"],
};
const plural = (n: number, target: string) => {
  const [one, many] = TARGET[target] ?? [target, `${target}s`];
  return `${n} ${n === 1 ? one : many}`;
};
const targetNoun = (t: string) => (t === "brickwork" ? "brickwork" : (TARGET[t]?.[1] ?? t));
const joinAnd = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const stepRef = (s: TraceStep) => `${s.kind}${s.name ? ` ${s.name}` : ""} · step ${s.idx ?? "?"}${s.runId != null ? ` · run ${s.runId}` : ""} · id ${s.id}`;

export function buildTimeline(steps: TraceStep[], ctx: TimelineContext = {}): TimelineItem[] {
  const items: TimelineItem[] = [];
  const pending = new Map<string, { item: TimelineItem; args: Obj }[]>();
  const code = (id: unknown) => (typeof id === "number" ? (ctx.itemCode?.(id) ?? `Item #${id}`) : "an item");
  const photo = (id: number | null) => (id == null ? "a photo" : (ctx.photoName?.(id) ?? `photo #${id}`));

  for (const step of steps) {
    const p = obj(step.payload);
    switch (step.kind) {
      case "tool_call": {
        const name = step.name ?? "tool";
        const item: TimelineItem = { id: step.id, type: "step", pending: true, details: { steps: [stepRef(step)], args: step.payload }, ...describe(name, p, undefined, code, photo) };
        items.push(item);
        const q = pending.get(name) ?? [];
        q.push({ item, args: p });
        pending.set(name, q);
        break;
      }
      case "tool_result": {
        const name = step.name ?? "tool";
        const open = pending.get(name)?.shift();
        const args = open?.args ?? {};
        const done = describe(name, args, step.payload, code, photo);
        if (open) {
          const keep = open.item.rejections;
          Object.assign(open.item, done, { pending: false });
          if (keep?.length && !done.rejections) open.item.rejections = keep;
          open.item.details = { steps: [...open.item.details.steps, stepRef(step)], args, result: step.payload };
        } else {
          items.push({ id: step.id, type: "step", details: { steps: [stepRef(step)], result: step.payload }, ...done });
        }
        break;
      }
      case "rejection": {
        const rej = { segmentId: num(p.segment_id), reason: str(p.reason) ?? "no reason given" };
        const verify = pending.get("verify_segments")?.find((v) => num(v.args.photo_id) == null || num(v.args.photo_id) === num(p.photo_id));
        if (verify) {
          verify.item.rejections = [...(verify.item.rejections ?? []), rej];
          verify.item.details.steps.push(stepRef(step));
        } else {
          items.push({
            id: step.id,
            type: "step",
            tone: "attention",
            icon: "verify",
            title: `Rejected ${rej.segmentId != null ? `#${rej.segmentId}` : "a detection"}: ${rej.reason}`,
            result: `${str(p.target) ?? "detection"} in ${photo(num(p.photo_id))}`,
            details: { steps: [stepRef(step)], result: step.payload },
          });
        }
        break;
      }
      case "model": {
        const text = str(p.text);
        if (text) items.push({ id: step.id, type: "thinking", tone: "neutral", icon: "note", title: text, details: { steps: [stepRef(step)], result: step.payload } });
        break;
      }
      case "notice":
        items.push({ id: step.id, type: "note", tone: "neutral", icon: "note", ...noticeCopy(step.name, p), details: { steps: [stepRef(step)], result: step.payload } });
        break;
      case "error":
        items.push({
          id: step.id,
          type: "step",
          tone: "error",
          icon: "error",
          title: step.name === "cost_limit" ? "Stopped: cost limit reached" : "The run stopped because of an error",
          body: str(p.message) ?? undefined,
          details: { steps: [stepRef(step)], result: step.payload },
        });
        break;
    }
  }
  return items;
}

type Copy = Pick<TimelineItem, "tone" | "icon" | "title" | "result" | "body" | "meta" | "chip" | "rejections" | "overlay">;

/** Tool messages name photos by database id ("Photo 3 has…"); show the visit's numbering instead. */
function photoRefs(text: string, photo: (id: number | null) => string): string {
  return text.replace(/\b([Pp])hoto #?(\d+)\b/g, (_m, p: string, id: string) => {
    const name = photo(Number(id));
    return p === "P" ? cap(name) : name;
  });
}

function describe(name: string, a: Obj, rawResult: unknown, code: (id: unknown) => string, photo: (id: number | null) => string): Copy {
  const done = rawResult !== undefined;
  const r = obj(rawResult);
  const photoId = num(a.photo_id) ?? num(r.photo_id);

  if (done && typeof r.error === "string") {
    return { tone: "error", icon: "error", title: `Couldn't ${VERB[name]?.(photo(photoId)) ?? name.replace(/_/g, " ")}`, body: photoRefs(r.error, photo) };
  }

  switch (name) {
    case "list_boq_items": {
      const n = Array.isArray(rawResult) ? rawResult.length : null;
      return { tone: "neutral", icon: "boq", title: done && n != null ? `Reading the BOQ — ${n} item${n === 1 ? "" : "s"}` : "Reading the BOQ…" };
    }
    case "list_photos": {
      const n = Array.isArray(rawResult) ? rawResult.length : null;
      return { tone: "neutral", icon: "photos", title: done && n != null ? `Found ${n} photo${n === 1 ? "" : "s"} in this visit` : "Listing this visit's photos…" };
    }
    case "view_photo":
      return { tone: "neutral", icon: "view", title: `Looking at ${photo(photoId)}${a.draw_panel ? " with the bay outlined" : a.with_masks ? " with its detections" : ""}${done ? "" : "…"}` };
    case "get_previous_assessment": {
      if (!done) return { tone: "neutral", icon: "history", title: `Checking last visit for ${code(a.boq_item_id)}…` };
      const pct = num(r.percent_complete);
      const stage = str(r.stage_reached);
      return {
        tone: "neutral",
        icon: "history",
        title: r.found ? `Checked last visit — ${code(a.boq_item_id)} was ${pct != null ? `${round(pct)}%` : "assessed"}${stage ? ` (${stage})` : ""}` : `Checked last visit — no earlier record of ${code(a.boq_item_id)}`,
      };
    }
    case "segment_photo": {
      const results = Array.isArray(r.targets) ? r.targets.map(obj) : [];
      const asked = (Array.isArray(a.targets) ? a.targets.map(String) : results.map((t) => String(t.target))).map(targetNoun);
      const title = `Looking for ${joinAnd(asked) || "objects"} in ${photo(photoId)}${done ? "" : "…"}`;
      if (!done) return { tone: "neutral", icon: "search", title };
      const counts = results.map((t) => plural(Array.isArray(t.instances) ? t.instances.length : 0, String(t.target)));
      const segIds = results.flatMap((t) => (Array.isArray(t.instances) ? t.instances : []).map((i) => num(obj(i).segment_id))).filter((x): x is number => x != null);
      return {
        tone: "neutral",
        icon: "search",
        title,
        result: counts.length ? `Found ${counts.join(", ")}` : "Found nothing",
        overlay: photoId != null && segIds.length ? { photoId, segmentIds: segIds, panelIds: [] } : undefined,
      };
    }
    case "verify_segments": {
      if (!done) return { tone: "neutral", icon: "verify", title: `Checking the detections in ${photo(photoId)}…` };
      const kept = ids(r.kept);
      const rejected = ids(r.rejected);
      return {
        tone: "neutral",
        icon: "verify",
        title: `Checked ${kept.length + rejected.length} detection${kept.length + rejected.length === 1 ? "" : "s"} — kept ${kept.length}, rejected ${rejected.length}`,
        result: cap(photo(photoId)),
        overlay: photoId != null && kept.length ? { photoId, segmentIds: kept, panelIds: [] } : undefined,
      };
    }
    case "measure": {
      const mode = str(r.mode) ?? str(a.mode);
      if (!done) return { tone: "neutral", icon: "measure", title: mode === "panel" ? `Measuring a bay in ${photo(photoId)}…` : `Measuring ${photo(photoId)}…` };
      if (mode === "panel") {
        const warnings = (Array.isArray(r.warnings) ? r.warnings : []).map(String);
        const mid = num(r.measurement_id);
        return {
          tone: "neutral",
          icon: "measure",
          title: `Measured bay: ${Math.round((num(r.fraction) ?? 0) * 100)}% built`,
          result: cap(photo(photoId)),
          body: warnings.length ? photoRefs(warnings.join(" · "), photo) : undefined,
          overlay: photoId != null ? { photoId, segmentIds: ids(a.target_segment_ids), panelIds: mid != null ? [mid] : [] } : undefined,
        };
      }
      const count = num(r.count) ?? 0;
      const area = num(r.area_m2);
      return {
        tone: "neutral",
        icon: "measure",
        title: `Counted ${count} instance${count === 1 ? "" : "s"}${area != null ? ` · about ${area} m²` : ""}`,
        result: cap(photo(photoId)),
        overlay: photoId != null && ids(a.segment_ids).length ? { photoId, segmentIds: ids(a.segment_ids), panelIds: [] } : undefined,
      };
    }
    case "record_assessment": {
      const pct = num(r.percent_complete) ?? num(a.percent_complete);
      const stage = str(r.stage_reached) ?? str(a.stage_reached);
      const inferred = (r.basis ?? a.basis) === "inferred";
      const head = `${code(a.boq_item_id)} → ${stage ? `${cap(stage)} stage · ` : ""}${pct != null ? `${round(pct)}%` : "?"}`;
      if (!done) return { tone: "neutral", icon: "assess", title: `Recording ${code(a.boq_item_id)}…` };
      const qty = num(r.qty_done);
      const conf = num(r.confidence);
      return {
        tone: inferred ? "attention" : "done",
        icon: "assess",
        title: head,
        chip: inferred ? { tone: "attention", label: "Inferred — not billable" } : { tone: "done", label: "Observed" },
        body: str(a.rationale) ?? undefined,
        meta: [qty != null ? `qty ${qty}` : null, conf != null ? `confidence ${Math.round(conf * 100)}%` : null].filter(Boolean).join(" · ") || undefined,
      };
    }
    case "request_photo": {
      const instruction = str(r.instruction) ?? str(a.instruction) ?? "a photo";
      return {
        tone: "waiting",
        icon: "request",
        title: instruction,
        chip: { tone: "waiting", label: r.reused ? "Already requested" : done ? "Photo requested" : "Requesting a photo…" },
        body: str(a.reason) ? `Why: ${a.reason}` : undefined,
      };
    }
    case "finish":
      return { tone: "done", icon: "finish", title: done ? "Finished" : "Finishing…", body: str(a.summary) ?? str(r.summary) ?? undefined };
    default:
      return { tone: "neutral", icon: "note", title: `${cap(name.replace(/_/g, " "))}${done ? "" : "…"}` };
  }
}

const VERB: Record<string, (photo: string) => string> = {
  segment_photo: (p) => `look for objects in ${p}`,
  verify_segments: (p) => `check the detections in ${p}`,
  measure: (p) => `measure ${p}`,
  view_photo: (p) => `open ${p}`,
  record_assessment: () => "record the assessment",
  request_photo: () => "request the photo",
  get_previous_assessment: () => "read last visit",
  list_boq_items: () => "read the BOQ",
  list_photos: () => "list the photos",
};

function noticeCopy(name: string | null, p: Obj): { title: string; body?: string } {
  switch (name) {
    case "wrap_up":
      return { title: "Step budget nearly used — wrapping up" };
    case "context_compacted":
      return { title: "Photo checked — kept a text summary instead of the image" };
    case "images_trimmed":
      return { title: "Dropped older images to stay within limits" };
    case "nudge":
      return { title: "Reminded the agent to keep using its tools" };
    case "step_budget":
      return { title: "Stopped: step budget used up" };
    default:
      return { title: str(p.message) ?? name ?? "Note" };
  }
}

import { z } from "zod";

/** One BOQ item's state in a visit, as compared by progressRows. */
export interface ProgressInput {
  code: string;
  description: string;
  status: string;
  assessment: { percentComplete: number; stageReached: string | null } | null;
}

export const ProgressRow = z.object({
  code: z.string(),
  description: z.string(),
  previous: z.string(),
  now: z.string(),
  change: z.string(),
  /** Percentage points gained since the previous visit (null if not assessed in both). */
  delta: z.number().nullable(),
});
export type ProgressRow = z.infer<typeof ProgressRow>;

/** Compare each BOQ item between two visits (same item order as `now`). Shared by the dry run and the visit summary. */
export function progressRows(previous: ProgressInput[], now: ProgressInput[]): ProgressRow[] {
  const cell = (x: ProgressInput | undefined) =>
    !x ? "—" : x.assessment ? `${round1(x.assessment.percentComplete)}%${x.assessment.stageReached ? ` (${x.assessment.stageReached})` : ""}` : x.status;
  return now.map((n) => {
    const p = previous.find((x) => x.code === n.code);
    let change: string;
    let delta: number | null = null;
    if (p?.assessment && n.assessment) {
      delta = round1(n.assessment.percentComplete - p.assessment.percentComplete);
      change = delta > 0.5 ? `+${delta} pts` : delta < -0.5 ? `${delta} pts, went backwards (deviation)` : "no change";
    } else if (n.assessment) change = "new";
    else if (p?.assessment) change = "not assessed this visit";
    else change = "—";
    return { code: n.code, description: n.description, previous: cell(p), now: cell(n), change, delta };
  });
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

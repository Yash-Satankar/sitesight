import type { Assessment } from "@sitesight/shared";
import { Chip, type Tone } from "./ui";

/**
 * The single status chip for an assessment, by priority: awaiting a requested photo (blue) → inferred, not billable
 * (amber) → accepted / edited (green) → still to review (slate).
 */
export function assessmentStatus(a: Pick<Assessment, "status" | "basis">, awaitingPhoto: boolean): { tone: Tone; label: string } {
  if (awaitingPhoto) return { tone: "waiting", label: "Awaiting photo" };
  if (a.basis === "inferred") return { tone: "attention", label: "Inferred — not billable" };
  if (a.status === "accepted") return { tone: "done", label: "Accepted" };
  if (a.status === "edited") return { tone: "done", label: "Edited" };
  return { tone: "neutral", label: "To review" };
}

export function AssessmentChip({ assessment, awaitingPhoto = false }: { assessment: Pick<Assessment, "status" | "basis">; awaitingPhoto?: boolean }) {
  const s = assessmentStatus(assessment, awaitingPhoto);
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

/**
 * One line of status for a BOQ item after an agent run, shared by the dry-run table, its JSON report and the PDF.
 * An item without an assessment but with an open photo request is "awaiting photo (ask-back #N)".
 */
export function boqItemStatus(assessed: boolean, openAskBackIds: number[]): string {
  const refs = openAskBackIds.length ? `ask-back ${openAskBackIds.map((id) => `#${id}`).join(", ")}` : null;
  if (!assessed) return refs ? `awaiting photo (${refs})` : "not assessed";
  return refs ? `assessed (${refs} open)` : "assessed";
}

export interface PendingItem {
  code: string;
  description: string;
  status: string;
  instruction: string;
}

/** BOQ items that have no assessment yet but an open photo request aimed at them. */
export function pendingItems(
  items: { id: number; code: string; description: string }[],
  assessedItemIds: Set<number>,
  askBacks: { id: number; boqItemId: number | null; status: string; instruction: string }[],
): PendingItem[] {
  return items.flatMap((it) => {
    if (assessedItemIds.has(it.id)) return [];
    const open = askBacks.filter((a) => a.boqItemId === it.id && a.status === "open");
    if (!open.length) return [];
    return [{ code: it.code, description: it.description, status: boqItemStatus(false, open.map((a) => a.id)), instruction: open[0]!.instruction }];
  });
}

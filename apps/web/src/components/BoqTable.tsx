import type { BoqItem } from "@sitesight/shared";

export function BoqTable({ items, progress }: { items: BoqItem[]; progress: Record<string, number> }) {
  if (!items.length) return <p className="text-sm text-gray-500">No BOQ items yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-gray-500">
          <tr>
            <th className="py-2 pr-3">Code</th>
            <th className="py-2 pr-3">Description</th>
            <th className="py-2 pr-3">Qty</th>
            <th className="py-2 pr-3">Mode</th>
            <th className="w-48 py-2">Progress</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((it) => {
            const pct = progress[String(it.id)];
            return (
              <tr key={it.id}>
                <td className="py-2 pr-3 font-mono text-xs">{it.code}</td>
                <td className="py-2 pr-3">{it.description}</td>
                <td className="whitespace-nowrap py-2 pr-3">
                  {it.plannedQty} {it.unit}
                </td>
                <td className="py-2 pr-3 text-xs text-gray-500">{it.measureMode}</td>
                <td className="py-2">
                  <ProgressBar pct={pct} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ProgressBar({ pct }: { pct: number | undefined }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <span className="w-10 text-right text-xs text-gray-600">{pct != null ? `${Math.round(pct)}%` : "—"}</span>
    </div>
  );
}

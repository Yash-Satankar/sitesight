import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MeasureMode, Unit, type BoqItemInput } from "@sitesight/shared";
import { api } from "../lib/api";
import { ErrorNote } from "../components/Layout";

export function BoqReviewPage() {
  const projectId = Number(useParams().projectId);
  const [items, setItems] = useState<BoqItemInput[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.parseBoq(projectId, file);
      setItems(res.items);
      setWarnings(res.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!items) return;
    setBusy(true);
    try {
      await api.saveBoq(projectId, items);
      navigate(`/projects/${projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  const update = (i: number, patch: Partial<BoqItemInput>) =>
    setItems((prev) => prev && prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">BOQ review</h1>
      <div className="card">
        <label className="block text-sm">
          <span className="mb-1 block text-gray-600">Upload the BOQ (.xlsx). Muse Spark parses it into line items.</span>
          <input type="file" accept=".xlsx" disabled={busy} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        {busy && !items && <p className="mt-2 text-sm text-gray-500">Parsing…</p>}
      </div>
      <ErrorNote error={error} />
      {warnings.length > 0 && (
        <ul className="rounded-lg bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}

      {items && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="p-1">Code</th>
                <th className="p-1">Description</th>
                <th className="p-1">Unit</th>
                <th className="p-1">Planned qty</th>
                <th className="p-1">Measure mode</th>
                <th className="p-1">SAM concepts (comma-separated)</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="align-top">
                  <td className="p-1 font-mono text-xs">{it.code}</td>
                  <td className="p-1">{it.description}</td>
                  <td className="p-1">
                    <select className="input" value={it.unit} onChange={(e) => update(i, { unit: e.target.value as Unit })}>
                      {Unit.options.map((u) => (
                        <option key={u}>{u}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-1">
                    <input
                      className="input w-24"
                      type="number"
                      min={0}
                      value={it.plannedQty}
                      onChange={(e) => update(i, { plannedQty: Number(e.target.value) })}
                    />
                  </td>
                  <td className="p-1">
                    <select
                      className="input"
                      value={it.measureMode}
                      onChange={(e) => update(i, { measureMode: e.target.value as MeasureMode })}
                    >
                      {MeasureMode.options.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-1">
                    <input
                      className="input"
                      value={it.samConcepts.join(", ")}
                      onChange={(e) =>
                        update(i, {
                          samConcepts: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .slice(0, 5),
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex justify-end">
            <button className="btn" onClick={save} disabled={busy}>
              Save {items.length} items
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

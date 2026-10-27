import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { BoqTable } from "../components/BoqTable";
import { ErrorNote, StatusBadge } from "../components/Layout";

export function ProjectPage() {
  const projectId = Number(useParams().projectId);
  const { data: project, error, reload } = useAsync(() => api.getProject(projectId), [projectId]);
  const [zoneName, setZoneName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function addZone(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.createZone(projectId, { name: zoneName, sortOrder: project?.zones.length ?? 0 });
      setZoneName("");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function startVisit() {
    try {
      const v = await api.createVisit(projectId);
      navigate(`/visits/${v.id}/capture`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!project) return <p className="text-sm text-gray-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <p className="text-sm text-gray-500">{project.locationLabel}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <Link className="btn-secondary" to={`/projects/${projectId}/boq`}>
            Upload BOQ
          </Link>
          <button className="btn" onClick={startVisit} disabled={!project.zones.length}>
            Start site visit
          </button>
        </div>
      </div>
      <ErrorNote error={actionError} />

      <section className="card">
        <h2 className="mb-3 font-semibold">Bill of quantities</h2>
        <BoqTable items={project.boqItems} progress={project.progress} />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 font-semibold">Zones</h2>
          <ul className="mb-3 space-y-1 text-sm">
            {project.zones.map((z) => (
              <li key={z.id}>{z.name}</li>
            ))}
            {!project.zones.length && <li className="text-gray-500">Add at least one zone before a visit.</li>}
          </ul>
          <form onSubmit={addZone} className="flex gap-2">
            <input className="input" placeholder="e.g. Floor 3 – East" value={zoneName} onChange={(e) => setZoneName(e.target.value)} required />
            <button className="btn-secondary">Add</button>
          </form>
        </section>

        <section className="card">
          <h2 className="mb-3 font-semibold">Visits</h2>
          <ul className="divide-y divide-gray-100 text-sm">
            {project.visits.map((v) => (
              <li key={v.id}>
                <Link to={`/visits/${v.id}`} className="flex items-center justify-between py-2 hover:underline">
                  <span>{v.visitDate}</span>
                  <StatusBadge status={v.status} />
                </Link>
              </li>
            ))}
            {!project.visits.length && <li className="text-gray-500">No visits yet.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

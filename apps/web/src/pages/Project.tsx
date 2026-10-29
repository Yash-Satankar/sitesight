import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CalendarDays, ChevronRight, MapPinned, Plus, Upload } from "lucide-react";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { BoqTable } from "../components/BoqTable";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, Loading, SectionTitle, TopBar, VisitStatusChip, fmtDate } from "../components/ui";

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

  if (error) return <div className="pt-4"><ErrorNote error={error} /></div>;
  if (!project) return <Loading />;

  return (
    <div>
      <TopBar back="/" title={project.name} subtitle={project.locationLabel || undefined} />
      <div className="space-y-5">
        <ErrorNote error={actionError} />

        <section className="card">
          <SectionTitle
            right={
              <Link className="btn-ghost min-h-10 text-sm text-accent" to={`/projects/${projectId}/boq`}>
                <Upload className="h-4 w-4" aria-hidden /> {project.boqItems.length ? "Replace BOQ" : "Upload BOQ"}
              </Link>
            }
          >
            Bill of quantities
          </SectionTitle>
          <BoqTable items={project.boqItems} progress={project.progress} />
        </section>

        <div className="grid gap-5 md:grid-cols-2">
          <section className="card min-w-0">
            <SectionTitle>Visits</SectionTitle>
            <ul className="-mx-2">
              {project.visits.map((v) => (
                <li key={v.id}>
                  <Link to={`/visits/${v.id}`} className="flex min-h-12 items-center gap-3 rounded-xl px-2 hover:bg-slate-50 active:bg-slate-100">
                    <CalendarDays className="h-5 w-5 shrink-0 text-slate-500" aria-hidden />
                    <span className="num flex-1 font-medium">{fmtDate(v.visitDate)}</span>
                    <VisitStatusChip status={v.status} />
                    <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
            {!project.visits.length && (
              <p className="text-sm text-slate-600">{project.zones.length ? "No visits yet. Start one with New visit." : "No visits yet. Add a zone first, then start a visit."}</p>
            )}
          </section>

          <section className="card min-w-0">
            <SectionTitle>Zones</SectionTitle>
            {project.zones.length > 0 ? (
              <ul className="mb-3 flex flex-wrap gap-2">
                {project.zones.map((z) => (
                  <li key={z.id} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-slate-100 px-3 text-sm font-medium">
                    <MapPinned className="h-4 w-4 text-slate-500" aria-hidden />
                    {z.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-3 text-sm text-slate-600">Add at least one zone (e.g. a floor or wall) before the first visit.</p>
            )}
            <form onSubmit={addZone} className="flex gap-2">
              <input className="input" placeholder="e.g. Floor 3 – East" value={zoneName} onChange={(e) => setZoneName(e.target.value)} required />
              <button className="btn-secondary shrink-0" aria-label="Add zone">
                <Plus className="h-5 w-5" aria-hidden /> Add
              </button>
            </form>
          </section>
        </div>

        <BottomBarSpacer />
        <BottomBar>
          {project.zones.length ? (
            <button className="btn flex-1" onClick={startVisit}>
              <Plus className="h-5 w-5" aria-hidden /> New visit
            </button>
          ) : (
            <p className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-100 px-3 text-center text-sm font-semibold text-slate-700">
              <MapPinned className="h-4 w-4 shrink-0" aria-hidden /> Add a zone to start a visit
            </p>
          )}
        </BottomBar>
      </div>
    </div>
  );
}

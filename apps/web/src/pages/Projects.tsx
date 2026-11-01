import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, CalendarDays, Camera, ChevronRight, MapPin, Plus, TriangleAlert, Wallet, X } from "lucide-react";
import { api, type DailySpend } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorNote } from "../components/Layout";
import { BottomBar, BottomBarSpacer, EmptyState, Loading, ProgressBar, ProgressRing, fmtDate } from "../components/ui";

export function ProjectsPage() {
  const { data: projects, error, loading } = useAsync(() => api.listProjects(), []);
  const { data: spend } = useAsync(() => api.todaySpend(), []);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false); // phones: the form opens from the bottom bar
  const navigate = useNavigate();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const p = await api.createProject({ name, locationLabel: location });
      navigate(`/projects/${p.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_20rem]">
      <section className="min-w-0">
        <h1 className="mb-3 text-2xl font-bold">Projects</h1>
        {spend && <SpendToday spend={spend} />}
        <ErrorNote error={error} />
        {loading && !projects && <Loading />}
        <ul className="space-y-3">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="card flex min-h-20 items-center gap-3 transition-colors hover:border-slate-400 active:bg-slate-50">
                <ProgressRing pct={p.overallPercent} size={60} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-base leading-snug font-bold">{p.name}</span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1 text-sm text-slate-600">
                    {p.locationLabel ? (
                      <>
                        <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{p.locationLabel}</span>
                      </>
                    ) : (
                      <span>Created {fmtDate(p.createdAt.slice(0, 10))}</span>
                    )}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="num inline-flex items-center gap-1 text-slate-700">
                      <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {p.lastVisitDate ? `Last visit ${fmtDate(p.lastVisitDate, false)}` : "No visits yet"}
                    </span>
                    {p.openAskBacks > 0 && (
                      <span className="num inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-900">
                        <Camera className="h-3.5 w-3.5" aria-hidden />
                        {p.openAskBacks} photo request{p.openAskBacks === 1 ? "" : "s"}
                      </span>
                    )}
                    {p.inferredItems > 0 && (
                      <span className="num inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950" title="Counted in the overall %, but not billable until observed">
                        <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
                        {p.inferredItems} inferred
                      </span>
                    )}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-slate-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
        {projects?.length === 0 && (
          <EmptyState icon={Building2} title="No projects yet">
            Create one, upload its BOQ, then start a site visit.
          </EmptyState>
        )}
      </section>

      <form onSubmit={create} className={`card h-fit space-y-3 ${formOpen ? "block" : "hidden md:block"}`}>
        <div className="flex items-center">
          <h2 className="text-base font-bold">New project</h2>
          <button type="button" className="btn-ghost ml-auto md:hidden" onClick={() => setFormOpen(false)} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <input className="input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Location (city)" value={location} onChange={(e) => setLocation(e.target.value)} />
        <ErrorNote error={createError} />
        <button className="btn w-full">Create project</button>
      </form>

      {!formOpen && (
        <div className="md:hidden">
          <BottomBarSpacer />
          <BottomBar>
            <button className="btn flex-1" onClick={() => setFormOpen(true)}>
              <Plus className="h-5 w-5" aria-hidden /> New project
            </button>
          </BottomBar>
        </div>
      )}
    </div>
  );
}

/** Today's Meta spend for the public demo, against the daily cap (resets at midnight UTC). */
function SpendToday({ spend }: { spend: DailySpend }) {
  const used = spend.capUsd ? Math.min(100, (spend.spentUsd / spend.capUsd) * 100) : 0;
  const out = spend.remainingUsd <= 0;
  const near = !out && used >= 80;
  return (
    <section className={`mb-4 rounded-2xl border px-4 py-3 ${out ? "border-amber-400 bg-amber-50" : "border-slate-200 bg-white"}`} aria-label="Today's AI spend">
      <div className="flex items-center gap-2 text-sm">
        <Wallet className={`h-4 w-4 shrink-0 ${out ? "text-amber-700" : "text-slate-500"}`} aria-hidden />
        <span className="font-semibold">AI spend today</span>
        <span className="num ml-auto">
          <strong>${spend.spentUsd.toFixed(2)}</strong>
          <span className="text-slate-600"> of ${spend.capUsd.toFixed(2)}</span>
        </span>
      </div>
      <ProgressBar pct={used} tone={out || near ? "attention" : "busy"} className="mt-2" />
      {out && <p className="mt-2 text-sm font-medium text-amber-950">Today's demo budget is used up. New agent runs and drawing imports resume at midnight UTC.</p>}
    </section>
  );
}

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { ErrorNote } from "../components/Layout";

export function ProjectsPage() {
  const { data: projects, error, loading } = useAsync(() => api.listProjects(), []);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
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
    <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Projects</h1>
        <ErrorNote error={error} />
        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        <ul className="space-y-2">
          {projects?.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`} className="card block hover:border-gray-400">
                <p className="font-medium">{p.name}</p>
                <p className="text-sm text-gray-500">{p.locationLabel || "—"}</p>
              </Link>
            </li>
          ))}
          {projects?.length === 0 && <p className="text-sm text-gray-500">No projects yet.</p>}
        </ul>
      </section>

      <form onSubmit={create} className="card h-fit space-y-3">
        <h2 className="font-semibold">New project</h2>
        <input className="input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Location (city)" value={location} onChange={(e) => setLocation(e.target.value)} />
        <ErrorNote error={createError} />
        <button className="btn w-full">Create</button>
      </form>
    </div>
  );
}

import { Link, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/icon.svg" alt="" className="h-7 w-7" />
            SiteSight
          </Link>
          <span className="text-xs text-gray-500">AI site-progress auditor</span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
}

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    queued: "bg-blue-100 text-blue-700",
    processing: "bg-blue-100 text-blue-700",
    needs_input: "bg-amber-100 text-amber-800",
    assessed: "bg-violet-100 text-violet-700",
    reviewed: "bg-green-100 text-green-700",
    reported: "bg-green-200 text-green-900",
    proposed: "bg-gray-100 text-gray-700",
    accepted: "bg-green-100 text-green-700",
    edited: "bg-teal-100 text-teal-700",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-100"}`}>
      {status.replace("_", " ")}
    </span>
  );
}

import { isRouteErrorResponse, Link, Outlet, useLocation, useRouteError } from "react-router-dom";
import { XCircle } from "lucide-react";

export function Layout() {
  const home = useLocation().pathname === "/";
  return (
    <div className="min-h-dvh">
      {home && (
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex min-h-14 max-w-5xl items-center gap-3 px-4 sm:px-6">
            <Link to="/" className="flex items-center gap-2 text-lg font-bold">
              <img src="/icon.svg" alt="" className="h-8 w-8" />
              SiteSight
            </Link>
            <span className="hidden text-sm text-slate-600 sm:inline">AI site-progress auditor</span>
          </div>
        </header>
      )}
      <main className={`mx-auto max-w-5xl px-4 sm:px-6 ${home ? "py-5" : "pb-6"}`}>
        <Outlet />
      </main>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-900">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{error}</span>
    </p>
  );
}

/** Route error screen: a readable message and a way back, instead of the router's developer page. */
export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <div className="mx-auto max-w-md space-y-4 px-4 py-10">
      <h1 className="text-xl font-bold">Something went wrong</h1>
      <ErrorNote error={message} />
      <div className="flex gap-2">
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
        <Link className="btn-secondary" to="/">
          Projects
        </Link>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { api, UNAUTHORIZED_EVENT } from "../lib/api";
import { ErrorNote } from "./Layout";

type State = "checking" | "open" | "login";

/**
 * Demo password gate. Asks the API whether a login is needed (/auth/me) and shows the login screen until the session
 * cookie is set. Any 401 later (expired session) brings the login screen back.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>("checking");

  const check = useCallback(async () => {
    try {
      const me = await api.me();
      setState(me.authRequired && !me.authenticated ? "login" : "open");
    } catch {
      setState("open"); // API unreachable: let the page show its own error
    }
  }, []);

  useEffect(() => {
    void check();
    const onUnauthorized = () => setState("login");
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  if (state === "checking") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-slate-600">
        <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />
      </div>
    );
  }
  if (state === "login") return <LoginScreen onDone={() => setState("open")} />;
  return <>{children}</>;
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <img src="/icon.svg" alt="" className="h-12 w-12" />
        <div>
          <p className="text-2xl font-bold">SiteSight</p>
          <p className="text-sm text-slate-600">AI site-progress auditor</p>
        </div>
      </div>
      <form onSubmit={submit} className="card space-y-4">
        <div className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-accent" aria-hidden />
          <h1 className="text-lg font-bold">Demo access</h1>
        </div>
        <p className="text-sm text-slate-600">Enter the demo password you were given.</p>
        <label className="block text-sm font-semibold text-slate-700">
          Password
          <div className="relative mt-1">
            <input
              className="input pr-12"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost absolute top-0 right-0 min-h-12 min-w-12 px-0 text-slate-500"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? "Hide password" : "Show password"}
            >
              {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          </div>
        </label>
        <ErrorNote error={error} />
        <button className="btn w-full" disabled={busy || !password}>
          {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null} Enter
        </button>
      </form>
    </main>
  );
}

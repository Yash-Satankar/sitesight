// Local stack for the demo recording: Postgres in Docker, the web app built into the output folder, and the API +
// worker (apps/api start:prod in development mode, no login) on free ports. Never production.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const PG_CONTAINER = "sitesight-demo-pg";
const PG_PASSWORD = "demo-only-local";

export interface StackState {
  pgPort: number;
  apiPort: number;
}

export async function freePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p++) {
    const ok = await new Promise<boolean>((done) => {
      const s = createServer();
      s.once("error", () => done(false));
      s.listen(p, "127.0.0.1", () => s.close(() => done(true)));
    });
    if (ok) return p;
  }
  throw new Error(`no free port from ${from}`);
}

function docker(args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "pipe"] }).trim();
}

export function dockerReady(): boolean {
  try {
    docker(["info", "--format", "{{.ServerVersion}}"], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

function containerPort(): number | null {
  try {
    const out = docker(["port", PG_CONTAINER, "5432/tcp"], { quiet: true });
    const m = /:(\d+)\s*$/m.exec(out);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function removeDatabase(): void {
  try {
    docker(["rm", "-f", PG_CONTAINER], { quiet: true });
  } catch {
    // not there
  }
}

/** Start (or reuse) the demo Postgres. A new container is an empty database. */
export async function ensureDatabase(preferredPort: number): Promise<{ port: number; fresh: boolean }> {
  if (!dockerReady()) throw new Error("Docker is not running. Start Docker Desktop, then run pnpm demo-video again.");
  const running = (() => {
    try {
      return docker(["inspect", "-f", "{{.State.Running}}", PG_CONTAINER], { quiet: true }) === "true";
    } catch {
      return null;
    }
  })();
  let fresh = false;
  if (running === null) {
    const port = await freePort(preferredPort);
    docker(["run", "-d", "--name", PG_CONTAINER, "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`, "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine"]);
    fresh = true;
  } else if (!running) docker(["start", PG_CONTAINER]);
  for (let i = 0; i < 90; i++) {
    try {
      docker(["exec", PG_CONTAINER, "pg_isready", "-U", "postgres"], { quiet: true });
      const port = containerPort();
      if (port) return { port, fresh };
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Postgres did not become ready");
}

export const databaseUrl = (port: number) => `postgres://postgres:${PG_PASSWORD}@127.0.0.1:${port}/postgres`;

/** One SQL value from the demo database (psql inside the container). */
export function sqlValue(query: string): string {
  return docker(["exec", PG_CONTAINER, "psql", "-U", "postgres", "-tAc", query]);
}

export function buildWeb(repoRoot: string, outDir: string, force: boolean): string {
  const dist = join(outDir, "web-dist");
  if (!force && existsSync(join(dist, "index.html"))) return dist;
  console.log("  building the web app into the output folder…");
  execFileSync("pnpm", ["--filter", "@sitesight/web", "exec", "vite", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "inherit"],
    shell: true,
    // Same origin as the API (a VITE_API_URL from a local .env would point the page elsewhere).
    env: { ...process.env, VITE_API_URL: "/api" },
  });
  return dist;
}

export interface ApiHandle {
  base: string;
  stop(): Promise<void>;
}

export async function startApi(opts: {
  repoRoot: string;
  outDir: string;
  webDist: string;
  pgPort: number;
  preferredPort: number;
  spendCapUsd: number;
  fastPath: boolean;
}): Promise<ApiHandle> {
  const port = await freePort(opts.preferredPort);
  const base = `http://127.0.0.1:${port}`;
  const storage = join(opts.outDir, "storage");
  mkdirSync(storage, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    DATABASE_URL: databaseUrl(opts.pgPort),
    STORAGE_LOCAL_DIR: storage,
    WEB_DIST_DIR: opts.webDist,
    WEB_ORIGIN: base,
    PUBLIC_API_URL: `${base}/api`,
    ALLOW_LAN_ORIGINS: "false",
    DEMO_PASSWORD: "",
    DAILY_SPEND_CAP_USD: String(opts.spendCapUsd),
    AGENT_FAST_PATH: String(opts.fastPath),
    META_PROXY_SECRET: "",
  };
  const log = createWriteStream(join(opts.outDir, "api.log"), { flags: "a" });
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/prod.ts"], { cwd: join(opts.repoRoot, "apps", "api"), env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(`API exited during startup; see ${join(opts.outDir, "api.log")}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch {
      // starting
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 119) throw new Error("API did not start in 2 minutes");
  }
  return {
    base,
    stop: () =>
      new Promise<void>((done) => {
        if (exited) return done();
        child.once("exit", () => done());
        child.kill("SIGINT");
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 15_000).unref();
      }),
  };
}

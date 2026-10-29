import { eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/client.js";

export type JobKind = (typeof schema.jobs.$inferSelect)["kind"];
export type Job = typeof schema.jobs.$inferSelect;

export async function enqueue(kind: JobKind, payload: Record<string, unknown>): Promise<number> {
  const [job] = await db.insert(schema.jobs).values({ kind, payload }).returning({ id: schema.jobs.id });
  return job!.id;
}

/** Atomically claim the next pending job (SKIP LOCKED makes multiple workers safe). */
export async function claimNext(): Promise<Job | null> {
  const rows = await db.execute<Record<string, unknown>>(dsql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, kind, payload, status, attempts, run_after, locked_at, last_error
  `);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id as number,
    kind: r.kind as JobKind,
    payload: r.payload,
    status: r.status as Job["status"],
    attempts: r.attempts as number,
    runAfter: r.run_after as Date,
    lockedAt: r.locked_at as Date | null,
    lastError: r.last_error as string | null,
  };
}

/** Return jobs whose worker died mid-run to the queue. */
export async function releaseStale(minutes = 10): Promise<void> {
  await db.execute(dsql`
    UPDATE jobs SET status = 'pending', locked_at = NULL
    WHERE status = 'running' AND locked_at < now() - make_interval(mins => ${minutes})
  `);
}

/** Mark a visit queued and enqueue an agent run for it. */
export async function queueAgentRun(visitId: number): Promise<void> {
  await db.update(schema.visits).set({ status: "queued" }).where(eq(schema.visits.id, visitId));
  await enqueue("agent_run", { visitId });
}

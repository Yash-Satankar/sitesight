import { eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { db, schema, sql } from "../db/client.js";
import { runAgent } from "../agent/run.js";
import { CostLimitError } from "../meta/spark.js";
import { transcribe } from "../meta/voice.js";
import { getObject } from "../services/storage.js";
import { claimNext, releaseStale, type Job } from "../services/jobs.js";

const VisitPayload = z.object({ visitId: z.number().int() });
const PhotoPayload = z.object({ photoId: z.number().int() });

let stopping = false;

async function handle(job: Job): Promise<void> {
  switch (job.kind) {
    case "agent_run": {
      const { visitId } = VisitPayload.parse(job.payload);
      const outcome = await runAgent(visitId);
      console.log(`[worker] visit ${visitId} → ${outcome}`);
      return;
    }
    case "transcribe": {
      const { photoId } = PhotoPayload.parse(job.payload);
      const [photo] = await db.select().from(schema.photos).where(eq(schema.photos.id, photoId));
      if (!photo?.voiceNoteKey) return;
      const text = await transcribe(await getObject(photo.voiceNoteKey), photo.voiceNoteKey.split("/").pop());
      await db.update(schema.photos).set({ transcript: text }).where(eq(schema.photos.id, photoId));
      return;
    }
  }
}

async function onFailure(job: Job, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const permanent = err instanceof CostLimitError || job.attempts >= env.JOB_MAX_ATTEMPTS;
  console.error(`[worker] job ${job.id} (${job.kind}) failed, attempt ${job.attempts}: ${message}`);

  await db
    .update(schema.jobs)
    .set(
      permanent
        ? { status: "failed", lastError: message, lockedAt: null }
        : {
            status: "pending",
            lastError: message,
            lockedAt: null,
            runAfter: dsql`now() + make_interval(secs => ${2 ** job.attempts * 5})`,
          },
    )
    .where(eq(schema.jobs.id, job.id));

  // A visit whose agent job gave up goes back to draft so the engineer can re-run it.
  if (permanent && job.kind === "agent_run") {
    const parsed = VisitPayload.safeParse(job.payload);
    if (parsed.success) {
      await db.update(schema.visits).set({ status: "draft" }).where(eq(schema.visits.id, parsed.data.visitId));
    }
  }
}

async function loop() {
  console.log("[worker] started");
  let lastStaleCheck = 0;
  while (!stopping) {
    if (Date.now() - lastStaleCheck > 60_000) {
      await releaseStale();
      lastStaleCheck = Date.now();
    }
    const job = await claimNext();
    if (!job) {
      await new Promise((r) => setTimeout(r, env.WORKER_POLL_MS));
      continue;
    }
    try {
      await handle(job);
      await db.update(schema.jobs).set({ status: "done", lockedAt: null }).where(eq(schema.jobs.id, job.id));
    } catch (err) {
      await onFailure(job, err);
    }
  }
  await sql.end();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}, finishing current job…`);
    stopping = true;
  });
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});

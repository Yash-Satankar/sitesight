import { eq, sql as dsql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../config.js";
import { db, schema } from "../db/client.js";
import { runAgent } from "../agent/run.js";
import { CostLimitError } from "../meta/cost.js";
import { transcribe } from "../meta/voice.js";
import { getObject } from "../services/storage.js";
import { claimNext, releaseStale, type Job } from "../services/jobs.js";
import { markDrawingImportFailed, runDrawingImport } from "../services/drawings/imports.js";

const VisitPayload = z.object({ visitId: z.number().int() });
const PhotoPayload = z.object({ photoId: z.number().int() });
const DrawingPayload = z.object({ importId: z.number().int() });

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
    case "drawing_import": {
      const { importId } = DrawingPayload.parse(job.payload);
      console.log(`[worker] drawing import ${importId} → ${await runDrawingImport(importId)}`);
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

  if (permanent && job.kind === "drawing_import") {
    const parsed = DrawingPayload.safeParse(job.payload);
    if (parsed.success) await markDrawingImportFailed(parsed.data.importId, message);
  }

  // A visit whose agent job gave up goes back to draft so the engineer can re-run it.
  if (permanent && job.kind === "agent_run") {
    const parsed = VisitPayload.safeParse(job.payload);
    if (parsed.success) {
      await db.update(schema.visits).set({ status: "draft" }).where(eq(schema.visits.id, parsed.data.visitId));
    }
  }
}

export interface WorkerHandle {
  /** Finish the current job (if any), then resolve. No new job is claimed after this. */
  stop(): Promise<void>;
  /** Resolves when the loop has exited. */
  done: Promise<void>;
}

/**
 * The job loop, runnable in any process: worker/index.ts (dev, its own process) and prod.ts (in the API process,
 * so both share the storage volume). A job in progress always finishes before stop() resolves.
 */
export function startWorker(opts: { log?: (msg: string) => void } = {}): WorkerHandle {
  const log = opts.log ?? ((m) => console.log(m));
  let stopping = false;
  let wake: (() => void) | null = null;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const done = (async () => {
    log("[worker] started");
    let lastStaleCheck = 0;
    while (!stopping) {
      try {
        if (Date.now() - lastStaleCheck > 60_000) {
          await releaseStale();
          lastStaleCheck = Date.now();
        }
        const job = await claimNext();
        if (!job) {
          await sleep(env.WORKER_POLL_MS);
          continue;
        }
        try {
          await handle(job);
          await db.update(schema.jobs).set({ status: "done", lockedAt: null }).where(eq(schema.jobs.id, job.id));
        } catch (err) {
          await onFailure(job, err);
        }
      } catch (err) {
        // The database blipped (restart, network): back off instead of crashing the process.
        console.error("[worker] loop error:", err instanceof Error ? err.message : err);
        await sleep(5000);
      }
    }
    log("[worker] stopped");
  })();

  return {
    done,
    stop: async () => {
      stopping = true;
      wake?.();
      await done;
    },
  };
}

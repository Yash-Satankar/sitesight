import { ilike, inArray, sql as dsql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client.js";
import { deleteObject } from "./storage.js";

export interface DeletedProject {
  projectId: number;
  name: string;
  visits: number;
  storageKeys: number;
  filesDeleted: number;
}

/**
 * Delete a project and everything under it: zones, BOQ, visits (photos, segments, assessments, ask-backs,
 * agent runs/steps, panel measurements, reports) via ON DELETE CASCADE, plus its queued jobs (jobs carry the
 * visit id in JSON, not a foreign key). With `deleteFiles`, stored photos, voice notes, masks and reports are
 * removed too; missing files are ignored.
 */
export async function deleteProject(projectId: number, opts: { deleteFiles?: boolean } = {}): Promise<DeletedProject | null> {
  const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId));
  if (!project) return null;

  const visits = await db.select({ id: schema.visits.id }).from(schema.visits).where(eq(schema.visits.projectId, projectId));
  const visitIds = visits.map((v) => v.id);
  const keys = new Set<string>();
  if (visitIds.length) {
    const photos = await db.select().from(schema.photos).where(inArray(schema.photos.visitId, visitIds));
    for (const p of photos) {
      keys.add(p.storageKey);
      if (p.voiceNoteKey) keys.add(p.voiceNoteKey);
    }
    const photoIds = photos.map((p) => p.id);
    if (photoIds.length) {
      const masks = await db.select({ key: schema.segments.maskKey }).from(schema.segments).where(inArray(schema.segments.photoId, photoIds));
      for (const m of masks) keys.add(m.key);
    }
    const reports = await db.select({ key: schema.reports.storageKey }).from(schema.reports).where(inArray(schema.reports.visitId, visitIds));
    for (const r of reports) keys.add(r.key);
  }

  await db.transaction(async (tx) => {
    if (visitIds.length) {
      await tx.delete(schema.jobs).where(
        dsql`(${schema.jobs.payload} ->> 'visitId')::int in (${dsql.join(
          visitIds.map((id) => dsql`${id}`),
          dsql`, `,
        )})`,
      );
    }
    await tx.delete(schema.projects).where(eq(schema.projects.id, projectId));
  });

  let filesDeleted = 0;
  if (opts.deleteFiles) {
    for (const key of keys) {
      try {
        await deleteObject(key);
        filesDeleted++;
      } catch {
        // already gone or unreachable: the database rows are what matter
      }
    }
  }
  return { projectId, name: project.name, visits: visitIds.length, storageKeys: keys.size, filesDeleted };
}

/** Projects created by `pnpm e2e-smoke` (their names contain "(e2e"). */
export async function findE2eProjects() {
  return db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).where(ilike(schema.projects.name, "%(e2e%")).orderBy(schema.projects.id);
}

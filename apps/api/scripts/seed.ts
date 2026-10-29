/**
 * Seed a project.
 *   pnpm seed                                                       # demo project, hand-written BOQ
 *   pnpm seed --boq samples/boq-demo-residence.json --name "Demo Residence"  # project from a BOQ JSON
 * No Spark call. A BOQ JSON's "zones" become the project's zones (default: one zone "Site").
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { BoqItemInput } from "@sitesight/shared";
import { db, schema, sql } from "../src/db/client.js";
import { boqItemProblem } from "../src/services/boq-rules.js";
import { parseBoqJson } from "./dry-run-lib.js";

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { boq: { type: "string" }, name: { type: "string" }, location: { type: "string" } },
  strict: true,
});

if (args.boq) {
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), args.boq);
  const { items, zones: declared } = parseBoqJson(await readFile(path, "utf8"));
  const problems = items.flatMap(({ zone: _z, ...it }) => {
    const p = boqItemProblem({ ...it, zoneId: null });
    return p ? [`${it.code}: ${p}`] : [];
  });
  if (problems.length) {
    console.error(`Inconsistent BOQ items in ${path}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const zoneNames = declared ?? ["Site"];
  const [project] = await db
    .insert(schema.projects)
    .values({ name: args.name ?? "Untitled project", locationLabel: args.location ?? "" })
    .returning();
  const zones = await db
    .insert(schema.zones)
    .values(zoneNames.map((name, i) => ({ projectId: project!.id, name, sortOrder: i })))
    .returning();
  const zoneId = new Map(zones.map((z) => [z.name, z.id]));
  await db.insert(schema.boqItems).values(items.map(({ zone, ...it }) => ({ ...it, projectId: project!.id, zoneId: zone ? zoneId.get(zone)! : null })));
  console.log(`Seeded project ${project!.id} "${project!.name}" with zones ${zoneNames.join(", ")} and ${items.length} BOQ items from ${args.boq}.`);
  await sql.end();
  process.exit(0);
}

const ZONES = ["Ground Floor – Columns", "Floor 1 – East", "Floor 1 – West", "Terrace"];

// Only columns (count) and brickwork (area) are segmented; everything else is assessed visually.
// panelPlannedQty 12.5: one brick bay between two columns is about 12.5 m² (used by panel measurements).
const BOQ: Omit<BoqItemInput, "zoneId" | "drawingSource">[] = [
  { code: "1.1", description: "RCC columns 300x450 up to plinth", unit: "nos", plannedQty: 24, measureMode: "count", segmentTargets: ["column"], panelPlannedQty: null, stages: null, sequenceNo: 1 },
  { code: "1.2", description: "Reinforcement steel Fe500 for columns", unit: "kg", plannedQty: 3200, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 1 },
  { code: "2.1", description: "RCC slab 150 mm thick, Floor 1", unit: "m3", plannedQty: 42, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 2 },
  { code: "3.1", description: "Brick masonry 230 mm in CM 1:6", unit: "m2", plannedQty: 380, measureMode: "area", segmentTargets: ["brickwork"], panelPlannedQty: 12.5, stages: null, sequenceNo: 3 },
  { code: "3.2", description: "Door and window openings with lintel", unit: "nos", plannedQty: 18, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 3 },
  { code: "4.1", description: "Internal plaster 12 mm in CM 1:4", unit: "m2", plannedQty: 650, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 4 },
  { code: "5.1", description: "Terrace waterproofing", unit: "m2", plannedQty: 210, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, stages: null, sequenceNo: 5 },
];

const [project] = await db
  .insert(schema.projects)
  .values({ name: "Demo Residence (G+1)", locationLabel: "Pune, MH" })
  .returning();
const zones = await db
  .insert(schema.zones)
  .values(ZONES.map((name, i) => ({ projectId: project!.id, name, sortOrder: i })))
  .returning();
await db.insert(schema.boqItems).values(BOQ.map((b) => ({ ...b, projectId: project!.id, zoneId: null })));

console.log(`Seeded project ${project!.id} with ${zones.length} zones and ${BOQ.length} BOQ items.`);
await sql.end();

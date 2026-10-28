/**
 * Seed a demo project with zones and a hand-written BOQ (no Spark call, no client data).
 *   pnpm seed
 */
import type { BoqItemInput } from "@sitesight/shared";
import { db, schema, sql } from "../src/db/client.js";

const ZONES = ["Ground Floor – Columns", "Floor 1 – East", "Floor 1 – West", "Terrace"];

// Only columns (count) and brickwork (area) are segmented; everything else is assessed visually.
// panelPlannedQty 12.5: one brick bay between two columns is about 12.5 m² (used by panel measurements).
const BOQ: Omit<BoqItemInput, "zoneId">[] = [
  { code: "1.1", description: "RCC columns 300x450 up to plinth", unit: "nos", plannedQty: 24, measureMode: "count", segmentTargets: ["column"], panelPlannedQty: null, sequenceNo: 1 },
  { code: "1.2", description: "Reinforcement steel Fe500 for columns", unit: "kg", plannedQty: 3200, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, sequenceNo: 1 },
  { code: "2.1", description: "RCC slab 150 mm thick, Floor 1", unit: "m3", plannedQty: 42, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, sequenceNo: 2 },
  { code: "3.1", description: "Brick masonry 230 mm in CM 1:6", unit: "m2", plannedQty: 380, measureMode: "area", segmentTargets: ["brickwork"], panelPlannedQty: 12.5, sequenceNo: 3 },
  { code: "3.2", description: "Door and window openings with lintel", unit: "nos", plannedQty: 18, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, sequenceNo: 3 },
  { code: "4.1", description: "Internal plaster 12 mm in CM 1:4", unit: "m2", plannedQty: 650, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, sequenceNo: 4 },
  { code: "5.1", description: "Terrace waterproofing", unit: "m2", plannedQty: 210, measureMode: "visual_only", segmentTargets: [], panelPlannedQty: null, sequenceNo: 5 },
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

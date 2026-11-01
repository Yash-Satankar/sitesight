// Development entry: the worker as its own process. Production runs it inside the API process (prod.ts).
import { sql } from "../db/client.js";
import { startWorker } from "./loop.js";

const worker = startWorker();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig}, finishing current job…`);
    void worker.stop().then(async () => {
      await sql.end();
      process.exit(0);
    });
  });
}

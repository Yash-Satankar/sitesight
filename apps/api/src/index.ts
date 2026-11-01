// Development entry: the API only (run the worker separately with `pnpm dev:worker`). Production uses prod.ts.
import { env } from "./config.js";
import { createApp } from "./app.js";

createApp().listen(env.PORT, () => {
  console.log(`SiteSight API on http://localhost:${env.PORT}`);
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Set before src/config.ts loads. Numbers are chosen so test costs are easy to reason about:
    // one Spark call = 200 in + 200 out tokens at $10/Mtok = $0.004; one SAM request = $0.0035; cap = $0.01.
    env: {
      META_API_KEY: "test-key",
      META_BASE_URL: "http://meta.test/v1",
      SPARK_INPUT_USD_PER_MTOK: "10",
      SPARK_OUTPUT_USD_PER_MTOK: "10",
      SAM_USD_PER_IMAGE: "0.0035",
      MAX_COST_PER_VISIT_USD: "0.01",
      MAX_AGENT_STEPS: "10",
      SAM_CONCURRENCY: "3",
    },
  },
});

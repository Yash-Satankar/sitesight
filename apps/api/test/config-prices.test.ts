/**
 * Startup must fail with a clear message when a price is missing, zero, negative or not a number.
 * Runs src/config.ts in a child process because it calls process.exit.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDir = fileURLToPath(new URL("..", import.meta.url));
const VALID = { SPARK_INPUT_USD_PER_MTOK: "0.5", SPARK_OUTPUT_USD_PER_MTOK: "2", SAM_USD_PER_IMAGE: "0.0025" };

function loadConfig(overrides: Record<string, string>) {
  // Empty string = "missing". It also stops dotenv from filling the key from a local .env.
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/config.ts"], {
    cwd: apiDir,
    env: { ...process.env, ...VALID, ...overrides },
    encoding: "utf8",
  });
  return { code: res.status, stderr: res.stderr };
}

describe("price validation at startup", { timeout: 120_000 }, () => {
  it("starts when all prices are positive", () => {
    expect(loadConfig({}).code).toBe(0);
  });

  for (const key of Object.keys(VALID)) {
    for (const [label, value] of [["missing", ""], ["zero", "0"], ["negative", "-1"], ["not a number", "abc"]] as const) {
      it(`refuses to start when ${key} is ${label}`, () => {
        const { code, stderr } = loadConfig({ [key]: value });
        expect(code).toBe(1);
        expect(stderr).toContain(`${key}=`);
        expect(stderr).toContain("must be a positive number in USD");
        expect(stderr).toContain("Refusing to start.");
      });
    }
  }
});

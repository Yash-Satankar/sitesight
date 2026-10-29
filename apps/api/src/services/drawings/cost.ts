import type { CostMeter, UsageCost } from "../../meta/spark.js";

export class DrawingCostLimitError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(`Drawing import cost $${spentUsd.toFixed(4)} reached MAX_COST_PER_DRAWING_IMPORT_USD=$${limitUsd}`);
    this.name = "DrawingCostLimitError";
  }
}

/**
 * Cost cap for one drawing import. A call is only started while spent + (calls in flight × average cost so far) is
 * below the cap, so concurrent calls overshoot by at most the variance of one call.
 */
export class ImportCostMeter implements CostMeter {
  spentUsd: number;
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;
  private inFlight = 0;

  constructor(
    readonly limitUsd: number,
    spentUsd = 0,
    private readonly onRecord?: (usage: UsageCost, meter: ImportCostMeter) => void | Promise<void>,
  ) {
    this.spentUsd = spentUsd;
  }

  private avg(): number {
    return this.calls ? this.spentUsd / this.calls : 0;
  }

  beforeCall(): void {
    const projected = this.spentUsd + this.inFlight * this.avg();
    if (projected >= this.limitUsd) throw new DrawingCostLimitError(this.spentUsd, this.limitUsd);
    this.inFlight++;
  }

  async record(usage: UsageCost): Promise<void> {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.calls++;
    this.spentUsd += usage.costUsd;
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    await this.onRecord?.(usage, this);
  }

  cancel(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

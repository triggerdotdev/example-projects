import { task } from "@trigger.dev/sdk";
import { checkCoverage } from "../coverage.js";

export const coverageTaskOptions = {
  id: "parlayapi-coverage",
  maxDuration: 30,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async (payload: unknown) => checkCoverage(payload),
};

export const parlayCoverage = task(coverageTaskOptions);

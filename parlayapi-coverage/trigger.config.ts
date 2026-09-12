import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "<your-project-ref>",
  runtime: "node",
  dirs: ["./src/trigger"],
  maxDuration: 30,
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
});

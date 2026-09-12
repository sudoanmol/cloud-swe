import { test } from "bun:test";
import { readFile } from "node:fs/promises";
import { Worker } from "@temporalio/worker";

// These histories were produced by baseline 0a62b0c before branch extraction.
for (const scenario of ["success", "recovery", "failure", "idle"]) {
  test(`replays the pre-adoption ${scenario} history`, async () => {
    const source = await readFile(
      new URL(`./fixtures/workflow-histories/${scenario}.json`, import.meta.url),
      "utf8",
    );

    await Worker.runReplayHistory(
      {
        workflowsPath: new URL("../src/workflows.ts", import.meta.url).pathname,
      },
      JSON.parse(source),
    );
  }, 30_000);
}

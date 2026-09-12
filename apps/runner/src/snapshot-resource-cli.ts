import { Freestyle } from "freestyle";
import { z } from "zod";
import { createSnapshotResources, TemporaryResourceError } from "./snapshot-resources.js";

const apiKey = z.string().min(1).parse(process.env.FREESTYLE_API_KEY);

const resources = createSnapshotResources(new Freestyle({ apiKey }));

const [action, ...args] = process.argv.slice(2);

try {
  if (action === "sweep") process.stdout.write(JSON.stringify(await resources.sweep()) + "\n");
  else {
    const [purpose, buildId, slug, value, expiry] = z
      .tuple([
        z.enum(["snapshot-builder", "snapshot-validation"]),
        z.string(),
        z.string(),
        z.string(),
        z.string().optional(),
      ])
      .parse(args);

    if (action === "create") {
      const id = await resources.create({
        purpose,
        buildId,
        slug,
        snapshotId: value,
        expiresAt: z.string().parse(expiry),
      });

      process.stdout.write(id + "\n");
    } else if (action === "cleanup") {
      await resources.cleanup({ id: slug, purpose, buildId, keep: value === "1" });
    } else throw new Error("Unknown snapshot resource action");
  }
} catch (error) {
  // Helper failures contain resource IDs only. SDK errors never reach script output.
  process.stderr.write(
    error instanceof TemporaryResourceError
      ? error.message + "\n"
      : "Snapshot resource operation failed\n",
  );
  process.exitCode = 1;
}

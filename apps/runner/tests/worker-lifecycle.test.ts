import { expect, test } from "bun:test";
import { runWorkerUntilStopped } from "../src/index.js";

test("worker shutdown waits for running activities before scope cleanup", async () => {
  const controller = new AbortController();
  const settled = Promise.withResolvers<void>();
  const calls: string[] = [];
  let complete = false;

  const worker = {
    run: () => {
      calls.push("run");

      return settled.promise;
    },
    shutdown: () => {
      calls.push("shutdown");
    },
  };

  const running = runWorkerUntilStopped(worker, controller.signal).then(() => {
    complete = true;
  });

  controller.abort();
  await Promise.resolve();

  expect(calls).toEqual(["run", "shutdown"]);
  expect(complete).toBe(false);

  calls.push("activity-drained");
  settled.resolve();
  await running;

  expect(calls).toEqual(["run", "shutdown", "activity-drained"]);
  expect(complete).toBe(true);
});

test("startup cancellation shuts down a worker created after cancellation", async () => {
  const controller = new AbortController();
  const settled = Promise.withResolvers<void>();
  let shutdowns = 0;

  controller.abort();

  const running = runWorkerUntilStopped(
    {
      run: () => settled.promise,
      shutdown: () => {
        shutdowns++;
      },
    },
    controller.signal,
  );

  expect(shutdowns).toBe(1);
  settled.resolve();
  await running;
});

test("a signal during worker startup is handled after run transitions its state", async () => {
  const controller = new AbortController();
  const calls: string[] = [];

  await runWorkerUntilStopped(
    {
      run: () => {
        controller.abort();
        calls.push("running");

        return Promise.resolve();
      },
      shutdown: () => {
        calls.push("shutdown");
      },
    },
    controller.signal,
  );

  expect(calls).toEqual(["running", "shutdown"]);
});

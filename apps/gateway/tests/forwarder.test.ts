import { expect, test } from "bun:test";

test("the guest forwarder sends mutation bodies once to IPv4 and IPv6 servers", async () => {
  const forwarder = Bun.spawn(
    [
      process.execPath,
      new URL("../../../infra/modal/preview-forwarder.ts", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  try {
    const reader = forwarder.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("preview forwarder listening");

    for (const hostname of ["127.0.0.1", "::1"]) {
      const received: string[] = [];

      const upstream = Bun.serve({
        hostname,
        port: 0,
        async fetch(request) {
          received.push(await request.text());

          return new Response("created", { status: 201 });
        },
      });

      try {
        const response = await fetch("http://127.0.0.1:7999/signup", {
          method: "POST",
          headers: { "x-cloud-swe-port": String(upstream.port) },
          body: "signup-body",
        });

        expect(response.status).toBe(201);
        expect(await response.text()).toBe("created");
        expect(received).toEqual(["signup-body"]);
      } finally {
        await upstream.stop(true);
      }
    }
  } finally {
    forwarder.kill();
    await forwarder.exited;
  }
});

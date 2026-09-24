import { expect, test } from "bun:test";

// Importing the setup validates its target but does not run its destructive
// default function. Each subprocess gets a fresh environment/module instance.
test("browser setup refuses non-test database names before connecting", async () => {
  for (const name of ["cloud_swe_web_e2e", "cloud_swe_web_e2e_isolated", "production"]) {
    const child = Bun.spawn(
      [
        "bun",
        "-e",
        `await import(${JSON.stringify(new URL("./global-setup.ts", import.meta.url).href)})`,
      ],
      {
        env: {
          ...process.env,
          E2E_DATABASE_URL: `postgresql://postgres:password@127.0.0.1:1/${name}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(name === "production" ? 1 : 0);

    if (name === "production") expect(error).toContain("Refusing to reset a database");
  }
});

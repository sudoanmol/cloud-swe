import { expect, test } from "bun:test";

import { parsePreviewHost, previewOrigin, previewUrlTemplate } from "../src/previews";

const slug = "0123456789abcdef0123456789abcdef";

test("parses a preview host and round-trips the origin", () => {
  const origin = previewOrigin("p.example.com", slug, 3000);

  expect(parsePreviewHost(new URL(origin).host, "p.example.com")).toEqual({ port: 3000, slug });
  expect(parsePreviewHost(`3000-${slug}.P.Example.com:443`, "p.example.com")).toEqual({
    port: 3000,
    slug,
  });
  expect(previewUrlTemplate("p.example.com", slug).replace("{port}", "3000")).toBe(origin);
});

test("rejects hosts that are not previews", () => {
  for (const host of [
    `3000-${slug}.example.com`,
    `3000-${slug}.evil-p.example.com`,
    `x.3000-${slug}.p.example.com`,
    `0-${slug}.p.example.com`,
    `70000-${slug}.p.example.com`,
    `7999-${slug}.p.example.com`,
    `3000-short.p.example.com`,
    `p.example.com`,
  ])
    expect(parsePreviewHost(host, "p.example.com")).toBeNull();
});

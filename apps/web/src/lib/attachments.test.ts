import { expect, test } from "bun:test";

import {
  MAX_CONCURRENT_UPLOADS,
  attachmentRejectionMessage,
  planAttachments,
  submissionBlockReason,
  uploadWithConcurrency,
} from "./attachments";

/** Only the size/type/name facts the attachment policy inspects. */
function file(name: string, type: string, size: number) {
  return { name, size, type };
}

const bytes = (megabytes: number) => megabytes * 1024 * 1024;

const base = { accepted: [], alreadyQueued: 0, supportsImages: true };

test("accepts up to the message file limit and counts queued selections", () => {
  const incoming = Array.from({ length: 12 }, (_, index) => file(`${index}.txt`, "text/plain", 10));

  const first = planAttachments({ ...base, incoming });

  expect(first.accepted).toHaveLength(10);
  expect(first.rejected).toHaveLength(2);
  expect(first.rejected.every((rejection) => rejection.reason === "count-limit")).toBe(true);

  const withQueued = planAttachments({ ...base, alreadyQueued: 9, incoming });

  expect(withQueued.accepted).toHaveLength(1);
  expect(withQueued.rejected).toHaveLength(11);
});

test("already-attached files consume the message quota", () => {
  const ready = Array.from({ length: 10 }, (_, index) => file(`${index}.txt`, "text/plain", 10));
  const incoming = [file("extra.txt", "text/plain", 10)];

  const full = planAttachments({ ...base, accepted: ready, incoming });

  expect(full.accepted).toHaveLength(0);
  expect(full.rejected).toEqual([{ filename: "extra.txt", reason: "count-limit" }]);

  const room = planAttachments({ ...base, accepted: ready.slice(0, 9), incoming });

  expect(room.accepted.map((entry) => entry.name)).toEqual(["extra.txt"]);
});

test("rejects per-file and per-message oversize before uploading", () => {
  const oversized = file("big.bin", "application/octet-stream", 26 * 1024 * 1024);
  const single = planAttachments({ ...base, incoming: [oversized] });

  expect(single.accepted).toHaveLength(0);
  expect(single.rejected[0]?.reason).toBe("file-too-large");

  const heavy = [
    file("a.bin", "application/octet-stream", 20 * 1024 * 1024),
    file("b.bin", "application/octet-stream", 20 * 1024 * 1024),
    file("c.bin", "application/octet-stream", 20 * 1024 * 1024),
  ];

  const total = planAttachments({ ...base, incoming: heavy });

  expect(total.accepted.map((entry) => entry.name)).toEqual(["a.bin", "b.bin"]);
  expect(total.rejected).toEqual([{ filename: "c.bin", reason: "message-too-large" }]);

  // Bytes already on the message count too: 20 MB carried + a.bin fills the cap.
  const carried = planAttachments({
    ...base,
    accepted: [file("old.bin", "application/octet-stream", bytes(20))],
    incoming: heavy,
  });

  expect(carried.accepted.map((entry) => entry.name)).toEqual(["a.bin"]);
  expect(carried.rejected.map((rejection) => rejection.filename)).toEqual(["b.bin", "c.bin"]);
  expect(carried.rejected.every((rejection) => rejection.reason === "message-too-large")).toBe(
    true,
  );
});

test("images need an image-capable model, not an image-free thread", () => {
  const image = file("shot.png", "image/png", 10);

  expect(planAttachments({ ...base, incoming: [image] }).accepted).toHaveLength(1);
  expect(planAttachments({ ...base, incoming: [image], supportsImages: false }).rejected).toEqual([
    { filename: "shot.png", reason: "images-unsupported" },
  ]);
  // An image-capable model may add images even to a thread that has some.
  expect(planAttachments({ ...base, incoming: [image] }).accepted).toHaveLength(1);
  expect(
    planAttachments({ ...base, incoming: [file("notes.txt", "text/plain", 10)] }).accepted,
  ).toHaveLength(1);
});

test("an image thread blocks submission for a model without image input", () => {
  // Text-only follow-up to an image thread is still blocked: the model cannot
  // see the images already in the conversation.
  expect(submissionBlockReason({ hasThreadImages: true, supportsImages: false })).toBe(
    "image-thread-unsupported",
  );
  expect(submissionBlockReason({ hasThreadImages: true, supportsImages: true })).toBeNull();
  expect(submissionBlockReason({ hasThreadImages: false, supportsImages: false })).toBeNull();
});

test("out-of-order completions still line up with the selection order", async () => {
  const files = [
    new File(["slow"], "slow.txt", { type: "text/plain" }),
    new File(["fast"], "fast.txt", { type: "text/plain" }),
  ];

  const outcomes = await uploadWithConcurrency(files, MAX_CONCURRENT_UPLOADS, async (entry) => {
    await Bun.sleep(entry.name === "slow.txt" ? 30 : 1);

    return entry.name;
  });

  expect(
    outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null)),
  ).toEqual(["slow.txt", "fast.txt"]);
});

test("uploads at most two files at once and keeps the selection order", async () => {
  const files = Array.from(
    { length: 6 },
    (_, index) => new File([`${index}`], `${index}.txt`, { type: "text/plain" }),
  );

  let active = 0;
  let peak = 0;

  const outcomes = await uploadWithConcurrency(files, MAX_CONCURRENT_UPLOADS, async (entry) => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active -= 1;

    return entry.name.toUpperCase();
  });

  expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_UPLOADS);
  expect(
    outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null)),
  ).toEqual(["0.TXT", "1.TXT", "2.TXT", "3.TXT", "4.TXT", "5.TXT"]);
});

test("a failed upload keeps its position and the others still land", async () => {
  const files = [
    new File(["a"], "a.txt", { type: "text/plain" }),
    new File(["b"], "b.txt", { type: "text/plain" }),
  ];

  const outcomes = await uploadWithConcurrency(files, MAX_CONCURRENT_UPLOADS, async (entry) => {
    if (entry.name === "a.txt") throw new Error("upload failed");

    return entry.name;
  });

  expect(outcomes[0]?.status).toBe("rejected");
  expect(outcomes[0]).toMatchObject({ reason: expect.any(Error) });
  expect(outcomes[1]).toMatchObject({ status: "fulfilled", value: "b.txt" });
});

test("rejections read as product messages", () => {
  expect(attachmentRejectionMessage({ filename: "a", reason: "count-limit" })).toMatch(
    /at most 10/,
  );
  expect(attachmentRejectionMessage({ filename: "a", reason: "file-too-large" })).toMatch(/25 MB/);
  expect(attachmentRejectionMessage({ filename: "a", reason: "message-too-large" })).toMatch(
    /50 MB/,
  );
  expect(attachmentRejectionMessage({ filename: "a", reason: "images-unsupported" })).toMatch(
    /cannot use image attachments/,
  );
});

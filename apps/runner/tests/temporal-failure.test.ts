import { expect, test } from "bun:test";
import {
  ApplicationFailure,
  CancelledFailure,
  DefaultFailureConverter,
  defaultPayloadConverter,
} from "@temporalio/common";
import pino from "pino";
import { temporalFailure } from "../src/activity-scope.js";
import { runFailureMessage } from "../src/workflows.js";
import { publicErrorFields } from "../src/sandbox.js";
import { PiPersistenceOverflowError, PiPersistenceCleanupError } from "../src/pi-persistence.js";

const secrets = [
  "SYNTH_BEARER",
  "SYNTH_BASIC",
  "SYNTH_COOKIE_A",
  "SYNTH_COOKIE_B",
  "SYNTH_QUOTED",
  "SYNTH_URL_USER",
  "SYNTH_URL_PASS",
];

const credentials =
  'Authorization: Bearer SYNTH_BEARER\nAuthorization: Basic SYNTH_BASIC\nCookie: a=SYNTH_COOKIE_A; b=SYNTH_COOKIE_B\napi_key="SYNTH_QUOTED value"\nhttps://SYNTH_URL_USER:SYNTH_URL_PASS@example.test/path';

test("the activity adapter excludes SDK credentials from serialized Temporal failures and diagnostics", () => {
  const converter = new DefaultFailureConverter();
  const logs: string[] = [];

  const logger = pino(
    { level: "warn" },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );

  const nested = new Error(credentials);
  nested.name = credentials;
  const source = new Error(credentials, { cause: nested });

  const known = ApplicationFailure.create({
    message: credentials,
    type: "REPOSITORY_INITIALIZATION",
    nonRetryable: true,
    cause: source,
    details: [{ headers: credentials }],
  });

  for (const error of [
    source,
    known,
    ApplicationFailure.create({ message: credentials, type: credentials }),
  ]) {
    const safe = temporalFailure(error, false);
    const serialized = converter.errorToFailure(safe, defaultPayloadConverter);
    logger.warn(publicErrorFields(error), "Provider operation failed");
    const output = JSON.stringify({ serialized, publicMessage: runFailureMessage(safe), logs });

    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(serialized.cause).toBeUndefined();
    expect(serialized.applicationFailureInfo?.details).toBeUndefined();
  }

  expect(temporalFailure(known, false)).toMatchObject({
    type: "REPOSITORY_INITIALIZATION",
    nonRetryable: true,
  });
});

test("activity cancellation keeps Temporal cancellation identity", () => {
  expect(temporalFailure(new Error(credentials), true)).toBeInstanceOf(CancelledFailure);
  expect(runFailureMessage(temporalFailure(new Error(credentials), true))).toBeUndefined();
});

test("persistence admission and cleanup retain their domain identity through Temporal", () => {
  for (const error of [
    new PiPersistenceOverflowError(1, 100),
    new PiPersistenceCleanupError("timeout"),
  ]) {
    const failure = temporalFailure(error, false);
    expect(failure).toMatchObject({ type: error.code, nonRetryable: false });
    expect(runFailureMessage(failure)).not.toBe("Unable to process request");
  }
});

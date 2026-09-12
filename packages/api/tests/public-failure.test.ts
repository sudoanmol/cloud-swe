import { describe, expect, test } from "bun:test";

import { publicFailure, publicFailureForCode } from "@cloud-swe/db/public-failure";

describe("public failure mapping", () => {
  test("does not copy arbitrary error text into a public failure", () => {
    const secret = "Bearer top-secret basic dXNlcjpzZWNyZXQ=";

    const failure = publicFailure({
      code: "UNKNOWN_PROVIDER_FAILURE",
      message: `${secret} https://user:password@example.test/retry`,
      statusCode: 500,
      cause: { message: secret },
    });

    expect(failure).toEqual({
      code: "INTERNAL_ERROR",
      message: "Unable to process request",
      statusCode: 500,
    });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  test("preserves the stable identity and status of an allowlisted failure", () => {
    expect(publicFailureForCode("RUN_TIMEOUT", 500)).toEqual({
      code: "RUN_TIMEOUT",
      message: "Run exceeded its active execution time limit",
      statusCode: 500,
    });
  });

  test("keeps client errors bounded while preserving their status", () => {
    expect(publicFailure({ code: "UNTRUSTED", statusCode: 403 })).toEqual({
      code: "REQUEST_FAILED",
      message: "The request could not be completed",
      statusCode: 403,
    });
  });
});

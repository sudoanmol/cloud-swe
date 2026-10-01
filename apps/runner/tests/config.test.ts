import { describe, expect, test } from "bun:test";
import {
  loadRunnerConfig,
  toWorkflowConfig,
  validateRunnerConfig,
  type RunnerConfig,
} from "../src/config";

const defaults = (): RunnerConfig => ({
  ...loadRunnerConfig(),
  executionMode: "scripted",
  sandboxProvider: "docker",
  modal: undefined,
});

const modal = {
  tokenId: "test-only",
  tokenSecret: "test-only",
  appName: "cloud-swe-test",
  imageName: "cloud-swe-test",
  sandboxLimit: 5,
  maxRunSeconds: 1_200,
  ownerMaxRunSeconds: 4_500,
};

describe("runner configuration ownership", () => {
  test("does not place credentials, provider, or model settings in workflow input", () => {
    expect(Object.keys(toWorkflowConfig(defaults())).sort()).toEqual([
      "activityRetryMaxAttempts",
      "activityRetryWindowMs",
      "cleanupMs",
      "commandReconcileTimeoutMs",
      "idlePauseMs",
      "maxRunMs",
      "ownerMaxRunMs",
      "providerTimeoutMs",
      "workspacePreparationTimeoutMs",
    ]);
  });

  test("preparation covers cloning and recovery independently of agent time", () => {
    const config = defaults();
    expect(validateRunnerConfig({ ...config, maxRunMs: 1_000 })).toBeDefined();
    expect(() =>
      validateRunnerConfig({
        ...config,
        workspacePreparationTimeoutMs: config.repositoryCloneTimeoutMs,
      }),
    ).toThrow("must cover cloning");
    expect(() =>
      validateRunnerConfig({
        ...config,
        activityRetryWindowMs: config.workspacePreparationTimeoutMs,
      }),
    ).toThrow("all configured attempts");
  });

  test("Modal requires a token", () => {
    expect(() => validateRunnerConfig({ ...defaults(), sandboxProvider: "modal" })).toThrow(
      "MODAL_TOKEN_ID",
    );
  });

  test("Modal sandbox lifetime covers preparation and active execution", () => {
    expect(validateRunnerConfig({ ...defaults(), sandboxProvider: "modal", modal })).toBeDefined();
    expect(() =>
      validateRunnerConfig({
        ...defaults(),
        sandboxProvider: "modal",
        modal: { ...modal, maxRunSeconds: 1 },
      }),
    ).toThrow("must cover preparation");
    expect(() =>
      validateRunnerConfig({
        ...defaults(),
        sandboxProvider: "modal",
        modal: { ...modal, ownerMaxRunSeconds: 1 },
      }),
    ).toThrow("must cover preparation");
  });

  test("Pi validates model credentials at startup", () => {
    expect(() =>
      validateRunnerConfig({
        ...defaults(),
        executionMode: "pi",
        sandboxProvider: "modal",
        modal,
        modelCredentialsEncryptionKey: undefined,
      }),
    ).toThrow("MODEL_CREDENTIALS_ENCRYPTION_KEY");
  });
});

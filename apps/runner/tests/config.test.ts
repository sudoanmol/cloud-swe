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
  freestyleAutoDeleteSeconds: 14_400,
});

describe("runner configuration ownership", () => {
  test("does not place credentials, provider, or model settings in workflow input", () => {
    expect(Object.keys(toWorkflowConfig(defaults())).sort()).toEqual([
      "activityRetryMaxAttempts",
      "activityRetryWindowMs",
      "cleanupMs",
      "commandReconcileTimeoutMs",
      "idlePauseMs",
      "maxRunMs",
      "providerTimeoutMs",
      "workspacePreparationTimeoutMs",
    ]);
  });

  test("preparation covers cloning and recovery independently of agent time", () => {
    const config = defaults();
    expect(validateRunnerConfig({ ...config, maxRunMs: 1_000 }, false)).toBeDefined();
    expect(() =>
      validateRunnerConfig(
        { ...config, workspacePreparationTimeoutMs: config.repositoryCloneTimeoutMs },
        false,
      ),
    ).toThrow("must cover cloning");
    expect(() =>
      validateRunnerConfig(
        { ...config, activityRetryWindowMs: config.workspacePreparationTimeoutMs },
        false,
      ),
    ).toThrow("all configured attempts");
  });

  test("production cannot disable provider cleanup", () => {
    expect(() =>
      validateRunnerConfig({ ...defaults(), freestyleAutoDeleteSeconds: -1 }, true),
    ).toThrow("finite positive");
  });

  test("Pi validates model credentials at startup", () => {
    expect(() =>
      validateRunnerConfig(
        {
          ...defaults(),
          executionMode: "pi",
          sandboxProvider: "freestyle",
          freestyleApiKey: "test-only",
          aiGatewayApiKey: undefined,
        },
        false,
      ),
    ).toThrow("AI_GATEWAY_API_KEY");
  });
});

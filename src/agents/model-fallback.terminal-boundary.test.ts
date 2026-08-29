import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import {
  FailoverError,
  findCliMaxTurnsError,
  findCliTimeoutError,
  isNonProviderRuntimeCoordinationError,
  resolveModelFallbackError,
} from "./failover-error.js";
import { AgentHarnessPreflightError } from "./harness/errors.js";
import {
  runFallbackAttempt,
  shouldDiscardDeferredSessionSuspension,
} from "./model-fallback-attempt.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { runWithModelFallback } from "./model-fallback-runner.js";
import {
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
} from "./run-termination.js";
import { resolveSessionSuspensionTarget } from "./session-suspension.js";

const { providerHook } = vi.hoisted(() => ({
  providerHook: vi.fn<() => "overloaded" | undefined>(),
}));

// Observe the consultation boundary without replacing error/attempt handling.
// The original full fallback and real cold-provider tests remain unmocked here.
vi.mock("../plugins/provider-failover.js", () => ({
  classifyProviderFailoverSignalWithPlugin: providerHook,
}));

beforeEach(() => {
  providerHook.mockReset().mockImplementation(() => {
    throw new Error("unexpected provider policy consultation");
  });
});

function maxTurns() {
  return new FailoverError("recorded terminal stop", { reason: "unknown", code: "cli_max_turns" });
}

const wrappers = [
  { name: "direct", wrap: (error: FailoverError): unknown => error },
  { name: "error", wrap: (error: FailoverError): unknown => ({ error }) },
  {
    name: "cause",
    wrap: (error: FailoverError): unknown => new Error("wrapper", { cause: error }),
  },
  {
    name: "aggregate",
    wrap: (error: FailoverError): unknown =>
      new AggregateError([error, new Error("persistence failed")], "wrapper"),
  },
  {
    name: "cyclic",
    wrap: (error: FailoverError): unknown => {
      const wrapper = { message: "wrapper", cause: undefined as unknown, errors: [{ error }] };
      wrapper.cause = wrapper;
      return wrapper;
    },
  },
  {
    name: "preflight",
    wrap: (error: FailoverError): unknown =>
      new AgentHarnessPreflightError("wrapper", { cause: error }),
  },
];

describe.each(wrappers)("terminal $name wrapper", ({ wrap }) => {
  it("resolves the original identity as terminal without provider policy", () => {
    const error = wrap(maxTurns());
    expect(resolveModelFallbackError(error)).toEqual({ kind: "terminal", error });
    expect(isNonProviderRuntimeCoordinationError(error)).toBe(false);
    expect(providerHook).not.toHaveBeenCalled();
  });

  it.each(["throw", "classified result"])(
    "stops a shared %s attempt with the original identity",
    async (mode) => {
      const error = wrap(maxTurns());
      const run = vi.fn(async () => {
        if (mode === "throw") {
          throw error;
        }
        return "partial result";
      });
      await expect(
        runFallbackAttempt({
          run,
          provider: "fixture-provider",
          model: "fixture-model",
          attempts: [],
          captureHarnessPreflight: true,
          attempt: 1,
          total: 2,
          classifyResult: () => ({ error }),
        }),
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(1);
      expect(providerHook).not.toHaveBeenCalled();
    },
  );

  it("retains pending suspension without consulting provider policy during cleanup", () => {
    expect(shouldDiscardDeferredSessionSuspension({ error: wrap(maxTurns()) })).toBe(false);
    expect(providerHook).not.toHaveBeenCalled();
  });
});

it("does not consult context policy for provider-looking text around a terminal stop", () => {
  const error = new Error("model maximum reached in wrapper", { cause: maxTurns() });
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(false);
  expect(providerHook).not.toHaveBeenCalled();
});

it.each(["throw", "classified result"])(
  "prevents main-loop replay and preserves deferred cleanup for %s",
  async (mode) => {
    const error = new AggregateError([maxTurns()], "wrapper");
    const run = vi.fn(async () => {
      const target = resolveSessionSuspensionTarget();
      expect(target.mode).toBe("defer");
      if (target.mode === "defer") {
        target.defer({
          cfg: undefined,
          sessionId: "fixture-session",
          reason: "manual",
          failedProvider: "fixture-provider",
          failedModel: "fixture-model",
        });
      }
      if (mode === "throw") {
        throw error;
      }
      return "partial result";
    });
    const onError = vi.fn();
    await expect(
      runWithModelFallback({
        cfg: undefined,
        provider: "fixture-provider",
        model: "fixture-model",
        manifestPlugins: [],
        fallbacksOverride: ["fixture-next/fixture-model"],
        run,
        onError,
        classifyResult: () => ({ error }),
      }),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(providerHook).not.toHaveBeenCalled();
  },
);

it("stops image fallback at the same terminal boundary", async () => {
  const error = new AggregateError([maxTurns()], "wrapper");
  const run = vi.fn().mockRejectedValue(error);
  await expect(
    runWithImageModelFallback({
      cfg: {
        agents: {
          defaults: {
            imageModel: {
              primary: "fixture-provider/fixture-model",
              fallbacks: ["fixture-next/fixture-model"],
            },
          },
        },
      },
      run,
    }),
  ).rejects.toBe(error);
  expect(run).toHaveBeenCalledTimes(1);
  expect(providerHook).not.toHaveBeenCalled();
});

it.each(["caller signal", "direct abort", "restart abort"])(
  "honors %s before provider consultation",
  async (kind) => {
    const controller = new AbortController();
    const error =
      kind === "direct abort"
        ? createAgentRunDirectAbortError()
        : kind === "restart abort"
          ? createAgentRunRestartAbortError()
          : new Error("fixture failure");
    if (kind === "caller signal") {
      controller.abort();
    }
    await expect(
      runFallbackAttempt({
        run: async () => {
          throw error;
        },
        provider: "fixture-provider",
        model: "fixture-model",
        attempts: [],
        attempt: 1,
        total: 2,
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(error);
    expect(shouldDiscardDeferredSessionSuspension({ error, abortSignal: controller.signal })).toBe(
      true,
    );
    expect(providerHook).not.toHaveBeenCalled();
  },
);

it("still classifies a genuine provider failure through its hook", async () => {
  providerHook.mockReturnValue("overloaded");
  const result = await runFallbackAttempt({
    run: async () => {
      throw new Error("fixture provider refusal");
    },
    provider: "fixture-provider",
    model: "fixture-model",
    attempts: [],
    attempt: 1,
    total: 2,
  });
  expect(result).toMatchObject({
    error: {
      name: "FailoverError",
      reason: "overloaded",
      provider: "fixture-provider",
      model: "fixture-model",
    },
  });
  expect(providerHook).toHaveBeenCalledTimes(1);
});

it("preserves coordination precedence and suspension discard for mixed failures", () => {
  const error = new AggregateError([maxTurns(), new GatewayDrainingError()], "wrapper");
  expect(resolveModelFallbackError(error)).toEqual({ kind: "coordination", error });
  expect(shouldDiscardDeferredSessionSuspension({ error })).toBe(true);
  expect(providerHook).not.toHaveBeenCalled();
});

describe.each([
  { name: "max turns", find: findCliMaxTurnsError, make: maxTurns },
  {
    name: "CLI timeout",
    find: findCliTimeoutError,
    make: () =>
      new FailoverError("timeout", {
        reason: "timeout",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds: 1,
          observedActivity: true,
          activeToolCount: 0,
          backgroundTaskCount: 0,
        },
      }),
  },
])("$name finder", ({ find, make }) => {
  it("preserves depth-first error, cause, then aggregate order through cycles", () => {
    const first = make();
    const second = make();
    const third = make();
    const wrapper = { error: { cause: first }, cause: second, errors: [third] };
    expect(find(wrapper)).toBe(first);
    const cycle = { error: undefined as unknown, cause: wrapper, errors: [third] };
    cycle.error = cycle;
    expect(find(cycle)).toBe(first);
    const seen = new Set<object>([wrapper.error]);
    expect(find(wrapper, seen)).toBe(second);
    expect(find({ cause: null, errors: [null, { error: third }] })).toBe(third);
    expect(find({ error: cycle }, new Set([cycle]))).toBeUndefined();
  });
});

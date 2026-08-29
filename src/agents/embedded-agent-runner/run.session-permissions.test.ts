import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
  type TestRunEmbeddedAgent,
  useOpenAIPlatformAuthFixture,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import { withAuthorizedPermissionChange } from "./run/permission-change.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

type PermissionChange = NonNullable<EmbeddedRunAttemptParams["permissionChange"]>;

function requestPermissionChange(
  change: PermissionChange,
  mode: Parameters<PermissionChange["request"]>[0],
) {
  return withAuthorizedPermissionChange(change.owner, mode, () => change.request(mode));
}

// The mocked harness only supports the OpenAI route, so these params keep the
// plugin harness selected. Falling back to the built-in host harness would drag
// the whole OpenClaw tool graph into this shard and prove the wrong owner.
const pluginHarnessRunParams = {
  ...overflowBaseRunParams,
  provider: "openai",
  model: "gpt-5.6-luna",
  sessionRoot: "/tmp/openclaw-plugin-session-root",
} as const;

describe("embedded run session permissions", () => {
  let runEmbeddedAgent: TestRunEmbeddedAgent;

  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    useOpenAIPlatformAuthFixture();
  });

  it("prepares the exec mode with plugin-owned permission facts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ assistantTexts: ["OK"] }));

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "workspace",
      runId: "run-plugin-session-permissions",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHarnessId: "codex",
        execOverrides: expect.objectContaining({ mode: "auto" }),
        permissionMode: "workspace",
        sessionRoot: "/tmp/openclaw-plugin-session-root",
      }),
    );
  });

  it("shares the final plugin-clamped exec mode with the outer run", async () => {
    const execOverrides = {};
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.execOverrides).toBe(execOverrides);
      expect(attempt.execOverrides?.mode).toBe("full");
      attempt.permissionMode = "workspace";
      attempt.execOverrides!.mode = "auto";
      return makeAttemptResult({ assistantTexts: ["OK"] });
    });

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "full",
      execOverrides,
      runId: "run-plugin-clamped-session-permissions",
    });

    expect(execOverrides).toEqual({ mode: "auto" });
  });

  it.each([
    { before: "workspace", after: "full", execMode: "full" },
    { before: "full", after: null, execMode: "ask" },
  ] as const)(
    "continues $before → $after only after fresh permissions are installed",
    async ({ before, after, execMode }) => {
      let applied: Promise<boolean> | undefined;
      const acknowledged = vi.fn();
      let owner: object | undefined;
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
        expect(attempt.permissionChange).toBeDefined();
        owner = attempt.permissionChange!.owner;
        applied = requestPermissionChange(attempt.permissionChange!, after);
        void applied.then(acknowledged);
        return makeAttemptResult({
          aborted: true,
          toolMetas: [{ toolName: "exec", meta: "completed mutation" }],
          replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
        });
      });
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
        expect(acknowledged).not.toHaveBeenCalled();
        expect(attempt.permissionChange?.owner).toBe(owner);
        expect(attempt.permissionMode).toBe(after ?? undefined);
        expect(attempt.execOverrides?.mode).toBe(execMode);
        expect(attempt.sessionId).toBe(pluginHarnessRunParams.sessionId);
        expect(attempt.prompt).toContain("Continue from the current transcript");
        expect(attempt.prompt).not.toBe(pluginHarnessRunParams.prompt);
        expect(attempt.suppressNextUserMessagePersistence).toBe(true);
        expect(attempt.skipPreparedUserTurnMessage).toBe(true);
        expect(attempt.permissionChange?.notice).toContain("Permission change");
        expect(attempt.permissionChange?.applied()).toBe(true);
        return makeAttemptResult({ assistantTexts: ["Continued"] });
      });

      await runEmbeddedAgent({
        ...pluginHarnessRunParams,
        permissionMode: before,
        execOverrides: { mode: "ask" },
        runId: `run-live-permissions-${before}-${after}`,
      });

      await expect(applied).resolves.toBe(true);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    },
  );

  it("coalesces rapid permission selections and rejects stale attempt acknowledgements", async () => {
    let superseded: Promise<boolean> | undefined;
    let latest: Promise<boolean> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      superseded = requestPermissionChange(attempt.permissionChange!, "full");
      latest = requestPermissionChange(attempt.permissionChange!, "read-only");
      expect(attempt.permissionChange!.applied()).toBe(false);
      return makeAttemptResult({ aborted: true });
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      expect(attempt.permissionMode).toBe("read-only");
      expect(attempt.execOverrides?.mode).toBe("deny");
      expect(attempt.permissionChange!.applied()).toBe(true);
      return makeAttemptResult({ assistantTexts: ["Continued read-only"] });
    });

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "workspace",
      runId: "run-coalesced-permissions",
    });

    await expect(superseded).resolves.toBe(false);
    await expect(latest).resolves.toBe(true);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("settles the permission request when the replacement attempt cannot start", async () => {
    let applied: Promise<boolean> | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      applied = requestPermissionChange(attempt.permissionChange!, "full");
      return makeAttemptResult({ aborted: true });
    });
    mockedRunEmbeddedAttempt.mockRejectedValueOnce(new Error("native startup unavailable"));

    await expect(
      runEmbeddedAgent({
        ...pluginHarnessRunParams,
        permissionMode: "workspace",
        runId: "run-failed-permission-restart",
      }),
    ).rejects.toThrow("native startup unavailable");
    await expect(applied).resolves.toBe(false);
  });

  it("rejects harness self-escalation, widened requests, and retained authorization", async () => {
    let retained: PermissionChange | undefined;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attempt) => {
      retained = attempt.permissionChange!;
      expect(() => retained!.request("full")).toThrow("not authorized");
      expect(() => retained!.recordApplied("full")).toThrow("not authorized");
      withAuthorizedPermissionChange(retained.owner, "read-only", () => {
        expect(() => retained!.request("full")).toThrow("not authorized");
        expect(() => retained!.recordApplied("full")).toThrow("not authorized");
      });
      await expect(
        withAuthorizedPermissionChange(retained.owner, "full", async () => {
          await Promise.resolve();
          return retained!.request("full");
        }),
      ).rejects.toThrow("not authorized");
      expect(attempt.execOverrides?.mode).toBe("auto");
      return makeAttemptResult({ assistantTexts: ["Still restricted"] });
    });

    await runEmbeddedAgent({
      ...pluginHarnessRunParams,
      permissionMode: "workspace",
      runId: "run-unauthorized-permission-change",
    });

    expect(() => requestPermissionChange(retained!, "full")).toThrow("no longer active");
    expect(() => retained!.recordApplied("full")).toThrow("not authorized");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });
});

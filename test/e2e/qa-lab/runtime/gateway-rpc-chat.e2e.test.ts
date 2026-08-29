import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaLiveLaneGateway } from "../../../../extensions/qa-lab/runtime-api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

type GatewayChatMessage = {
  role?: unknown;
  content?: unknown;
  text?: unknown;
};

type GatewayChatHistory = {
  messages?: GatewayChatMessage[];
};

type GatewayChatRun = {
  runId?: unknown;
  status?: unknown;
};

type MockRequestCursor = { cursor: number };

type MockRequestSnapshot = {
  body?: Record<string, unknown>;
  cursor?: number;
  plannedToolArgs?: Record<string, unknown>;
  plannedToolName?: string;
  prompt?: string;
  toolOutput?: string;
};

type GatewayHandle = Awaited<
  ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>
>["gateway"];

const HISTORY_RETRY_TIMEOUT_MS = 10_000;
const HISTORY_RETRY_DEFAULT_MS = 250;
const HISTORY_RETRY_MIN_MS = 100;
const HISTORY_RETRY_MAX_MS = 5_000;

let gatewayOwner: ReturnType<typeof createQaLiveLaneGateway> | undefined;
let harness: Awaited<ReturnType<ReturnType<typeof createQaLiveLaneGateway>["start"]>> | undefined;

afterEach(async () => {
  if (gatewayOwner) {
    await stopQaGatewayFixture(gatewayOwner);
  }
  harness = undefined;
  gatewayOwner = undefined;
});

function messageContains(message: GatewayChatMessage, expected: string): boolean {
  return JSON.stringify(message).includes(expected);
}

function historyContainsExpectedTurns(
  history: GatewayChatHistory,
  expectedUser: string,
  expectedAssistant?: string,
): boolean {
  const messages = history.messages ?? [];
  return (
    messages.some((message) => message.role === "user" && messageContains(message, expectedUser)) &&
    (expectedAssistant === undefined ||
      messages.some(
        (message) => message.role === "assistant" && messageContains(message, expectedAssistant),
      ))
  );
}

// Transcript projection rebuilds can briefly reject chat.history. Retry only
// that structured protocol response; every other failure remains immediate.
function resolveRetryableHistoryDelayMs(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      break;
    }
    const shaped = current as {
      cause?: unknown;
      code?: unknown;
      details?: unknown;
      gatewayCode?: unknown;
      retryable?: unknown;
      retryAfterMs?: unknown;
    };
    const code = shaped.gatewayCode ?? shaped.code;
    if (code === "UNAVAILABLE" && shaped.retryable === true) {
      const detailMethod =
        typeof shaped.details === "object" && shaped.details !== null
          ? (shaped.details as { method?: unknown }).method
          : undefined;
      if (typeof detailMethod !== "string" || detailMethod === "chat.history") {
        const rawDelayMs =
          typeof shaped.retryAfterMs === "number" && Number.isFinite(shaped.retryAfterMs)
            ? shaped.retryAfterMs
            : HISTORY_RETRY_DEFAULT_MS;
        return Math.min(
          Math.max(Math.floor(rawDelayMs), HISTORY_RETRY_MIN_MS),
          HISTORY_RETRY_MAX_MS,
        );
      }
    }
    current = shaped.cause;
  }
  return null;
}

async function waitForChatHistory(params: {
  gateway: GatewayHandle;
  sessionKey: string;
  expectedUser: string;
  expectedAssistant?: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<GatewayChatHistory> {
  const timeoutMs = params.timeoutMs ?? HISTORY_RETRY_TIMEOUT_MS;
  const intervalMs = params.intervalMs ?? HISTORY_RETRY_DEFAULT_MS;
  const startedAt = Date.now();
  let lastRetryableHistoryError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    let delayMs = intervalMs;
    try {
      const history = (await params.gateway.call(
        "chat.history",
        { sessionKey: params.sessionKey, limit: 20 },
        { timeoutMs: 10_000 },
      )) as GatewayChatHistory;
      lastRetryableHistoryError = undefined;
      if (historyContainsExpectedTurns(history, params.expectedUser, params.expectedAssistant)) {
        return history;
      }
    } catch (error) {
      const retryDelayMs = resolveRetryableHistoryDelayMs(error);
      if (retryDelayMs === null) {
        throw error;
      }
      lastRetryableHistoryError = error;
      delayMs = retryDelayMs;
    }
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(delayMs, remainingMs));
  }
  const message = `timed out waiting for complete chat.history after ${timeoutMs}ms`;
  throw lastRetryableHistoryError === undefined
    ? new Error(message)
    : new Error(message, { cause: lastRetryableHistoryError });
}

async function startGatewayRpcHarness() {
  gatewayOwner = createQaLiveLaneGateway();
  harness = await gatewayOwner.start({
    repoRoot: process.cwd(),
    providerMode: "mock-openai",
    primaryModel: "mock-openai/gpt-5.6-luna",
    alternateModel: "mock-openai/gpt-5.6-luna-alt",
    transport: {
      requiredPluginIds: [],
      createGatewayConfig: () => ({}),
    },
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: false,
    mutateConfig: (cfg) => ({ ...cfg, tools: { ...cfg.tools, profile: "coding" } }),
  });
  return harness;
}

async function sendAndWait(params: {
  gateway: GatewayHandle;
  sessionKey: string;
  message: string;
  expectedPermissionMode?: string;
  expectedToolOverrides?: Record<string, unknown>;
}): Promise<void> {
  const started = (await params.gateway.call(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: false,
      idempotencyKey: randomUUID(),
      ...(params.expectedPermissionMode === undefined
        ? {}
        : { expectedPermissionMode: params.expectedPermissionMode }),
      ...(params.expectedToolOverrides === undefined
        ? {}
        : { expectedToolOverrides: params.expectedToolOverrides }),
    },
    { timeoutMs: 30_000 },
  )) as GatewayChatRun;
  expect(started.status).toBe("started");
  expect(typeof started.runId).toBe("string");

  const terminal = (await params.gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000 },
  )) as GatewayChatRun;
  expect(terminal.status).toBe("ok");
}

async function readMockJson<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`mock provider request failed: ${response.status} ${path}`);
  }
  return (await response.json()) as T;
}

describe("Gateway chat RPCs", () => {
  it("waits past a successful incomplete chat.history response", async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "expected user" },
            { role: "assistant", content: "still working" },
          ],
        })
        .mockResolvedValueOnce({
          messages: [
            { role: "user", content: "expected user" },
            { role: "assistant", content: "expected assistant" },
          ],
        });
      const pending = waitForChatHistory({
        gateway: { call } as unknown as GatewayHandle,
        sessionKey: "session-history-projection",
        expectedUser: "expected user",
        expectedAssistant: "expected assistant",
        timeoutMs: 1_000,
        intervalMs: 100,
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        messages: [{ role: "user" }, { role: "assistant" }],
      });
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it(
    "runs chat.send through agent.wait and persists both sides in chat.history",
    { timeout: 120_000 },
    async () => {
      harness = await startGatewayRpcHarness();
      const { gateway } = harness;

      const expectedReply = "GATEWAY_RPC_CHAT_OK";
      const prompt = `Gateway chat RPC QA. Reply exactly \`${expectedReply}\`.`;
      const sessionKey = `agent:qa:gateway-rpc-chat-${randomUUID()}`;
      const started = (await gateway.call(
        "chat.send",
        {
          sessionKey,
          message: prompt,
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { timeoutMs: 30_000 },
      )) as GatewayChatRun;

      expect(started.status).toBe("started");
      expect(typeof started.runId).toBe("string");

      const terminal = (await gateway.call(
        "agent.wait",
        {
          runId: started.runId,
          timeoutMs: 30_000,
        },
        { timeoutMs: 35_000 },
      )) as GatewayChatRun;
      expect(terminal.status).toBe("ok");

      const history = await waitForChatHistory({
        gateway,
        sessionKey,
        expectedUser: prompt,
        expectedAssistant: expectedReply,
      });
      const messages = history.messages ?? [];

      expect(
        messages.some((message) => message.role === "user" && messageContains(message, prompt)),
      ).toBe(true);
      expect(
        messages.some(
          (message) => message.role === "assistant" && messageContains(message, expectedReply),
        ),
      ).toBe(true);
    },
  );

  it(
    "enforces admitted session settings at final effect and rejects stale sends before dispatch",
    { timeout: 120_000 },
    async () => {
      harness = await startGatewayRpcHarness();
      const { gateway, mock } = harness;
      if (!mock) {
        throw new Error("mock provider did not start");
      }

      const sessionKey = `agent:qa:gateway-settings-authority-${randomUUID()}`;
      await sendAndWait({ gateway, sessionKey, message: "Create the proof session." });
      await expect(
        gateway.call("sessions.patch", {
          key: sessionKey,
          permissionMode: "read-only",
          toolOverrides: { webSearch: false },
        }),
      ).resolves.toMatchObject({ entry: { permissionMode: "read-only" } });

      const cursorBeforeRestricted = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      const restrictedReply = "SESSION_SETTINGS_READ_ONLY_OK";
      const sentinelPath = `${gateway.workspaceDir}/forbidden-session-settings-write.txt`;
      const restrictedPrompt = [
        "Tool progress QA check.",
        `Call the exec tool exactly once with this exact command before answering: \`printf forbidden > ${JSON.stringify(sentinelPath)}\`.`,
        `Reply exactly \`${restrictedReply}\`.`,
      ].join(" ");
      await sendAndWait({
        gateway,
        sessionKey,
        message: restrictedPrompt,
        expectedPermissionMode: "read-only",
        expectedToolOverrides: { webSearch: false },
      });

      const restrictedRequests = await readMockJson<MockRequestSnapshot[]>(
        mock.baseUrl,
        `/debug/requests?after=${cursorBeforeRestricted.cursor}`,
      );
      const plannedExec = restrictedRequests.find(
        (request) =>
          request.prompt?.includes("Tool progress QA check") && request.plannedToolName === "exec",
      );
      expect(plannedExec?.plannedToolArgs?.command).toContain(sentinelPath);
      expect(
        await fs.access(sentinelPath).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(
        restrictedRequests.some((request) =>
          /exec denied|security=deny|execution policy/iu.test(request.toolOutput ?? ""),
        ),
      ).toBe(true);
      const declaredTools = JSON.stringify(plannedExec?.body?.tools ?? []);
      expect(declaredTools).not.toMatch(/"(?:write|edit|apply_patch|web_search)"/u);

      await expect(
        gateway.call("sessions.patch", {
          key: sessionKey,
          permissionMode: "full",
          toolOverrides: null,
        }),
      ).resolves.toMatchObject({ entry: { permissionMode: "full" } });
      const cursorBeforeRejected = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      const rejectedPrompt = "REJECT_CHANGED_SETTINGS_BEFORE_IO";
      await expect(
        gateway.call("chat.send", {
          sessionKey,
          message: rejectedPrompt,
          deliver: false,
          idempotencyKey: randomUUID(),
          expectedPermissionMode: "read-only",
          expectedToolOverrides: { webSearch: false },
        }),
      ).rejects.toMatchObject({ details: { reason: "session-settings-changed" } });
      const cursorAfterRejected = await readMockJson<MockRequestCursor>(
        mock.baseUrl,
        "/debug/request-cursor",
      );
      expect(cursorAfterRejected).toEqual(cursorBeforeRejected);
      const history = (await gateway.call(
        "chat.history",
        { sessionKey, limit: 50 },
        { timeoutMs: 10_000 },
      )) as GatewayChatHistory;
      expect(JSON.stringify(history.messages ?? [])).not.toContain(rejectedPrompt);

      console.log(
        `[session-settings-authority-proof] ${JSON.stringify({
          restrictedRun: "completed",
          deniedFinalEffect: true,
          sentinelCreated: false,
          changedSettingsRejected: true,
          rejectedRequestReachedProvider: false,
          rejectedRequestReachedTranscript: false,
        })}`,
      );
    },
  );
});

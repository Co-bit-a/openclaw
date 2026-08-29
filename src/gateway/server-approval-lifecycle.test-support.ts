import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import type { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type GatewayAuxParams = Parameters<typeof createGatewayAuxHandlers>[0];
type ApprovalHarnessOptions = Pick<
  GatewayAuxParams,
  | "onAgentRunAuthorityClosed"
  | "onApprovalLifecycle"
  | "validateAgentRuntimeDelegatedAuthority"
  | "registerWorkerTurnClaimClosedHandler"
>;

export function registerGatewayApprovalLifecycleCases(
  createHarness: (params?: ApprovalHarnessOptions) => ReturnType<typeof createGatewayAuxHandlers>,
): void {
  it("shares one approval epoch per gateway lifetime and rotates it on restart", () => {
    const first = createHarness();
    const second = createHarness();

    expect(first.execApprovalManager.runtimeEpoch).toBe(first.pluginApprovalManager.runtimeEpoch);
    expect(second.execApprovalManager.runtimeEpoch).toBe(second.pluginApprovalManager.runtimeEpoch);
    expect(first.execApprovalManager.runtimeEpoch).not.toBe(
      second.execApprovalManager.runtimeEpoch,
    );
  });

  it("cancels generation approvals without closing whole-run capabilities", async () => {
    const onAgentRunAuthorityClosed = vi.fn();
    const gatewayAux = createHarness({
      onAgentRunAuthorityClosed,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const operationalRunInstance = Object.freeze({
      instanceId: "egress-proxy-instance",
      runId: "egress-proxy-run",
    });
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const generation = new AbortController();
    const scoped = claimAgentRunApprovalAuthority(authority, [generation.signal]);
    const record = gatewayAux.execApprovalManager.create({ command: "echo old" }, 2_000);
    record.agentRuntimeDelegatedAuthority = { ...scoped, kind: "local" };
    const pending = gatewayAux.execApprovalManager.register(record, 2_000);

    generation.abort();

    await expect(pending).resolves.toBeNull();
    expect(gatewayAux.execApprovalManager.getSnapshot(record.id)?.status).toBe("cancelled");
    expect(onAgentRunAuthorityClosed).not.toHaveBeenCalled();
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);

    releaseAgentRunDelegatedAuthority(authority);

    expect(onAgentRunAuthorityClosed).toHaveBeenCalledOnce();
    expect(onAgentRunAuthorityClosed).toHaveBeenCalledWith(
      expect.objectContaining({ operationalRunInstance }),
    );
    gatewayAux.unregisterApprovalAuthorityObserver();
  });

  it("publishes exec.approval.resolved when the gateway timeout expires an approval", async () => {
    vi.useFakeTimers();
    try {
      const gatewayAux = createHarness();
      const broadcast = vi.fn();
      const publishResolved = vi.fn();
      gatewayAux.bindApprovalPublicationContext({
        broadcast,
        broadcastToConnIds: vi.fn(),
        approvalEvents: { publishResolved },
        logGateway: { error: vi.fn() },
      } as never);
      const record = gatewayAux.execApprovalManager.create(
        { command: "echo expires" },
        1_000,
        "exec-timeout-publish",
      );
      const decision = gatewayAux.execApprovalManager.register(record, 1_000);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(decision).resolves.toBeNull();
      // The gateway clock owns expiry: reviewer surfaces must receive the
      // terminal event instead of pruning on their own (skewed) clocks.
      await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(1));
      expect(broadcast).toHaveBeenCalledWith(
        "exec.approval.resolved",
        expect.objectContaining({ id: "exec-timeout-publish", decision: "deny" }),
        expect.anything(),
      );
      gatewayAux.unregisterApprovalAuthorityObserver();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles and publishes both approval kinds from the production worker-claim observer", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "openclaw-aux-worker-"));
    closeOpenClawStateDatabaseForTest();
    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    const placements = createWorkerSessionPlacementStore({ database });
    const identity = {
      sessionId: "session-worker-close",
      agentId: "main",
      sessionKey: "agent:main:worker-close",
    };
    let placement = placements.startDispatch(identity);
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "requested",
      to: "provisioning",
      expectedGeneration: placement.generation,
      patch: { environmentId: "worker-env" },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "provisioning",
      to: "syncing",
      expectedGeneration: placement.generation,
      patch: { workerBundleHash: "a".repeat(64) },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "syncing",
      to: "starting",
      expectedGeneration: placement.generation,
      patch: {
        workspaceBaseManifestRef: `sha256:${"b".repeat(64)}`,
        remoteWorkspaceDir: "/workspace/worker-close",
      },
    });
    placement = placements.transition({
      sessionId: identity.sessionId,
      from: "starting",
      to: "active",
      expectedGeneration: placement.generation,
      patch: { activeOwnerEpoch: 7 },
    });
    if (placement.state !== "active") {
      throw new Error("expected active worker placement");
    }
    const operationalRunInstance = Object.freeze({
      instanceId: "worker-operational-instance",
      runId: "worker-run-close",
    });
    const runAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const turnClaim = placements.claimTurn({
      ...identity,
      claimId: "worker-claim-close",
      runId: operationalRunInstance.runId,
      owner: {
        kind: "worker",
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
    });
    const authority = { kind: "worker" as const, ...runAuthority, turnClaim };
    const validateAuthority = createAgentRuntimeApprovalAuthorityValidator(placements);
    const lifecycle = vi.fn();
    const gatewayAux = createHarness({
      onApprovalLifecycle: lifecycle,
      validateAgentRuntimeDelegatedAuthority: (candidate) =>
        validateAuthority({
          kind: "agentRuntime",
          agentId: identity.agentId,
          sessionKey: identity.sessionKey,
          operationalRunInstance: candidate.operationalRunInstance,
          delegatedAuthority: candidate,
        }),
      registerWorkerTurnClaimClosedHandler: (handler) =>
        placements.registerTurnClaimClosedHandler(handler),
    });
    const broadcast = vi.fn();
    const publishResolved = vi.fn();
    gatewayAux.bindApprovalPublicationContext({
      broadcast,
      broadcastToConnIds: vi.fn(),
      approvalEvents: { publishResolved },
      logGateway: { error: vi.fn() },
    } as never);
    const execRecord = gatewayAux.execApprovalManager.create(
      { command: "echo worker", runId: turnClaim.runId },
      60_000,
      "exec-worker-close",
    );
    execRecord.agentRuntimeDelegatedAuthority = authority;
    const execDecision = gatewayAux.execApprovalManager.register(execRecord, 60_000);
    const pluginRecord = gatewayAux.pluginApprovalManager.create(
      { title: "Worker action", description: "Close with worker claim", runId: turnClaim.runId },
      60_000,
      "plugin-worker-close",
    );
    pluginRecord.agentRuntimeDelegatedAuthority = authority;
    const pluginDecision = gatewayAux.pluginApprovalManager.register(pluginRecord, 60_000);

    placements.releaseTurn(turnClaim);

    await expect(execDecision).resolves.toBeNull();
    await expect(pluginDecision).resolves.toBeNull();
    await vi.waitFor(() => expect(publishResolved).toHaveBeenCalledTimes(2));
    expect(publishResolved.mock.calls.map((call) => call[0])).toEqual(["exec", "plugin"]);
    expect(broadcast.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.resolved",
      "plugin.approval.resolved",
    ]);
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "exec", status: "cancelled" }),
      }),
    );
    expect(lifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "terminal",
        record: expect.objectContaining({ kind: "plugin", status: "cancelled" }),
      }),
    );
    gatewayAux.unregisterApprovalAuthorityObserver();
    releaseAgentRunDelegatedAuthority(runAuthority);
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(root, { recursive: true, force: true });
  });
}

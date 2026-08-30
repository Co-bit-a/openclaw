// Gateway stop tests cover managed, system-scope, and unmanaged lifecycle paths.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../../test-utils/env.js";
import { requireMockCallArg } from "./lifecycle.test-helpers.js";

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
  stop: vi.fn(),
};
const runServiceStop = vi.fn();
const isTerminalInteractive = vi.fn(() => true);
const loadConfig = vi.hoisted(() => vi.fn(() => ({})));
const resolveGatewayPort = vi.hoisted(() => vi.fn((_cfg?: unknown, _env?: unknown) => 18_789));
const createConfigIO = vi.hoisted(() =>
  vi.fn((_opts?: { env?: Record<string, string | undefined>; observe?: boolean }) => ({
    readBestEffortConfig: async () => loadConfig(),
  })),
);
const isDefaultInstallIdentity = vi.hoisted(() => vi.fn(() => true));
type LockIdentity = { pid: number; ownerId?: string; createdAt: string; port: number };
const readActiveGatewayLockIdentity = vi.hoisted(() =>
  vi.fn<() => Promise<LockIdentity | undefined>>(),
);
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn<(port: number) => number[]>(() => []);
const signalVerifiedGatewayPidSync = vi.fn<(pid: number, signal: "SIGTERM") => void>();
const formatGatewayPidList = vi.fn<(pids: number[]) => string>((pids) => pids.join(", "));
const resolveGatewayServiceProbeHosts = vi.fn(
  async (_params: { env?: Record<string, string | undefined>; command?: unknown }) =>
    ["127.0.0.1"] as readonly string[],
);
const probePortUsage = vi.fn(
  async (_port: number, _hosts?: readonly string[]) => "free" as "free" | "busy" | "unknown",
);
type SystemdScope = { scope: "user" | "system"; unitName: string; unitPath: string };
const findInstalledSystemdGatewayScope = vi.hoisted(() =>
  vi.fn<() => Promise<SystemdScope | null>>(async () => null),
);
const stopSystemdService = vi.hoisted(() => vi.fn(async (_params?: unknown) => {}));
const appendGatewayLifecycleAudit = vi.fn();
const createGatewayLifecycleMutationAudit = vi.fn(
  (params: { action: string; source?: string }) => (mutation: { mode: string; pid?: number }) =>
    appendGatewayLifecycleAudit({
      action: params.action,
      source: params.source ?? "cli",
      ...mutation,
    }),
);
const runWithGatewayStopIntent = vi.fn(
  async (_opts: { force?: boolean; targetPid?: number }, mutate: () => Promise<unknown>) =>
    await mutate(),
);

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => loadConfig(),
  loadConfig: () => loadConfig(),
  readBestEffortConfig: async () => loadConfig(),
  resolveGatewayPort: (cfg?: unknown, env?: unknown) => resolveGatewayPort(cfg, env),
}));

vi.mock("../../config/io.js", () => ({ createConfigIO }));

vi.mock("../../config/paths.js", () => ({
  isDefaultInstallIdentity: () => isDefaultInstallIdentity(),
  resolveNativeServiceProfileConflict: () => null,
}));

vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));

vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: () => findInstalledSystemdGatewayScope(),
  restartSystemdService: vi.fn(),
  stopSystemdService: (params: unknown) => stopSystemdService(params),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  isSameGatewayLockIdentity: vi.fn(),
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  readActiveGatewayLockPort: vi.fn(),
}));

vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList: (pids: number[]) => formatGatewayPidList(pids),
  signalVerifiedGatewayPidSync: (pid: number, signal: "SIGTERM") =>
    signalVerifiedGatewayPidSync(pid, signal),
}));

vi.mock("../../infra/restart-intent.js", () => ({
  clearGatewayRestartIntentSync: vi.fn(),
  runWithGatewayStopIntent: (
    opts: { force?: boolean; targetPid?: number },
    mutate: () => Promise<unknown>,
  ) => runWithGatewayStopIntent(opts, mutate),
  writeGatewayRestartIntentSync: vi.fn(),
}));

vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts,
}));

vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage }));

vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: () => isTerminalInteractive(),
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE:
    "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force if you really mean it.",
}));

vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (params: unknown) => appendGatewayLifecycleAudit(params),
  createGatewayLifecycleMutationAudit: (params: { action: string; source?: string }) =>
    createGatewayLifecycleMutationAudit(params),
}));

vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart: vi.fn(),
  runServiceStart: vi.fn(),
  runServiceStop,
  runServiceUninstall: vi.fn(),
}));

vi.mock("./launchd-recovery.js", () => ({ recoverInstalledLaunchAgent: vi.fn() }));

vi.mock("./start-repair.js", () => ({ repairLoadedGatewayServiceForStart: vi.fn() }));

describe("runDaemonStop", () => {
  let runDaemonStop: typeof import("./lifecycle.js").runDaemonStop;
  let envSnapshot: ReturnType<typeof captureEnv>;

  async function runUnmanagedStop(opts: { json?: boolean; force?: boolean } = { json: true }) {
    let outcome: unknown;
    runServiceStop.mockImplementation(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => {
        outcome = await params.onNotLoaded?.({ stdout: process.stdout });
      },
    );
    await runDaemonStop(opts);
    return outcome;
  }

  function mockSystemdScope(unit: string) {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: unit,
      unitPath: `/etc/systemd/system/${unit}`,
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);
  }

  beforeAll(async () => {
    ({ runDaemonStop } = await import("./lifecycle.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_CONTAINER_HINT",
      "OPENCLAW_PROFILE",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_SYSTEMD_UNIT",
    ]);
    delete process.env.OPENCLAW_CONTAINER_HINT;
    service.readCommand.mockReset().mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", "18789"],
      environment: {},
    });
    service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
    service.stop.mockReset();
    runServiceStop.mockReset().mockResolvedValue(undefined);
    isTerminalInteractive.mockReset().mockReturnValue(true);
    loadConfig.mockReset().mockReturnValue({});
    resolveGatewayPort.mockReset().mockReturnValue(18_789);
    createConfigIO
      .mockReset()
      .mockImplementation(() => ({ readBestEffortConfig: async () => loadConfig() }));
    isDefaultInstallIdentity.mockReset().mockReturnValue(true);
    readActiveGatewayLockIdentity.mockReset().mockResolvedValue({
      pid: 4200,
      ownerId: "gateway-owner-old",
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 18_789,
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([]);
    signalVerifiedGatewayPidSync.mockReset();
    formatGatewayPidList.mockReset().mockImplementation((pids) => pids.join(", "));
    resolveGatewayServiceProbeHosts.mockReset().mockResolvedValue(["127.0.0.1"]);
    probePortUsage.mockReset().mockResolvedValue("free");
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    stopSystemdService.mockReset().mockResolvedValue(undefined);
    appendGatewayLifecycleAudit.mockClear();
    createGatewayLifecycleMutationAudit.mockClear();
    runWithGatewayStopIntent
      .mockReset()
      .mockImplementation(async (_opts, mutate) => await mutate());
  });

  afterEach(() => {
    envSnapshot.restore();
    vi.restoreAllMocks();
  });

  it("signals an unmanaged Gateway process", async () => {
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4300, 4300, 4400]);

    await runUnmanagedStop();

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18_789);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4300, "SIGTERM");
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4400, "SIGTERM");
    // Verified listeners win over the lock owner (pid 4200) when lsof can see them.
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalledWith(4200, "SIGTERM");
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
      action: "stop",
      source: "cli",
      mode: "sigterm",
      pid: 4300,
    });
  });

  it("blocks non-interactive stop without force before managed service access", async () => {
    isTerminalInteractive.mockReturnValue(false);
    const { defaultRuntime } = await import("../../runtime.js");
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});

    await expect(runDaemonStop({ json: true })).rejects.toThrow(
      'process.exit unexpectedly called with "1"',
    );

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("openclaw gateway run --dev"),
      }),
    );
    expect(runServiceStop).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("allows a forced non-interactive managed stop", async () => {
    isTerminalInteractive.mockReturnValue(false);

    await runDaemonStop({ json: true, force: true });

    expect(runServiceStop).toHaveBeenCalledTimes(1);
  });

  it("allows forced non-interactive unmanaged stop fallback", async () => {
    isTerminalInteractive.mockReturnValue(false);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4200]);

    await runUnmanagedStop({ json: true, force: true });

    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(runWithGatewayStopIntent).toHaveBeenCalledWith(
      { force: true, targetPid: 4200 },
      expect.any(Function),
    );
  });

  it("routes macOS disable stops through the service manager when not loaded", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    await runDaemonStop({ json: true, disable: true });

    const stopParams = requireMockCallArg(runServiceStop, "runServiceStop") as {
      opts?: unknown;
      stopWhenNotLoaded?: unknown;
    };
    expect(stopParams.opts).toEqual({ json: true, disable: true });
    expect(stopParams.stopWhenNotLoaded).toBe(true);
  });

  it("stops a running disabled systemd unit through the service manager", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await runUnmanagedStop();

    expect(service.stop).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env, stdout: process.stdout }),
    );
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("conveys a forced intent before stopping a running disabled systemd unit", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running", pid: 4200 });

    await runUnmanagedStop({ json: true, force: true });

    expect(runWithGatewayStopIntent).toHaveBeenCalledWith(
      { force: true, targetPid: 4200 },
      expect.any(Function),
    );
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it("skips Gateway port resolution when the service manager handles the stop", async () => {
    await runDaemonStop({ json: true });

    expect(service.readCommand).not.toHaveBeenCalled();
    expect(loadConfig).not.toHaveBeenCalled();
    expect(resolveGatewayPort).not.toHaveBeenCalled();
  });

  it("stops the locked Gateway owner when listener discovery finds nothing", async () => {
    const outcome = await runUnmanagedStop();

    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM");
    expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "stop", mode: "sigterm", pid: 4200 }),
    );
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      result: "stopped",
      message: "Gateway stop signal sent to unmanaged process on port 18789: 4200.",
    });
  });

  it("stops the active lock port when the configured port has drifted", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue({
      pid: 4300,
      createdAt: "2026-07-16T12:00:00.000Z",
      port: 39_471,
    });

    await runUnmanagedStop();

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(39_471);
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4300, "SIGTERM");
  });

  it("delegates system-scope stop to systemctl without unmanaged signaling when root", async () => {
    mockSystemdScope("openclaw-gateway.service");

    await expect(runUnmanagedStop()).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );

    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("conveys a forced intent before a system-scope systemd stop", async () => {
    mockSystemdScope("openclaw-gateway.service");

    await expect(runUnmanagedStop({ json: true, force: true })).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );

    expect(runWithGatewayStopIntent).toHaveBeenCalledWith(
      { force: true, targetPid: 4200 },
      expect.any(Function),
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it("surfaces systemd sudo guidance and never signals for a system-scope unit", async () => {
    mockSystemdScope("openclaw-gateway.service");
    stopSystemdService.mockRejectedValue(
      new Error(
        "openclaw-gateway.service is a system-scope unit (/etc/systemd/system/openclaw-gateway.service); run `sudo systemctl stop openclaw-gateway.service` to stop it",
      ),
    );

    await expect(runUnmanagedStop()).rejects.toThrow(
      /sudo systemctl stop openclaw-gateway\.service/,
    );
    expect(stopSystemdService).toHaveBeenCalled();
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
  });

  it.each([
    ["free", undefined],
    ["busy", "Port 18789 is in use but the owning process could not be identified"],
    ["unknown", "Could not determine whether port 18789 is still in use"],
  ] as const)(
    "handles an unowned Gateway port reported as %s",
    async (portUsage, expectedError) => {
      readActiveGatewayLockIdentity.mockResolvedValue(undefined);
      probePortUsage.mockResolvedValue(portUsage);

      const outcome = runUnmanagedStop();
      if (expectedError) {
        await expect(outcome).rejects.toThrow(expectedError);
      } else {
        await expect(outcome).resolves.toBeNull();
      }
    },
  );

  it("resolves port and probe hosts from selected service config and environment", async () => {
    const serviceCommand = {
      programArguments: ["openclaw", "gateway"],
      environment: { OPENCLAW_STATE_DIR: "/tmp/service-state" },
    };
    service.readCommand.mockResolvedValue(serviceCommand);
    loadConfig.mockReturnValue({ gateway: { port: 18_789 } });
    createConfigIO.mockImplementation((opts) => ({
      readBestEffortConfig: async () => ({
        gateway: { port: opts?.env?.OPENCLAW_STATE_DIR === "/tmp/service-state" ? 19_000 : 18_789 },
      }),
    }));
    resolveGatewayPort.mockImplementation(
      (cfg) => (cfg as { gateway?: { port?: number } } | undefined)?.gateway?.port ?? 18_789,
    );
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    probePortUsage.mockResolvedValue("busy");

    await expect(runUnmanagedStop()).rejects.toThrow(/Port 19000/);
    expect(resolveGatewayServiceProbeHosts).toHaveBeenCalledWith(
      expect.objectContaining({ command: serviceCommand }),
    );
    expect(probePortUsage).toHaveBeenCalledWith(19_000, ["127.0.0.1"]);
  });
});

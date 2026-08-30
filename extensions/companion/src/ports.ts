import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { runExec } from "openclaw/plugin-sdk/process-runtime";

const MAX_LISTENER_OUTPUT_BYTES = 2 * 1024 * 1024;
const LISTENER_SCAN_TIMEOUT_MS = 3_000;

export type PortRegistration = {
  project: string;
  service: string;
  port: number;
  protocol: "tcp";
  note?: string;
  updatedAtMs: number;
};

export type PortListener = {
  address: string;
  port: number;
  pid: number;
  command?: string;
};

export type PortRegistrationStore = PluginStateKeyedStore<PortRegistration>;

export type PortStatus = {
  scannedAtMs: number;
  platform: NodeJS.Platform;
  summary: {
    registrations: number;
    declaredConflictPorts: number;
    occupiedRegisteredPorts: number;
    freeRegisteredPorts: number;
    unregisteredListeners: number;
  };
  registrations: Array<
    PortRegistration & {
      state: "conflict" | "occupied" | "free";
      declaredConflicts: Array<Pick<PortRegistration, "project" | "service">>;
      listeners: PortListener[];
    }
  >;
  unregisteredListeners?: PortListener[];
  scanError?: string;
};

function parsePort(endpoint: string): number | undefined {
  const match = /:(\d+)$/u.exec(endpoint.trim());
  if (!match) {
    return undefined;
  }
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function dedupeAndSortListeners(listeners: PortListener[]): PortListener[] {
  const unique = new Map<string, PortListener>();
  for (const listener of listeners) {
    unique.set(`${listener.pid}\0${listener.address}\0${listener.port}`, listener);
  }
  const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return [...unique.values()].toSorted(
    (left, right) =>
      left.port - right.port ||
      left.pid - right.pid ||
      compareText(left.address, right.address) ||
      compareText(left.command ?? "", right.command ?? ""),
  );
}

function parseLsofListeners(stdout: string): PortListener[] {
  const listeners: PortListener[] = [];
  let pid: number | undefined;
  let command: string | undefined;

  for (const line of stdout.split(/\r?\n/u)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const parsedPid = Number(value);
      pid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
      command = undefined;
      continue;
    }
    if (field === "c") {
      command = value.trim().slice(0, 128) || undefined;
      continue;
    }
    if (field !== "n" || pid === undefined) {
      continue;
    }
    const address = value.trim();
    const port = parsePort(address);
    if (port !== undefined) {
      listeners.push({ address, port, pid, ...(command ? { command } : {}) });
    }
  }

  return dedupeAndSortListeners(listeners);
}

function parseWindowsNetstatListeners(stdout: string): PortListener[] {
  const listeners: PortListener[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || columns[0]?.toUpperCase() !== "TCP") {
      continue;
    }
    const state = columns.at(-2)?.toUpperCase();
    const pid = Number(columns.at(-1));
    const address = columns[1] ?? "";
    const port = parsePort(address);
    if (state === "LISTENING" && Number.isSafeInteger(pid) && pid > 0 && port !== undefined) {
      listeners.push({ address, port, pid });
    }
  }
  return dedupeAndSortListeners(listeners);
}

export async function scanTcpListeners(
  platform: NodeJS.Platform = process.platform,
  runner: typeof runExec = runExec,
): Promise<PortListener[]> {
  if (platform === "win32") {
    const { stdout } = await runner("netstat", ["-ano", "-p", "tcp"], {
      logOutput: false,
      maxBuffer: MAX_LISTENER_OUTPUT_BYTES,
      timeoutMs: LISTENER_SCAN_TIMEOUT_MS,
    });
    return parseWindowsNetstatListeners(stdout);
  }

  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`TCP listener scanning is not supported on ${platform}`);
  }
  const { stdout } = await runner("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
    logOutput: false,
    maxBuffer: MAX_LISTENER_OUTPUT_BYTES,
    timeoutMs: LISTENER_SCAN_TIMEOUT_MS,
  });
  return parseLsofListeners(stdout);
}

function registrationKey(project: string, service: string): string {
  const digest = createHash("sha256").update(`${project}\0${service}`).digest("hex");
  return `v1:${digest}`;
}

export async function upsertPortRegistration(params: {
  store: PortRegistrationStore;
  project: string;
  service: string;
  port: number;
  note?: string;
  now?: () => number;
}): Promise<PortRegistration> {
  const registration: PortRegistration = {
    project: params.project,
    service: params.service,
    port: params.port,
    protocol: "tcp",
    ...(params.note ? { note: params.note } : {}),
    updatedAtMs: (params.now ?? Date.now)(),
  };
  await params.store.register(registrationKey(params.project, params.service), registration);
  return registration;
}

export async function removePortRegistration(params: {
  store: PortRegistrationStore;
  project: string;
  service: string;
}): Promise<boolean> {
  return await params.store.delete(registrationKey(params.project, params.service));
}

export async function buildPortStatus(params: {
  store: PortRegistrationStore;
  listeners: PortListener[];
  platform?: NodeJS.Platform;
  project?: string;
  includeUnregistered?: boolean;
  scanError?: string;
  now?: () => number;
}): Promise<PortStatus> {
  const allRegistrations = (await params.store.entries())
    .map((entry) => entry.value)
    .toSorted(
      (left, right) =>
        left.port - right.port ||
        left.project.localeCompare(right.project) ||
        left.service.localeCompare(right.service),
    );
  const visibleRegistrations = allRegistrations.filter(
    (registration) => !params.project || registration.project === params.project,
  );
  const listeners = dedupeAndSortListeners(params.listeners);
  const registrationsByPort = new Map<number, PortRegistration[]>();
  for (const registration of allRegistrations) {
    const group = registrationsByPort.get(registration.port) ?? [];
    group.push(registration);
    registrationsByPort.set(registration.port, group);
  }
  const registeredPorts = new Set(allRegistrations.map((registration) => registration.port));
  const projected = visibleRegistrations.map((registration) => {
    const declaredConflicts = (registrationsByPort.get(registration.port) ?? [])
      .filter(
        (candidate) =>
          candidate.project !== registration.project || candidate.service !== registration.service,
      )
      .map(({ project, service }) => ({ project, service }));
    const activeListeners = listeners.filter((listener) => listener.port === registration.port);
    const state: PortStatus["registrations"][number]["state"] =
      declaredConflicts.length > 0 ? "conflict" : activeListeners.length > 0 ? "occupied" : "free";
    return Object.assign({}, registration, {
      state,
      declaredConflicts,
      listeners: activeListeners,
    });
  });
  const unregisteredListeners = listeners.filter((listener) => !registeredPorts.has(listener.port));
  const declaredConflictPorts = new Set(
    projected.filter((registration) => registration.state === "conflict").map(({ port }) => port),
  ).size;

  return {
    scannedAtMs: (params.now ?? Date.now)(),
    platform: params.platform ?? process.platform,
    summary: {
      registrations: projected.length,
      declaredConflictPorts,
      occupiedRegisteredPorts: projected.filter((registration) => registration.listeners.length > 0)
        .length,
      freeRegisteredPorts: projected.filter((registration) => registration.listeners.length === 0)
        .length,
      unregisteredListeners: unregisteredListeners.length,
    },
    registrations: projected,
    ...(params.includeUnregistered ? { unregisteredListeners } : {}),
    ...(params.scanError ? { scanError: params.scanError } : {}),
  };
}

import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it } from "vitest";
import { buildPortStatus, scanTcpListeners, type PortRegistration } from "./ports.js";
import { createCompanionPortTools } from "./tools.js";

function createMemoryStore(): PluginStateKeyedStore<PortRegistration> {
  const records = new Map<string, PluginStateEntry<PortRegistration>>();
  return {
    async register(key, value) {
      records.set(key, { key, value, createdAt: Date.now() });
    },
    async registerIfAbsent(key, value) {
      if (records.has(key)) {
        return false;
      }
      records.set(key, { key, value, createdAt: Date.now() });
      return true;
    },
    async lookup(key) {
      return records.get(key)?.value;
    },
    async consume(key) {
      const value = records.get(key)?.value;
      records.delete(key);
      return value;
    },
    async delete(key) {
      return records.delete(key);
    },
    async entries() {
      return [...records.values()];
    },
    async clear() {
      records.clear();
    },
  };
}

describe("port listener parsing", () => {
  it("parses and deduplicates lsof field output", async () => {
    expect(
      await scanTcpListeners("darwin", async () => ({
        stdout: [
          "p3223",
          "cnode",
          "f15",
          "n127.0.0.1:18789",
          "f16",
          "n[::1]:18789",
          "f17",
          "n127.0.0.1:18789",
          "p99",
          "cPython",
          "n*:8000",
        ].join("\n"),
        stderr: "",
      })),
    ).toEqual([
      { address: "*:8000", port: 8000, pid: 99, command: "Python" },
      { address: "127.0.0.1:18789", port: 18789, pid: 3223, command: "node" },
      { address: "[::1]:18789", port: 18789, pid: 3223, command: "node" },
    ]);
  });

  it("parses Windows LISTENING rows and ignores established connections", async () => {
    expect(
      await scanTcpListeners("win32", async () => ({
        stdout: [
          "TCP    0.0.0.0:3000     0.0.0.0:0       LISTENING       42",
          "TCP    127.0.0.1:4000   127.0.0.1:5000  ESTABLISHED     43",
        ].join("\r\n"),
        stderr: "",
      })),
    ).toEqual([{ address: "0.0.0.0:3000", port: 3000, pid: 42 }]);
  });
});

describe("port status", () => {
  it("distinguishes declared conflicts, occupied ports, and unregistered listeners", async () => {
    const store = createMemoryStore();
    await store.register("alpha", {
      project: "alpha",
      service: "web",
      port: 3000,
      protocol: "tcp",
      updatedAtMs: 1,
    });
    await store.register("beta", {
      project: "beta",
      service: "api",
      port: 3000,
      protocol: "tcp",
      updatedAtMs: 2,
    });
    await store.register("gamma", {
      project: "gamma",
      service: "worker",
      port: 9000,
      protocol: "tcp",
      updatedAtMs: 3,
    });

    const status = await buildPortStatus({
      store,
      listeners: [
        { address: "127.0.0.1:3000", port: 3000, pid: 10, command: "node" },
        { address: "127.0.0.1:7000", port: 7000, pid: 11, command: "python" },
      ],
      includeUnregistered: true,
      platform: "darwin",
      now: () => 10,
    });

    expect(status.summary).toEqual({
      registrations: 3,
      declaredConflictPorts: 1,
      occupiedRegisteredPorts: 2,
      freeRegisteredPorts: 1,
      unregisteredListeners: 1,
    });
    expect(status.registrations.map(({ project, state }) => [project, state])).toEqual([
      ["alpha", "conflict"],
      ["beta", "conflict"],
      ["gamma", "free"],
    ]);
    expect(status.unregisteredListeners).toEqual([
      { address: "127.0.0.1:7000", port: 7000, pid: 11, command: "python" },
    ]);

    const filtered = await buildPortStatus({
      store,
      listeners: [],
      project: "alpha",
      platform: "darwin",
      now: () => 11,
    });
    expect(filtered.registrations).toMatchObject([
      {
        project: "alpha",
        state: "conflict",
        declaredConflicts: [{ project: "beta", service: "api" }],
      },
    ]);
  });
});

describe("companion port tools", () => {
  it("persists registrations, reports the active listener, and removes the record", async () => {
    const store = createMemoryStore();
    const tools = createCompanionPortTools({
      registrations: store,
      scan: async () => ({
        listeners: [{ address: "127.0.0.1:8123", port: 8123, pid: 88, command: "node" }],
      }),
      now: () => 123,
    });
    const registry = tools.find((tool) => tool.name === "companion_port_registry");
    const status = tools.find((tool) => tool.name === "companion_ports");
    expect(registry).toBeDefined();
    expect(status).toBeDefined();

    await registry?.execute("register", {
      action: "register",
      project: "alpha",
      service: "dashboard",
      port: 8123,
    });
    const listed = await status?.execute("status", {});
    expect(listed?.details).toMatchObject({
      summary: { registrations: 1, occupiedRegisteredPorts: 1 },
      registrations: [
        {
          project: "alpha",
          service: "dashboard",
          port: 8123,
          state: "occupied",
        },
      ],
    });

    await registry?.execute("remove", {
      action: "remove",
      project: "alpha",
      service: "dashboard",
    });
    expect((await store.entries()).length).toBe(0);
  });
});

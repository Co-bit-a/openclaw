import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCompanionBrowserCaptureTools } from "./browser-capture-tool.js";
import {
  BrowserCaptureService,
  type BrowserCaptureRecord,
  type BrowserCaptureSettings,
} from "./browser-capture.js";

function createMemoryStore<T>(): PluginStateKeyedStore<T> {
  const records = new Map<string, PluginStateEntry<T>>();
  return {
    async register(key, value) {
      const existing = records.get(key);
      records.set(key, { key, value, createdAt: existing?.createdAt ?? Date.now() });
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

function createHarness(params?: {
  gateway?: (method: string, request: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
}) {
  const settings = createMemoryStore<BrowserCaptureSettings>();
  const records = createMemoryStore<BrowserCaptureRecord>();
  let nextId = 0;
  const credentialedUrl = new URL("https://example.test/article?mode=preview#section");
  credentialedUrl.username = "reader";
  credentialedUrl.password = "placeholder";
  const gateway = vi.fn(
    params?.gateway ??
      (async (_method: string, request: Record<string, unknown>) => {
        if (request.path === "/tabs") {
          return {
            running: true,
            tabs: [
              {
                targetId: "tab-1",
                title: "Example",
                url: credentialedUrl.toString(),
                type: "page",
              },
              {
                targetId: "local-file",
                title: "Private file",
                url: "file:///Users/example/secret.txt",
                type: "page",
              },
            ],
          };
        }
        if (request.path === "/text") {
          return {
            ok: true,
            targetId: "tab-1",
            url: "https://example.test/article?mode=reader#other",
            text: "Visible article text",
            truncated: false,
          };
        }
        throw new Error("unexpected browser request");
      }),
  );
  const service = new BrowserCaptureService({
    settings,
    records,
    gateway: { call: gateway },
    now: params?.now ?? (() => 1_000),
    id: () => `record-${++nextId}`,
  });
  return { gateway, records, service, settings };
}

describe("companion browser capture", () => {
  it("is opt-in and persists start/stop settings independently of service lifetime", async () => {
    const { service, settings } = createHarness();
    await service.start();
    expect(await service.status()).toMatchObject({
      enabled: false,
      serviceRunning: true,
      profile: "chrome",
      intervalSeconds: 30,
      maxChars: 8_000,
    });

    expect(
      await service.configure({
        enabled: true,
        profile: "research",
        intervalSeconds: 45,
        maxChars: 4_000,
      }),
    ).toMatchObject({ enabled: true, profile: "research", intervalSeconds: 45, maxChars: 4_000 });
    expect(await settings.lookup("capture")).toMatchObject({ enabled: true, profile: "research" });

    await service.configure({ enabled: false });
    expect(await settings.lookup("capture")).toMatchObject({ enabled: false, profile: "research" });
    service.stop();
  });

  it("records bounded HTTP page text, strips URL secrets, and deduplicates unchanged content", async () => {
    const { gateway, records, service } = createHarness();

    expect(await service.captureOnce()).toMatchObject({
      attemptedTabs: 1,
      recordedTabs: 1,
      duplicateTabs: 0,
      failedTabs: 0,
    });
    expect((await records.entries()).map((entry) => entry.value)).toMatchObject([
      {
        profile: "chrome",
        targetId: "tab-1",
        title: "Example",
        url: "https://example.test/article",
        text: "Visible article text",
      },
    ]);

    expect(await service.captureOnce()).toMatchObject({
      attemptedTabs: 1,
      recordedTabs: 0,
      duplicateTabs: 1,
    });
    expect(await records.entries()).toHaveLength(1);
    expect(gateway).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        method: "GET",
        path: "/text",
        query: { profile: "chrome", targetId: "tab-1", maxChars: 8_000 },
      }),
      { timeoutMs: 20_000, scopes: ["operator.admin"] },
    );
  });

  it("caps each poll and reports per-page extraction failures without storing them", async () => {
    const tabs = Array.from({ length: 10 }, (_, index) => ({
      targetId: `tab-${index}`,
      title: `Page ${index}`,
      url: `https://example.test/${index}`,
      type: "page",
    }));
    const { records, service } = createHarness({
      gateway: async (_method, request) => {
        if (request.path === "/tabs") {
          return { running: true, tabs };
        }
        const query = request.query as { targetId?: string };
        if (query.targetId === "tab-2") {
          throw new Error("text unavailable");
        }
        return {
          ok: true,
          targetId: query.targetId,
          text: `Text for ${query.targetId}`,
          truncated: false,
        };
      },
    });

    expect(await service.captureOnce()).toMatchObject({
      attemptedTabs: 8,
      recordedTabs: 7,
      failedTabs: 1,
      skippedTabs: 2,
    });
    expect(await records.entries()).toHaveLength(7);
  });

  it("rejects a tab that navigates to a non-web URL during text extraction", async () => {
    const { records, service } = createHarness({
      gateway: async (_method, request) => {
        if (request.path === "/tabs") {
          return {
            running: true,
            tabs: [
              {
                targetId: "tab-1",
                title: "Before navigation",
                url: "https://example.test/",
                type: "page",
              },
            ],
          };
        }
        return {
          ok: true,
          targetId: "tab-1",
          url: "file:///Users/example/private.txt",
          text: "private local content",
          truncated: false,
        };
      },
    });

    expect(await service.captureOnce()).toMatchObject({ recordedTabs: 0, failedTabs: 1 });
    expect(await records.entries()).toHaveLength(0);
  });

  it("returns filtered history as wrapped untrusted browser content", async () => {
    let now = 1_000;
    const { service } = createHarness({ now: () => now });
    await service.captureOnce();
    now = 2_000;

    const historyTool = createCompanionBrowserCaptureTools(service).find(
      (tool) => tool.name === "companion_browser_history",
    );
    const result = await historyTool?.execute("history", { query: "article", limit: 5 });
    expect(result?.content[0]).toMatchObject({ type: "text" });
    const text = result?.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("EXTERNAL_UNTRUSTED_CONTENT");
    expect(text).toContain("Visible article text");
    expect(result?.details).toEqual({
      count: 1,
      totalMatched: 1,
      truncated: false,
      externalContent: {
        untrusted: true,
        source: "browser",
        kind: "companion_history",
        wrapped: true,
      },
    });
  });
});

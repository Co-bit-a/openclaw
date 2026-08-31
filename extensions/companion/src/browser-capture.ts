import { createHash, randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const SETTINGS_KEY = "capture";
const DEFAULT_PROFILE = "chrome";
const DEFAULT_INTERVAL_SECONDS = 30;
const DEFAULT_MAX_CHARS = 8_000;
const MAX_TABS_PER_CAPTURE = 8;
const BROWSER_REQUEST_TIMEOUT_MS = 20_000;

export type BrowserCaptureSettings = {
  enabled: boolean;
  profile: string;
  intervalSeconds: number;
  maxChars: number;
  updatedAtMs: number;
};

export type BrowserCaptureRecord = {
  id: string;
  capturedAtMs: number;
  profile: string;
  targetId: string;
  title: string;
  url: string;
  text: string;
  truncated: boolean;
  contentHash: string;
};

type BrowserCaptureStore<T> = PluginStateKeyedStore<T>;

type BrowserGateway = {
  call: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number; scopes?: Array<"operator.admin"> },
  ) => Promise<unknown>;
};

type BrowserTab = {
  targetId?: unknown;
  title?: unknown;
  url?: unknown;
  type?: unknown;
};

export type BrowserCaptureSummary = {
  attemptedTabs: number;
  recordedTabs: number;
  duplicateTabs: number;
  failedTabs: number;
  skippedTabs: number;
  capturedAtMs: number;
  skipped?: "capture_in_progress";
};

export type BrowserCaptureStatus = {
  enabled: boolean;
  serviceRunning: boolean;
  captureInProgress: boolean;
  profile: string;
  intervalSeconds: number;
  maxChars: number;
  recordCount: number;
  lastCaptureAtMs?: number;
  lastCaptureError?: string;
};

type BrowserCaptureDeps = {
  settings: BrowserCaptureStore<BrowserCaptureSettings>;
  records: BrowserCaptureStore<BrowserCaptureRecord>;
  gateway: BrowserGateway;
  now?: () => number;
  id?: () => string;
};

function defaultSettings(now: () => number): BrowserCaptureSettings {
  return {
    enabled: false,
    profile: DEFAULT_PROFILE,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxChars: DEFAULT_MAX_CHARS,
    updatedAtMs: now(),
  };
}

function normalizeHttpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function boundedString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function contentHash(
  record: Pick<BrowserCaptureRecord, "profile" | "targetId" | "title" | "url" | "text">,
) {
  return createHash("sha256")
    .update(record.profile)
    .update("\0")
    .update(record.targetId)
    .update("\0")
    .update(record.title)
    .update("\0")
    .update(record.url)
    .update("\0")
    .update(record.text)
    .digest("hex");
}

function tabIdentity(record: Pick<BrowserCaptureRecord, "profile" | "targetId">): string {
  return `${record.profile}\0${record.targetId}`;
}

function parseTabs(raw: unknown): BrowserTab[] {
  if (!raw || typeof raw !== "object" || !("tabs" in raw) || !Array.isArray(raw.tabs)) {
    return [];
  }
  return raw.tabs.filter(
    (tab): tab is BrowserTab => tab !== null && typeof tab === "object" && !Array.isArray(tab),
  );
}

function eligibleTab(
  tab: BrowserTab,
): { targetId: string; title: string; url: string } | undefined {
  const targetId = boundedString(tab.targetId, 512);
  const url = normalizeHttpUrl(boundedString(tab.url, 16_384));
  if (!targetId || !url || (typeof tab.type === "string" && tab.type !== "page")) {
    return undefined;
  }
  return { targetId, title: boundedString(tab.title, 512), url };
}

export class BrowserCaptureService {
  private serviceRunning = false;
  private captureInProgress = false;
  private timer: NodeJS.Timeout | null = null;
  private logger: PluginLogger | undefined;
  private lastCaptureAtMs: number | undefined;
  private lastCaptureError: string | undefined;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: BrowserCaptureDeps) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  async start(logger?: PluginLogger): Promise<void> {
    this.serviceRunning = true;
    this.logger = logger;
    const settings = await this.readSettings();
    if (settings.enabled) {
      this.arm(settings.intervalSeconds);
    }
  }

  stop(): void {
    this.serviceRunning = false;
    this.disarm();
    this.logger = undefined;
  }

  async configure(params: {
    enabled: boolean;
    profile?: string;
    intervalSeconds?: number;
    maxChars?: number;
  }): Promise<BrowserCaptureStatus> {
    const current = await this.readSettings();
    const next: BrowserCaptureSettings = {
      enabled: params.enabled,
      profile: params.profile ?? current.profile,
      intervalSeconds: params.intervalSeconds ?? current.intervalSeconds,
      maxChars: params.maxChars ?? current.maxChars,
      updatedAtMs: this.now(),
    };
    await this.deps.settings.register(SETTINGS_KEY, next);
    if (this.serviceRunning && next.enabled) {
      this.arm(next.intervalSeconds);
    } else {
      this.disarm();
    }
    return await this.status();
  }

  async status(): Promise<BrowserCaptureStatus> {
    const [settings, records] = await Promise.all([
      this.readSettings(),
      this.deps.records.entries(),
    ]);
    return {
      enabled: settings.enabled,
      serviceRunning: this.serviceRunning,
      captureInProgress: this.captureInProgress,
      profile: settings.profile,
      intervalSeconds: settings.intervalSeconds,
      maxChars: settings.maxChars,
      recordCount: records.length,
      ...(this.lastCaptureAtMs !== undefined ? { lastCaptureAtMs: this.lastCaptureAtMs } : {}),
      ...(this.lastCaptureError ? { lastCaptureError: this.lastCaptureError } : {}),
    };
  }

  async history(params: { limit: number; sinceMs?: number; query?: string }): Promise<{
    records: BrowserCaptureRecord[];
    totalMatched: number;
  }> {
    const query = params.query?.trim().toLocaleLowerCase();
    const matching = (await this.deps.records.entries())
      .map((entry) => entry.value)
      .filter((record) => params.sinceMs === undefined || record.capturedAtMs >= params.sinceMs)
      .filter(
        (record) =>
          !query ||
          `${record.title}\n${record.url}\n${record.text}`.toLocaleLowerCase().includes(query),
      )
      .toSorted((left, right) => right.capturedAtMs - left.capturedAtMs);
    return { records: matching.slice(0, params.limit), totalMatched: matching.length };
  }

  async captureOnce(): Promise<BrowserCaptureSummary> {
    const capturedAtMs = this.now();
    if (this.captureInProgress) {
      return {
        attemptedTabs: 0,
        recordedTabs: 0,
        duplicateTabs: 0,
        failedTabs: 0,
        skippedTabs: 0,
        capturedAtMs,
        skipped: "capture_in_progress",
      };
    }

    this.captureInProgress = true;
    try {
      const settings = await this.readSettings();
      const listed = await this.browserRequest({
        method: "GET",
        path: "/tabs",
        query: { profile: settings.profile },
      });
      const allEligibleTabs = parseTabs(listed)
        .map(eligibleTab)
        .filter((tab): tab is NonNullable<ReturnType<typeof eligibleTab>> => tab !== undefined);
      const tabs = allEligibleTabs.slice(0, MAX_TABS_PER_CAPTURE);
      const latestByTab = new Map<string, BrowserCaptureRecord>();
      for (const entry of await this.deps.records.entries()) {
        const existing = latestByTab.get(tabIdentity(entry.value));
        if (!existing || existing.capturedAtMs < entry.value.capturedAtMs) {
          latestByTab.set(tabIdentity(entry.value), entry.value);
        }
      }

      let recordedTabs = 0;
      let duplicateTabs = 0;
      let failedTabs = 0;
      let firstError: string | undefined;
      for (const tab of tabs) {
        try {
          const rawText = await this.browserRequest({
            method: "GET",
            path: "/text",
            query: {
              profile: settings.profile,
              targetId: tab.targetId,
              maxChars: settings.maxChars,
            },
          });
          if (
            !rawText ||
            typeof rawText !== "object" ||
            !("ok" in rawText) ||
            rawText.ok !== true ||
            !("text" in rawText) ||
            typeof rawText.text !== "string"
          ) {
            throw new Error("browser page text response was invalid");
          }
          const reportedUrl = boundedString("url" in rawText ? rawText.url : undefined, 16_384);
          const currentUrl = reportedUrl ? normalizeHttpUrl(reportedUrl) : tab.url;
          if (!currentUrl) {
            throw new Error("browser page changed to an ineligible URL during capture");
          }
          const recordBase = {
            profile: settings.profile,
            targetId: tab.targetId,
            title: tab.title,
            url: currentUrl,
            text: boundedString(rawText.text, settings.maxChars),
          };
          const hash = contentHash(recordBase);
          if (latestByTab.get(tabIdentity(recordBase))?.contentHash === hash) {
            duplicateTabs += 1;
            continue;
          }
          const record: BrowserCaptureRecord = {
            id: this.id(),
            capturedAtMs,
            ...recordBase,
            truncated: "truncated" in rawText && rawText.truncated === true,
            contentHash: hash,
          };
          await this.deps.records.register(`${capturedAtMs}:${record.id}`, record);
          latestByTab.set(tabIdentity(record), record);
          recordedTabs += 1;
        } catch (error) {
          failedTabs += 1;
          firstError ??= formatErrorMessage(error);
        }
      }

      this.lastCaptureAtMs = capturedAtMs;
      this.lastCaptureError = firstError;
      return {
        attemptedTabs: tabs.length,
        recordedTabs,
        duplicateTabs,
        failedTabs,
        skippedTabs: allEligibleTabs.length - tabs.length,
        capturedAtMs,
      };
    } catch (error) {
      this.lastCaptureError = formatErrorMessage(error);
      throw error;
    } finally {
      this.captureInProgress = false;
    }
  }

  private async readSettings(): Promise<BrowserCaptureSettings> {
    return (await this.deps.settings.lookup(SETTINGS_KEY)) ?? defaultSettings(this.now);
  }

  private async browserRequest(params: Record<string, unknown>): Promise<unknown> {
    return await this.deps.gateway.call(
      "browser.request",
      { ...params, timeoutMs: BROWSER_REQUEST_TIMEOUT_MS },
      { timeoutMs: BROWSER_REQUEST_TIMEOUT_MS, scopes: ["operator.admin"] },
    );
  }

  private arm(intervalSeconds: number): void {
    this.disarm();
    this.timer = setInterval(() => {
      void this.captureOnce().catch((error: unknown) => {
        const message = formatErrorMessage(error);
        if (message !== this.lastCaptureError) {
          this.logger?.warn(`companion browser capture: ${message}`);
        }
        this.lastCaptureError = message;
      });
    }, intervalSeconds * 1_000);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

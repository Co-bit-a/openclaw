import { expect, it } from "vitest";
import {
  resolvePluginActivationInputs,
  withActivatedPluginIds,
} from "../plugins/activation-context.js";
import {
  getReusableCachedPluginRegistry,
  resolvePluginRegistryLoadCacheKey,
} from "../plugins/loader-cache.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { coerceToFailoverError } from "./failover-error.js";

it("completes real cold Anthropic registration and its failover hook", () => {
  expect(getActivePluginRegistry()).toBeNull();
  const error = coerceToFailoverError(
    { status: 401, message: "invalid_api_key" },
    { provider: "anthropic", model: "claude-opus-4-6" },
  );
  expect(error?.reason).toBe("auth");
  expect(error?.provider).toBe("anthropic");

  // Inspect only the completed scoped registry, after the unchanged cold call.
  const activation = resolvePluginActivationInputs({
    rawConfig: withActivatedPluginIds({ pluginIds: ["anthropic"] }),
    applyAutoEnable: true,
  });
  const registry = getReusableCachedPluginRegistry(
    resolvePluginRegistryLoadCacheKey({
      config: activation.config,
      activationSourceConfig: activation.activationSourceConfig,
      autoEnabledReasons: activation.autoEnabledReasons,
      onlyPluginIds: ["anthropic"],
      activate: false,
    }),
  );
  expect(registry?.plugins.find((plugin) => plugin.id === "anthropic")).toMatchObject({
    status: "loaded",
    providerIds: expect.arrayContaining(["anthropic"]),
  });
  const hook = registry?.providers.find((entry) => entry.pluginId === "anthropic")?.provider
    .classifyFailoverReason;
  expect(hook).toBeTypeOf("function");
  expect(hook?.({ errorMessage: "provider failure", errorType: "api_error" })).toBe("server_error");
  expect(registry?.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
  expect(getActivePluginRegistry()).toBeNull();
});

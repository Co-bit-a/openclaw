import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { buildBrowserExtensionPairing, firstExtensionRelayPort } from "./extension-pairing.js";
import { ensureExtensionRelayDaemonProcess } from "./extension-relay-daemon-spawn.js";

export function buildBrowserNativeHostPairing() {
  return buildBrowserExtensionPairing({
    cfg: getRuntimeConfig(),
    localTransport: "gateway",
  });
}

export function ensureBrowserNativeRelay(entryPath: string) {
  return ensureExtensionRelayDaemonProcess({
    port: firstExtensionRelayPort(getRuntimeConfig()),
    entryPath,
  });
}

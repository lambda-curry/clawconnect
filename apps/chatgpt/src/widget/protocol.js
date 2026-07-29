// Pure MCP Apps (SEP-1865) UI-extension handshake message pieces — no DOM,
// no fetch, no timers. Inlined into shell.html by scripts/build-widget.mjs
// alongside state.js, same export-stripping convention.
//
// UI_PROTOCOL_VERSION is a separate version space from the base MCP
// protocolVersion ui-meta.ts negotiates (2025-06-18) — this one is the
// View<->Host handshake inside the sandboxed iframe. Verified against the
// installed @modelcontextprotocol/ext-apps@1.5.0 package (dist/src/
// app-bridge.js: `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS`),
// which is exactly what App.connect() sends as ui/initialize's
// protocolVersion, not trusted from a report.

export const UI_PROTOCOL_VERSION = "2026-01-26";

export const UI_APP_INFO = { name: "clawconnect-chatgpt", version: "0.0.0" };

// This view doesn't expose MCP-style tools of its own to the host and
// declares no display-mode requirement beyond what each requestDisplayMode
// call already negotiates — an empty object is the correct, honest
// declaration, not a placeholder for something unimplemented.
export const UI_APP_CAPABILITIES = {};

/** params for the ui/initialize request a spec-compliant MCP Apps View sends a Host on connect. Mirrors App.connect()'s exact request params shape. Returns fresh copies each call so a caller can't accidentally mutate the shared UI_APP_INFO/UI_APP_CAPABILITIES constants through the returned object. */
export function buildUiInitializeParams() {
  return {
    appInfo: { ...UI_APP_INFO },
    appCapabilities: { ...UI_APP_CAPABILITIES },
    protocolVersion: UI_PROTOCOL_VERSION,
  };
}

/** The ui/notifications/initialized notification sent after a successful ui/initialize response — no id (it's a notification, not a request), no reply expected. */
export function buildUiInitializedNotification() {
  return { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} };
}

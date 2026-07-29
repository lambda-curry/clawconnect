import { describe, expect, it } from "vitest";
import {
  UI_PROTOCOL_VERSION,
  UI_APP_INFO,
  UI_APP_CAPABILITIES,
  buildUiInitializeParams,
  buildUiInitializedNotification,
} from "./protocol.js";

describe("MCP Apps ui/initialize handshake message shapes", () => {
  it("buildUiInitializeParams matches McpUiInitializeRequest['params'] from @modelcontextprotocol/ext-apps", () => {
    const params = buildUiInitializeParams();
    expect(params).toEqual({
      appInfo: UI_APP_INFO,
      appCapabilities: UI_APP_CAPABILITIES,
      protocolVersion: UI_PROTOCOL_VERSION,
    });
    expect(params.appInfo.name).toBeTruthy();
    expect(params.appInfo.version).toBeTruthy();
  });

  it("protocolVersion matches the installed ext-apps package's LATEST_PROTOCOL_VERSION", () => {
    // Verified directly against node_modules/@modelcontextprotocol/ext-apps
    // dist/src/app-bridge.js (`var G="2026-01-26"`, exported as
    // LATEST_PROTOCOL_VERSION and as the sole entry in
    // SUPPORTED_PROTOCOL_VERSIONS) — this is a separate version space from
    // the base MCP protocolVersion negotiated in ui-meta.ts (2025-06-18).
    expect(UI_PROTOCOL_VERSION).toBe("2026-01-26");
  });

  it("appCapabilities declares no tool/display-mode capabilities this view doesn't actually have", () => {
    // Empty is the honest declaration: this view exposes no MCP-style tools
    // of its own (no `tools` key) and negotiates display mode per-call via
    // ui/request-display-mode rather than declaring it upfront.
    expect(UI_APP_CAPABILITIES).toEqual({});
  });

  it("buildUiInitializedNotification is a JSON-RPC notification — no id field, so a host never expects a reply", () => {
    const note = buildUiInitializedNotification();
    expect(note).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect("id" in note).toBe(false);
  });

  it("calling the builders repeatedly returns equal-by-value, independently mutable objects (no shared-reference footgun)", () => {
    const a = buildUiInitializeParams();
    const b = buildUiInitializeParams();
    expect(a).toEqual(b);
    a.appInfo.name = "mutated";
    expect(b.appInfo.name).not.toBe("mutated");
  });
});

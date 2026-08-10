/**
 * MCP Apps (SEP-1865) constants and pure meta builders, isolated so they're
 * directly unit-testable without spinning up the HTTP app. Constants
 * verified against the installed @modelcontextprotocol/ext-apps@1.5.0
 * package (dist/src/app.d.ts, dist/src/server/index.d.ts) rather than
 * trusted from a report — see
 * docs/architecture/2026-07-27-chatgpt-ui-reconciliation.md §1.
 *
 * ChatGPT-only: nothing here is imported by packages/mcp (the stdio
 * transport) or packages/core. A stdio/Claude Code client never sees any of
 * these keys.
 */

export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** Legacy flat alias for _meta.ui.resourceUri — hosts must check both per the SDK's own compatibility note. */
export const UI_RESOURCE_URI_META_KEY = "ui/resourceUri";

export function buildExtensionsCapability(widgetEnabled: boolean): Record<string, unknown> | undefined {
  if (!widgetEnabled) return undefined;
  return { [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME_TYPE] } };
}

/** _meta for the one tool that mounts the widget (run_task only). Empty when the widget is disabled — no resourceUri, no visibility grant, nothing for a host to act on. */
export function buildMountMeta(widgetEnabled: boolean, resourceUri: string): Record<string, unknown> {
  if (!widgetEnabled) return {};
  return {
    ui: { resourceUri, visibility: ["model", "app"] },
    [UI_RESOURCE_URI_META_KEY]: resourceUri,
    "openai/outputTemplate": resourceUri,
    "openai/widgetAccessible": true,
  };
}

/** _meta for a tool the mounted widget may call (get_task/list_tasks/get_session) — app-callable, but does NOT itself mount a card. Without this, the widget's own reads would be refused by a spec-compliant host. */
export function buildAppCallableMeta(widgetEnabled: boolean): Record<string, unknown> {
  if (!widgetEnabled) return {};
  return {
    ui: { visibility: ["model", "app"] },
    "openai/widgetAccessible": true,
  };
}

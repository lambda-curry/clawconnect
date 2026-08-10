import { describe, expect, it } from "vitest";
import {
  buildExtensionsCapability,
  buildMountMeta,
  buildAppCallableMeta,
  UI_EXTENSION_ID,
  UI_RESOURCE_MIME_TYPE,
  UI_RESOURCE_URI_META_KEY,
} from "./ui-meta.js";

describe("missing UI metadata fallback — widget disabled means no _meta/capability at all", () => {
  it("buildExtensionsCapability is undefined when the widget is disabled", () => {
    expect(buildExtensionsCapability(false)).toBeUndefined();
  });

  it("buildExtensionsCapability advertises the exact mimeType when enabled", () => {
    expect(buildExtensionsCapability(true)).toEqual({ [UI_EXTENSION_ID]: { mimeTypes: [UI_RESOURCE_MIME_TYPE] } });
  });

  it("buildMountMeta is an empty object when disabled — no resourceUri leaks", () => {
    expect(buildMountMeta(false, "ui://x")).toEqual({});
  });

  it("buildMountMeta carries both the modern and legacy resourceUri keys when enabled", () => {
    const meta = buildMountMeta(true, "ui://clawconnect/task-center-v1.html");
    expect(meta.ui).toEqual({ resourceUri: "ui://clawconnect/task-center-v1.html", visibility: ["model", "app"] });
    expect(meta[UI_RESOURCE_URI_META_KEY]).toBe("ui://clawconnect/task-center-v1.html");
    expect(meta["openai/outputTemplate"]).toBe("ui://clawconnect/task-center-v1.html");
  });

  it("buildAppCallableMeta is empty when disabled, grants visibility without a resourceUri when enabled", () => {
    expect(buildAppCallableMeta(false)).toEqual({});
    const meta = buildAppCallableMeta(true);
    expect(meta.ui).toEqual({ visibility: ["model", "app"] });
    expect(meta).not.toHaveProperty(UI_RESOURCE_URI_META_KEY);
    expect(meta).not.toHaveProperty("openai/outputTemplate");
  });
});

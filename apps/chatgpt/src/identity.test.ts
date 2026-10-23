import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdentityResolver } from "./identity.ts";

const fixtures: string[] = [];
const alice = { principalId: "p-alice", loginEmail: "alice@example.test" };
const record = { token: "test-personal-token", ...alice };

function tokenFile(contents: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "clawconnect-identity-"));
  fixtures.push(directory);
  const file = join(directory, "tokens.json");
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

function request(authorization?: string) {
  return { headers: authorization === undefined ? {} : { authorization } };
}

const url = new URL("http://localhost/mcp");

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("HTTP token identity", () => {
  it.each([
    { Alice: record },
    { tokens: { Alice: record } },
    [{ name: "Alice", ...record }],
  ])("resolves a bound token from each JSON format", (contents) => {
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: tokenFile(contents) });
    expect(resolver.resolve(url, request("Bearer test-personal-token"))).toEqual({
      user: "Alice",
      principal: alice,
    });
  });

  it("supports bound records in the environment", () => {
    const resolver = createIdentityResolver({ MCP_USER_TOKENS: JSON.stringify({ Alice: record }) });
    expect(resolver.resolve(new URL("http://localhost/mcp?pass=test-personal-token"), request())).toEqual({
      user: "Alice",
      principal: alice,
    });
  });

  it.each([
    { token: record.token },
    { token: record.token, principalId: alice.principalId },
    { token: record.token, loginEmail: alice.loginEmail },
    { ...record, principalId: "service" },
    { ...record, principalId: "../p-alice" },
    { ...record, loginEmail: "invalid" },
    { ...record, loginEmail: "alice@example.test\r\nother: header" },
  ])("rejects a structured record with an invalid binding", (invalid) => {
    const resolver = createIdentityResolver({ MCP_USER_TOKENS: JSON.stringify({ Alice: invalid }) });
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it("revokes a removed file token on the very next request", () => {
    const file = tokenFile({ Alice: record });
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: file });
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))?.principal).toEqual(alice);
    writeFileSync(file, "{}");
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
    expect(resolver.resolve(url, request())).toBeNull();
  });

  it("keeps the principal namespace when the token rotates", () => {
    const file = tokenFile({ Alice: record });
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: file });
    const original = resolver.resolve(url, request(`Bearer ${record.token}`));
    writeFileSync(file, JSON.stringify({ Alice: { ...record, token: "test-rotated-token" } }));
    expect(resolver.resolve(url, request("Bearer test-rotated-token"))).toEqual(original);
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it("rejects missing and unknown credentials when a configured file is missing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = tokenFile({ Alice: record });
    rmSync(file);
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: file });
    expect(resolver.resolve(url, request())).toBeNull();
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it("discards personal credentials if their file becomes unreadable", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = tokenFile({ Alice: record });
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: file });
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))?.principal).toEqual(alice);
    rmSync(file);
    // A directory is reliably unreadable as a token file, even when tests run as root.
    const unavailable = createIdentityResolver({
      MCP_USER_TOKENS_FILE: join(file, ".."),
      MCP_USER_TOKENS: JSON.stringify({ Alice: record }),
    });
    expect(unavailable.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it("never logs token configuration bytes or parser errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = tokenFile({ Alice: record });
    const resolver = createIdentityResolver({ MCP_USER_TOKENS_FILE: file });
    writeFileSync(file, `{"secret":"${record.token}`);
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(record.token);
  });

  it("does not fall back from an invalid bearer to a shared URL credential", () => {
    const resolver = createIdentityResolver({
      PUBLIC_MCP_PASS: "test-shared-pass",
      MCP_USER_TOKENS: JSON.stringify({ Alice: record }),
    });
    const sharedUrl = new URL("http://localhost/mcp?pass=test-shared-pass");
    expect(resolver.resolve(sharedUrl, request("Bearer revoked-token"))).toBeNull();
    expect(resolver.resolve(sharedUrl, request("Basic invalid"))).toBeNull();
    expect(resolver.resolve(sharedUrl, request())).toEqual({ user: null, legacy: true });
  });

  it("does not reinterpret an invalid personal binding as the shared pass", () => {
    const resolver = createIdentityResolver({
      PUBLIC_MCP_PASS: record.token,
      MCP_USER_TOKENS: JSON.stringify({ Alice: { token: record.token } }),
    });
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it.each([
    { MCP_USER_TOKENS: "Alice:test-legacy-token" },
    { MCP_USER_TOKENS: JSON.stringify({ Alice: "test-legacy-token" }) },
    { MCP_USER_TOKENS: JSON.stringify({ tokens: { Alice: "test-legacy-token" } }) },
    { MCP_USER_TOKENS: JSON.stringify([{ name: "Alice", token: "test-legacy-token" }]) },
  ])("keeps label-only legacy formats on the service path", (env) => {
    const resolver = createIdentityResolver(env);
    expect(resolver.resolve(url, request("Bearer test-legacy-token"))).toEqual({ user: "Alice" });
  });

  it("does not choose between conflicting bindings or duplicate credentials", () => {
    const resolver = createIdentityResolver({
      MCP_USER_TOKENS: JSON.stringify([
        { name: "Alice", ...record },
        { name: "Alice", ...record, token: "test-another-token", loginEmail: "other@example.test" },
      ]),
    });
    expect(resolver.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
    expect(resolver.resolve(url, request("Bearer test-another-token"))).toBeNull();
    const duplicate = createIdentityResolver({
      MCP_USER_TOKENS: JSON.stringify([
        { name: "Alice", ...record },
        { name: "Other", ...record, principalId: "p-other" },
      ]),
    });
    expect(duplicate.resolve(url, request(`Bearer ${record.token}`))).toBeNull();
  });

  it("rejects a supplied unknown token when no token configuration exists", () => {
    const resolver = createIdentityResolver({});
    expect(resolver.resolve(url, request("Bearer unknown-token"))).toBeNull();
    expect(resolver.resolve(new URL("http://localhost/mcp?pass=unknown-token"), request())).toBeNull();
    expect(resolver.resolve(url, request())).toEqual({ user: null });
  });
});

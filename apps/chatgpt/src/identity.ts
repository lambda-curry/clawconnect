import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isValidHumanPrincipal } from "@clawconnect/core";
import type { HumanPrincipal, Identity } from "@clawconnect/core";

type TokenRecords = Map<string, Identity | null>;

function principalBinding(record: Record<string, unknown>): HumanPrincipal | null {
  if (!isValidHumanPrincipal(record)) return null;
  return { principalId: record.principalId, loginEmail: record.loginEmail.toLowerCase() };
}

function addToken(records: TokenRecords, name: unknown, token: unknown, identity: Identity | null) {
  if (typeof token !== "string" || !token.trim()) return;
  const key = token.trim();
  // Ambiguous credentials cannot select an identity by insertion order.
  records.set(key, records.has(key) || typeof name !== "string" || !name.trim() ? null : identity);
}

function addRecord(records: TokenRecords, name: unknown, value: unknown) {
  if (typeof value === "string") {
    addToken(records, name, value, typeof name === "string" ? { user: name.trim() } : null);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const principal = principalBinding(record);
  addToken(
    records,
    name,
    record.token,
    principal && typeof name === "string" ? { user: name.trim(), principal } : null,
  );
}

function parseJson(raw: string): TokenRecords {
  const parsed: unknown = JSON.parse(raw);
  const records: TokenRecords = new Map();
  if (Array.isArray(parsed)) {
    for (const value of parsed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      // The original array format is also a label-only legacy credential.
      const legacy = !("principalId" in record) && !("loginEmail" in record);
      addRecord(records, record.name, legacy ? record.token : record);
    }
    return records;
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid token configuration");
  const object = parsed as Record<string, unknown>;
  const values = "tokens" in object ? object.tokens : object;
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("Invalid token configuration");
  }
  for (const [name, value] of Object.entries(values)) addRecord(records, name, value);
  return records;
}

function parseEnv(raw: string | undefined): TokenRecords {
  if (!raw?.trim()) return new Map();
  if (raw.trim().startsWith("[") || raw.trim().startsWith("{")) return parseJson(raw);
  const records: TokenRecords = new Map();
  for (const pair of raw.split(",")) {
    const separator = pair.indexOf(":");
    if (separator < 1) continue;
    addRecord(records, pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return records;
}

/** Credentials are revalidated for every HTTP request, including file revocation. */
export function createIdentityResolver(env: NodeJS.ProcessEnv = process.env) {
  const sharedPass = env.PUBLIC_MCP_PASS ?? "";
  const tokenFile = env.MCP_USER_TOKENS_FILE?.trim();
  const personalConfigured = Boolean(tokenFile || env.MCP_USER_TOKENS?.trim());
  let envRecords: TokenRecords;
  let envValid = true;
  try {
    envRecords = parseEnv(env.MCP_USER_TOKENS);
  } catch {
    console.warn("[mcp] invalid personal token configuration");
    envRecords = new Map();
    envValid = false;
  }

  function loadRecords(): TokenRecords | null {
    if (!envValid) return null;
    const records = new Map(envRecords);
    if (tokenFile) {
      try {
        for (const [token, identity] of parseJson(readFileSync(tokenFile, "utf8"))) {
          records.set(token, records.has(token) ? null : identity);
        }
      } catch {
        // Error messages from JSON.parse can contain the secret being parsed.
        console.warn("[mcp] personal token file unavailable or invalid");
        return null;
      }
    }
    const emailByPrincipal = new Map<string, string>();
    const conflicting = new Set<string>();
    for (const identity of records.values()) {
      if (!identity?.principal) continue;
      const { principalId, loginEmail } = identity.principal;
      const existing = emailByPrincipal.get(principalId);
      if (existing && existing !== loginEmail) conflicting.add(principalId);
      emailByPrincipal.set(principalId, loginEmail);
    }
    for (const [token, identity] of records) {
      if (identity?.principal && conflicting.has(identity.principal.principalId)) records.set(token, null);
    }
    return records;
  }

  function resolve(url: URL, req: Pick<IncomingMessage, "headers">): Identity | null {
    // A bearer credential wins over the URL: a revoked bearer cannot borrow a
    // valid shared pass from a second credential on the same request.
    const authorization = req.headers.authorization;
    const supplied = authorization !== undefined
      ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
      : url.searchParams.get("pass");
    const suppliedCredential = authorization !== undefined || url.searchParams.has("pass");
    if (!suppliedCredential) return !sharedPass && !personalConfigured ? { user: null } : null;
    if (!supplied) return null;
    const records = loadRecords();
    if (records?.has(supplied)) return records.get(supplied) ?? null;
    if (sharedPass && supplied === sharedPass) return { user: null, legacy: true };
    return null;
  }

  return { resolve };
}

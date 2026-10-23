import { once } from "node:events";
import { rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { GatewayPool } from "./gateway-pool.ts";

// Device identity writes are confined to a scratch home without changing the environment.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawconnect-header-test-"));
  return { ...os, homedir: () => home };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(homedir(), { recursive: true, force: true });
});

it("sends personal ownership headers on distinct WebSocket upgrades while the service socket stays unchanged", async () => {
  vi.stubEnv(
    "CLAWCONNECT_GATEWAY_HEADERS",
    JSON.stringify({
      "cf-access-authenticated-user-email": "service@example.test",
      "cf-access-jwt-assertion": "service-fixture",
      "x-forwarded-for": "203.0.113.9",
      "x-custom": "fixture",
    }),
  );
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const headers: IncomingHttpHeaders[] = [];
  server.on("connection", (socket, request) => {
    headers.push(request.headers);
    socket.send(
      JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture" } }),
    );
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as { id: string; method: string };
      if (frame.method === "connect") {
        socket.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { protocol: 4 } }),
        );
      }
    });
  });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const pool = new GatewayPool(
    {
      default: "assistant",
      source: "env",
      groups: {},
      groupLabels: {},
      agents: [
        {
          id: "assistant",
          url: `ws://127.0.0.1:${port}`,
          password: "fixture",
          openclawAgentId: "main",
        },
      ],
    },
    undefined,
    undefined,
    undefined,
    { principalIdleTimeoutMs: 500 },
  );
  try {
    const service = pool.forAgent().gateway;
    await service.connect();
    for (const name of ["alice", "bob"]) {
      const personal = pool.forPrincipal({
        principalId: `p-${name}`,
        loginEmail: `${name}@example.test`,
      });
      await personal.forAgent().gateway.connect();
    }
    await service.connect();
    expect(headers).toHaveLength(3);
    expect(headers[0]).toMatchObject({
      "cf-access-authenticated-user-email": "service@example.test",
      "cf-access-jwt-assertion": "service-fixture",
      "x-forwarded-for": "203.0.113.9",
    });
    for (const [index, email] of ["alice@example.test", "bob@example.test"].entries()) {
      expect(headers[index + 1]).toMatchObject({
        "cf-access-authenticated-user-email": email,
        "cf-access-jwt-assertion": "private-network",
        "x-forwarded-for": "192.0.2.1",
        "x-custom": "fixture",
      });
    }
    expect(server.clients.size).toBe(3);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
    await vi.waitFor(() => expect(server.clients.size).toBe(1), { timeout: 2_000 });
    const personal = pool.forPrincipal({
      principalId: "p-alice",
      loginEmail: "alice@example.test",
    });
    await personal.forAgent().gateway.connect();
    expect(server.clients.size).toBe(2);
    expect(headers).toHaveLength(4);
    expect(headers[3]["cf-access-authenticated-user-email"]).toBe("alice@example.test");
    expect(pool.forAgent().gateway).toBe(service);
  } finally {
    pool.closeAll();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { describe, expect, it } from "vitest";
import { SYNTHETIC_CLIENT_ADDRESS, parseGatewayConnectHeaders } from "./gateway-pool.js";

describe("parseGatewayConnectHeaders", () => {
  it("returns undefined for empty or invalid input", () => {
    expect(parseGatewayConnectHeaders(undefined)).toBeUndefined();
    expect(parseGatewayConnectHeaders("  ")).toBeUndefined();
    expect(parseGatewayConnectHeaders("{not json")).toBeUndefined();
    expect(parseGatewayConnectHeaders('{"a": 1}')).toBeUndefined();
  });

  it("adds the synthetic client address when identity headers are present", () => {
    const headers = parseGatewayConnectHeaders(
      '{"cf-access-authenticated-user-email":"svc@example.com","cf-access-jwt-assertion":"private-network"}',
    );
    expect(headers?.["x-forwarded-for"]).toBe(SYNTHETIC_CLIENT_ADDRESS);
    expect(headers?.["cf-access-authenticated-user-email"]).toBe("svc@example.com");
  });

  it("keeps an explicit x-forwarded-for and lowercases header names", () => {
    const headers = parseGatewayConnectHeaders(
      '{"CF-Access-Authenticated-User-Email":"svc@example.com","X-Forwarded-For":"203.0.113.9"}',
    );
    expect(headers).toEqual({
      "cf-access-authenticated-user-email": "svc@example.com",
      "x-forwarded-for": "203.0.113.9",
    });
  });

  it("does not add a client address to headers that carry no identity", () => {
    expect(parseGatewayConnectHeaders('{"x-custom":"1"}')).toEqual({ "x-custom": "1" });
  });
});

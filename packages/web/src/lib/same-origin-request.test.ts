import { afterEach, describe, expect, it, vi } from "vitest";
import { isSameOriginRequest } from "./same-origin-request";

function request(headers: Record<string, string>, url = "https://internal.example.com/api/rum") {
  return new Request(url, { method: "POST", headers });
}

afterEach(() => vi.unstubAllEnvs());

describe("isSameOriginRequest", () => {
  it.each<Record<string, string>>([
    { Origin: "https://internal.example.com" },
    { Origin: "https://public.example.com", Host: "public.example.com" },
    { Origin: "https://public.example.com", "X-Forwarded-Host": "public.example.com" },
    { Origin: "https://public.example.com:8443", Host: "public.example.com:8443" },
    { Origin: "https://internal.example.com", "Content-Type": "text/plain;charset=UTF-8" },
  ])("accepts an Origin matching a current request host: %j", (headers) => {
    expect(isSameOriginRequest(request(headers))).toBe(true);
  });

  it.each<Record<string, string>>([
    {},
    { Origin: "null" },
    { Origin: "not a URL" },
    { Origin: "https://foreign.example.com" },
    { Origin: "https://internal.example.com:8443" },
    { Origin: "https://internal.example.com.foreign.example.com" },
    { Origin: "https://foreign.example.com", "X-Forwarded-Host": "public.example.com" },
    { Origin: "http://internal.example.com" },
    { Origin: "http://public.example.com", "X-Forwarded-Host": "public.example.com" },
    { Origin: "ftp://internal.example.com" },
  ])("rejects a missing, invalid, or nonmatching Origin: %j", (headers) => {
    expect(isSameOriginRequest(request(headers))).toBe(false);
  });

  it("accepts loopback HTTP but rejects HTTPS for the same HTTP host", () => {
    const url = "http://localhost:3000/api/rum";
    expect(isSameOriginRequest(request({ Origin: "http://localhost:3000" }, url))).toBe(true);
    expect(isSameOriginRequest(request({ Origin: "https://localhost:3000" }, url))).toBe(false);
  });

  it("uses Vercel's forwarded protocol across TLS termination", () => {
    vi.stubEnv("VERCEL", "1");
    const headers = { "X-Forwarded-Host": "public.example.com", "X-Forwarded-Proto": "https" };
    const url = "http://internal.example.com/api/rum";
    expect(
      isSameOriginRequest(request({ ...headers, Origin: "https://public.example.com" }, url))
    ).toBe(true);
    expect(
      isSameOriginRequest(request({ ...headers, Origin: "http://public.example.com" }, url))
    ).toBe(false);
  });

  it("does not trust a forwarded protocol outside the known proxy runtime", () => {
    vi.stubEnv("VERCEL", undefined);
    const headers = { "X-Forwarded-Host": "public.example.com", "X-Forwarded-Proto": "http" };
    expect(isSameOriginRequest(request({ ...headers, Origin: "http://public.example.com" }))).toBe(
      false
    );
    expect(isSameOriginRequest(request({ ...headers, Origin: "https://public.example.com" }))).toBe(
      true
    );
  });

  it("compares effective default ports", () => {
    expect(
      isSameOriginRequest(
        request({ Origin: "https://public.example.com", Host: "public.example.com:443" })
      )
    ).toBe(true);
  });

  it.each(["ftp", "https,http", "invalid"])(
    "rejects an invalid trusted forwarded protocol %s",
    (protocol) => {
      vi.stubEnv("VERCEL", "1");
      expect(
        isSameOriginRequest(
          request({ Origin: "https://internal.example.com", "X-Forwarded-Proto": protocol })
        )
      ).toBe(false);
    }
  );
});

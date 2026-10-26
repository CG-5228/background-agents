import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "./same-origin-request";

function request(headers: Record<string, string>) {
  return new Request("https://internal.example.com/api/rum", { method: "POST", headers });
}

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
  ])("rejects a missing, invalid, or nonmatching Origin: %j", (headers) => {
    expect(isSameOriginRequest(request(headers))).toBe(false);
  });
});

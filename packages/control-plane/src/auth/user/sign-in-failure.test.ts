import { describe, expect, it } from "vitest";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { OAuthProviderError } from "./providers/types";
import { signInFailureLocation } from "./sign-in-failure";

describe("signInFailureLocation", () => {
  it.each([
    [new AdmissionDeniedError(), "access_denied"],
    [new AdmissionUnavailableError(), "admission_unavailable"],
    [new OAuthProviderError("provider_rejected", "sensitive provider detail"), "provider_rejected"],
    [new OAuthProviderError("provider_unavailable", "outage"), "provider_unavailable"],
    [new OAuthProviderError("malformed_response", "invalid identity"), "malformed_response"],
  ])("redirects %s using a sanitized reason", (error, reason) => {
    expect(signInFailureLocation("github", error)).toBe(`/login?error=${reason}&provider=github`);
  });

  it("leaves unexpected failures to the caller", () => {
    expect(signInFailureLocation("google", new TypeError("unexpected"))).toBeNull();
  });
});

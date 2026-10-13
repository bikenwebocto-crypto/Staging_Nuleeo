import { describe, it, expect } from "vitest";
import { describePushUnavailable } from "./onesignal";

// The user-facing copy for an unavailable push state. The reason these mappings
// are load-bearing: on an installed iOS Home Screen PWA the OneSignal SDK can
// load but never finish initialising, and we must NOT tell the user they're in
// Private Browsing (they aren't) — that was the original misdiagnosis.
describe("describePushUnavailable", () => {
  it("labels a genuine Safari private window as Private Browsing", () => {
    const { message, badge } = describePushUnavailable("private-browsing");
    expect(badge).toBe("PRIVATE");
    expect(message).toMatch(/Private Browsing/i);
  });

  it("does NOT claim Private Browsing when the SDK merely failed to initialise", () => {
    const { message, badge } = describePushUnavailable("setup-incomplete");
    expect(badge).toBe("UNAVAILABLE");
    // The core of the honesty fix: an installed PWA whose SDK stalled is not a
    // private window, so the copy must never say so.
    expect(message).not.toMatch(/private browsing/i);
    expect(message).toMatch(/couldn't be set up on this device/i);
  });

  it("falls back to a plain unsupported message for unsupported/unknown", () => {
    for (const reason of ["unsupported", null] as const) {
      const { message, badge } = describePushUnavailable(reason);
      expect(badge).toBe("UNSUPPORTED");
      expect(message).toBe("Not available in this browser");
    }
  });
});

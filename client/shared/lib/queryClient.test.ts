import { describe, it, expect } from "vitest";
import { parseApiError } from "./queryClient";

describe("parseApiError", () => {
  it("returns the fallback when the error has no message", () => {
    expect(parseApiError(null)).toBe("Something went wrong");
    expect(parseApiError(undefined)).toBe("Something went wrong");
    expect(parseApiError({})).toBe("Something went wrong");
    expect(parseApiError({ message: "" })).toBe("Something went wrong");
  });

  it("honors a caller-supplied fallback", () => {
    expect(parseApiError(null, "Couldn't save")).toBe("Couldn't save");
  });

  it("strips the leading status-code prefix added by throwIfResNotOk", () => {
    // apiRequest wraps non-2xx as `${status}: ${body}` — peel that.
    const err = new Error("404: No Olio account found for that email");
    expect(parseApiError(err)).toBe("No Olio account found for that email");
  });

  it("unwraps a JSON body's `error` field after stripping the status", () => {
    const err = new Error('404: {"error":"No Olio account found"}');
    expect(parseApiError(err)).toBe("No Olio account found");
  });

  it("falls back to the JSON body's `message` field when `error` is absent", () => {
    const err = new Error('400: {"message":"validation failed"}');
    expect(parseApiError(err)).toBe("validation failed");
  });

  it("returns the cleaned body verbatim when JSON parsing fails", () => {
    const err = new Error("500: Internal Server Error");
    expect(parseApiError(err)).toBe("Internal Server Error");
  });

  it("returns the cleaned body when the JSON has neither error nor message", () => {
    const err = new Error('200: {"ok":true}');
    expect(parseApiError(err)).toBe('{"ok":true}');
  });

  it("handles non-Error inputs that have a `message` property", () => {
    // Some libraries throw plain objects; we should still peel them.
    const err = { message: '418: {"error":"I\'m a teapot"}' };
    expect(parseApiError(err)).toBe("I'm a teapot");
  });
});

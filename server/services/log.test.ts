import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { log, logInfo, logWarn, logError } from "./log";

// Capture stdout + stderr writes so we can inspect the JSON shape.
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutLines: string[];
let stderrLines: string[];

beforeEach(() => {
  stdoutLines = [];
  stderrLines = [];
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

function parseOnly(lines: string[]): Record<string, unknown> {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]);
}

describe("log", () => {
  it("info writes one JSON line to stdout with severity INFO", () => {
    log("info", { event: "test.something" });
    expect(stderrLines).toHaveLength(0);
    const payload = parseOnly(stdoutLines);
    expect(payload.severity).toBe("INFO");
    expect(payload.event).toBe("test.something");
    expect(payload.message).toBe("test.something"); // defaults to event id
    expect(typeof payload.timestamp).toBe("string");
  });

  it("warn writes to stderr with severity WARNING", () => {
    log("warn", { event: "test.warn" });
    expect(stdoutLines).toHaveLength(0);
    const payload = parseOnly(stderrLines);
    expect(payload.severity).toBe("WARNING");
  });

  it("error writes to stderr with severity ERROR", () => {
    log("error", { event: "test.error" });
    const payload = parseOnly(stderrLines);
    expect(payload.severity).toBe("ERROR");
  });

  it("debug writes to stdout with severity DEBUG", () => {
    log("debug", { event: "test.debug" });
    const payload = parseOnly(stdoutLines);
    expect(payload.severity).toBe("DEBUG");
  });

  it("uses custom message when provided", () => {
    log("info", { event: "test", message: "custom phrasing" });
    const payload = parseOnly(stdoutLines);
    expect(payload.message).toBe("custom phrasing");
    expect(payload.event).toBe("test");
  });

  it("merges fields at the top level (searchable in Cloud Logging)", () => {
    log("info", {
      event: "rate_limit.429",
      fields: { uid: "u123", endpoint: "/api/ask", retryAfter: 60 },
    });
    const payload = parseOnly(stdoutLines);
    expect(payload.uid).toBe("u123");
    expect(payload.endpoint).toBe("/api/ask");
    expect(payload.retryAfter).toBe(60);
  });

  it("extracts name + message + bounded stack from an Error", () => {
    const err = new Error("boom");
    log("error", { event: "test.error", err });
    const payload = parseOnly(stderrLines) as {
      err: { name: string; message: string; stack: string };
    };
    expect(payload.err.name).toBe("Error");
    expect(payload.err.message).toBe("boom");
    expect(typeof payload.err.stack).toBe("string");
  });

  it("caps a long stack trace", () => {
    const err = new Error("boom");
    err.stack = "x".repeat(5000);
    log("error", { event: "test.error", err });
    const payload = parseOnly(stderrLines) as { err: { stack: string } };
    expect(payload.err.stack.length).toBeLessThanOrEqual(2000);
  });

  it("handles non-Error throws (string, number, plain object)", () => {
    log("error", { event: "test.string", err: "just a string" });
    const payload = parseOnly(stderrLines) as { err: { name: string; message: string } };
    expect(payload.err.name).toBe("NonError");
    expect(payload.err.message).toBe("just a string");
  });

  it("omits err key when no err is given", () => {
    log("info", { event: "test", fields: { ok: true } });
    const payload = parseOnly(stdoutLines);
    expect("err" in payload).toBe(false);
  });

  it("logInfo / logWarn / logError sugar wrappers route correctly", () => {
    logInfo("a.info", { x: 1 });
    logWarn("a.warn", { x: 2 });
    logError("a.error", new Error("e"), { x: 3 });
    expect(stdoutLines).toHaveLength(1);
    expect(stderrLines).toHaveLength(2);
    const info = JSON.parse(stdoutLines[0]);
    const warn = JSON.parse(stderrLines[0]);
    const err = JSON.parse(stderrLines[1]);
    expect(info.severity).toBe("INFO");
    expect(info.x).toBe(1);
    expect(warn.severity).toBe("WARNING");
    expect(warn.x).toBe(2);
    expect(err.severity).toBe("ERROR");
    expect(err.err.message).toBe("e");
    expect(err.x).toBe(3);
  });
});

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Teardown hygiene (TE-7)
// ---------------------------------------------------------------------------
// Two sources of test noise this file neutralizes:
//
// 1. "AsyncTaskManager has been destroyed" — happy-dom registers an async task
//    for every real `fetch()` and tears that bookkeeping down when the Window
//    is disposed between tests. Any component/query that fires a fetch which
//    settles *after* teardown trips that message. None of our tests exercise a
//    live network call (component tests mock their data; server tests use
//    supertest, which talks to an in-process Express app and never touches the
//    global `fetch`), so we replace `global.fetch` with an inert mock. That
//    both removes the leak (happy-dom never sees a real fetch task) and gives
//    any stray query a benign, immediately-resolved response instead of a real
//    network round-trip.
//
//    Opt-out safety: the ONE suite that drives fetch itself
//    (server/services/resend.test.ts) captures `global.fetch` at module load,
//    overwrites it per-test, and restores its captured reference in afterEach.
//    Because that captured reference is *this* stub, it stays self-consistent.
//
// 2. Raw structured-log JSON on stderr/stdout — server code uses log() from
//    server/services/log.ts, which writes one JSON line straight to
//    process.stdout/stderr. During route tests that floods the run output. We
//    swallow only those structured-log lines and pass everything else through,
//    so Vitest's own reporter output is untouched. The log() unit test
//    (server/services/log.test.ts) installs its own spy on the same methods in
//    its beforeEach and asserts on it, fully overriding this pass-through for
//    the duration of those tests.

// A minimal Response-like object good enough for the two call shapes in
// client/shared/lib/queryClient.ts (res.ok / res.status / res.text() /
// res.json()). Returns an empty success so an unmocked query resolves quietly
// rather than throwing or leaving a pending task.
function inertResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({}),
    text: async () => "",
  } as unknown as Response;
}

// A structured-log line is a single-JSON-object string ending in a newline
// that carries our log()'s signature keys (severity + event + timestamp).
// Anything that doesn't parse as that shape is reporter/diagnostic output and
// must pass through untouched.
function isStructuredLogLine(chunk: unknown): boolean {
  if (typeof chunk !== "string") return false;
  const trimmed = chunk.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return (
      typeof parsed.severity === "string" &&
      typeof parsed.event === "string" &&
      typeof parsed.timestamp === "string"
    );
  } catch {
    return false;
  }
}

beforeEach(() => {
  // Re-apply each test so the inert fetch survives even if a prior test swapped
  // it (e.g. resend.test.ts restores its captured copy — which is this stub —
  // in its own afterEach). Vitest's default config does not auto-unstub
  // globals, but re-stubbing here keeps the guarantee regardless.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => inertResponse()),
  );

  // Filter structured-log noise without hiding real output. We capture the
  // originals first so the pass-through forwards everything that isn't a log()
  // line. server/services/log.test.ts re-spies these same methods and asserts
  // on its own implementation, so this never interferes with that suite.
  const realStdout = process.stdout.write.bind(process.stdout);
  const realStderr = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    if (isStructuredLogLine(chunk)) return true;
    return (realStdout as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    if (isStructuredLogLine(chunk)) return true;
    return (realStderr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);
});

afterEach(async () => {
  // Let any in-flight microtasks (e.g. a just-resolved inert fetch feeding a
  // react-query state update) drain before the happy-dom Window is disposed,
  // so nothing settles after teardown. We deliberately flush only microtasks —
  // a few Promise ticks — and NOT a setTimeout(0): some suites
  // (server/services/rateLimit.test.ts) end with vi.useFakeTimers() still
  // active, under which a macrotask timer would never fire and hang teardown.
  // Promise resolution is unaffected by fake timers, so this is always safe.
  await Promise.resolve();
  await Promise.resolve();

  // Restore the process.std* spies. Any per-suite spies (log.test.ts) restore
  // in their own afterEach first; this unwinds whatever remains to the real
  // implementations.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

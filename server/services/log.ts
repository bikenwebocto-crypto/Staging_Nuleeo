// Structured logger. Writes one JSON object per call to stdout/stderr,
// which Cloud Logging parses into searchable fields (severity, event,
// plus whatever you put in `fields`).
//
// Why this exists: most code in this repo uses console.log/warn/error
// with ad-hoc string formats. That works, but searching Cloud Logging
// for "all rate-limit 429s in the last hour" requires a regex over
// freeform strings instead of a `jsonPayload.event = "rate_limit_429"`
// filter. This helper introduces the structure without forcing a
// repo-wide migration: new code uses log(), existing console.* stays.
//
// Cloud Logging convention (for the json: prefix mapping):
//   - severity: DEFAULT | DEBUG | INFO | NOTICE | WARNING | ERROR |
//     CRITICAL | ALERT | EMERGENCY
//   - `message` becomes the displayed text in the log viewer
//   - everything else under `jsonPayload` is searchable as a key
//
// Local dev: the JSON is human-readable; Cloud Functions runtime
// re-parses it into structured fields automatically.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_TO_SEVERITY: Record<LogLevel, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
};

export interface LogArgs {
  // Short kebab-case-or-dotted identifier — the thing being logged.
  // Stable across messages so dashboards/alerts can filter on it.
  // Examples: "rate_limit.429", "stripe.platform-disabled",
  // "user.cascade-delete", "csp.violation".
  event: string;
  // Free-form one-line message. Optional; the event id is often enough.
  message?: string;
  // Anything you want to be searchable + filterable. Numbers, strings,
  // booleans, small objects. Don't include large blobs — Cloud Logging
  // truncates entries past ~100kB.
  fields?: Record<string, unknown>;
  // Optional Error. We extract message + name + a bounded stack so the
  // log line stays under control.
  err?: unknown;
}

const MAX_STACK_LEN = 2000;

function formatErr(err: unknown): { name: string; message: string; stack?: string } | undefined {
  if (err === undefined || err === null) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ? err.stack.slice(0, MAX_STACK_LEN) : undefined,
    };
  }
  return { name: "NonError", message: String(err).slice(0, 500) };
}

export function log(level: LogLevel, args: LogArgs): void {
  const payload = {
    severity: LEVEL_TO_SEVERITY[level],
    event: args.event,
    message: args.message ?? args.event,
    ...args.fields,
    ...(args.err ? { err: formatErr(args.err) } : {}),
    timestamp: new Date().toISOString(),
  };
  const line = JSON.stringify(payload);
  // ERROR/WARNING to stderr, everything else to stdout. Matches the
  // implicit convention console.warn/error already use; Cloud Logging
  // promotes stderr lines to severity ERROR even if the body says
  // otherwise, so being consistent matters.
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

// Sugar wrappers — keep the call sites tight.
export const logInfo = (event: string, fields?: Record<string, unknown>, message?: string) =>
  log("info", { event, message, fields });
export const logWarn = (event: string, fields?: Record<string, unknown>, message?: string) =>
  log("warn", { event, message, fields });
export const logError = (event: string, err: unknown, fields?: Record<string, unknown>) =>
  log("error", { event, err, fields });

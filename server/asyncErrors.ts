import type { Express, RequestHandler } from "express";

// Express 5 forwards a rejected promise from an async route handler (or
// middleware) to the error-handling middleware natively, so this wrapper is now
// belt-and-suspenders — kept as explicit defense-in-depth rather than relying on
// the framework's implicit behavior. (Under Express 4 the rejection went
// unhandled: a handler lacking a try/catch — or awaiting something OUTSIDE its
// try — would HANG the request until the Cloud Functions timeout (~60s) on a
// transient failure like Firestore contention/quota/unavailable, the app.ts
// fallback error handler never firing. Audited gaps then: server/routes/expert.ts
// had async handlers with no try/catch; server/routes/connect.ts awaited
// rateLimit()/loadPortfolioBanking() outside the try on its Stripe
// onboarding/payout endpoints.)
//
// This patches the app's routing methods so every registered handler's return
// value is awaited and any rejection (or synchronous throw) is routed to
// next(err) → the global error handler returns a clean 500. Call ONCE in
// createApp() BEFORE any middleware/route is registered. All routes are
// app.METHOD on a single app instance (no express.Router() sub-routers), so
// patching the app covers the entire surface, including future handlers.
//
// Why not the `express-async-errors` package? Identical effect, but this is
// dependency-free, explicit, and scoped to our app rather than monkey-patching
// the global express.Router prototype.

const ROUTING_METHODS = ["get", "post", "put", "patch", "delete", "all", "use"] as const;

function wrapHandler(fn: RequestHandler): RequestHandler {
  // Leave 4-arg error-handling middleware (err, req, res, next) untouched:
  // Express detects error handlers by arity, and they already receive the error.
  if (fn.length >= 4) return fn;
  const wrapped: RequestHandler = (req, res, next) => {
    try {
      const out = (fn as (...a: unknown[]) => unknown)(req, res, next);
      if (out && typeof (out as Promise<unknown>).then === "function") {
        (out as Promise<unknown>).catch(next);
      }
    } catch (err) {
      next(err as Error);
    }
  };
  return wrapped;
}

function mapArg(arg: unknown): unknown {
  if (typeof arg === "function") return wrapHandler(arg as RequestHandler);
  // app.use / app.METHOD accept arrays of handlers too.
  if (Array.isArray(arg)) return arg.map(mapArg);
  // Strings (paths / setting names), routers, options objects — passed through.
  return arg;
}

export function enableAsyncErrorForwarding(app: Express): void {
  for (const method of ROUTING_METHODS) {
    const original = (app[method] as (...args: unknown[]) => unknown).bind(app);
    (app as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      original(...args.map(mapArg));
  }
}

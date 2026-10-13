import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { auth } from "./firebase";

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// Pull a human-readable message out of an error thrown by `apiRequest`.
// throwIfResNotOk() wraps non-2xx responses as `${status}: ${body}`. The
// body is usually JSON like `{ "error": "Not found" }` but can be plain
// text. This helper unwraps both shapes and falls back to the raw message.
//
// Centralized so callers don't keep re-implementing the same peeling logic.
export function parseApiError(err: unknown, fallback = "Something went wrong"): string {
  const raw = (err as { message?: string } | null)?.message ?? "";
  if (!raw) return fallback;
  // Strip the leading "404: " / "500: " prefix added by throwIfResNotOk.
  const cleaned = raw.replace(/^\d+:\s*/, "");
  try {
    const parsed = JSON.parse(cleaned) as { error?: string; message?: string };
    return parsed?.error ?? parsed?.message ?? cleaned;
  } catch {
    return cleaned || fallback;
  }
}

// Build the Authorization header for the current Firebase user, or undefined if signed out.
async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(await authHeader()),
    ...(data ? { "Content-Type": "application/json" } : {}),
  };

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: { on401: UnauthorizedBehavior }) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      headers: await authHeader(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});

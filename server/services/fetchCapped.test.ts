import { describe, it, expect } from "vitest";
import { readBodyCapped } from "./fetchCapped";

// Minimal fake Response: a content-length header + an optional streamable body.
function makeRes(opts: {
  contentLength?: string | null;
  chunks?: number[][];
  noBody?: boolean;
  arrayBuffer?: number[];
}): { res: Response; canceled: () => boolean } {
  let i = 0;
  let canceled = false;
  const chunks = (opts.chunks ?? []).map((c) => Uint8Array.from(c));
  const res = {
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-length" ? (opts.contentLength ?? null) : null,
    },
    body: opts.noBody
      ? null
      : {
          getReader: () => ({
            read: async () =>
              i < chunks.length
                ? { done: false, value: chunks[i++] }
                : { done: true, value: undefined },
            cancel: async () => {
              canceled = true;
            },
          }),
        },
    arrayBuffer: async () => Uint8Array.from(opts.arrayBuffer ?? []).buffer,
  } as unknown as Response;
  return { res, canceled: () => canceled };
}

describe("readBodyCapped", () => {
  it("rejects before reading when Content-Length exceeds the cap", async () => {
    const { res, canceled } = makeRes({ contentLength: "100", chunks: [[1, 2, 3]] });
    expect(await readBodyCapped(res, 50)).toBeNull();
    expect(canceled()).toBe(false); // never started reading
  });

  it("returns the buffer when the streamed body is within the cap", async () => {
    const { res } = makeRes({
      chunks: [
        [1, 2, 3],
        [4, 5],
      ],
    });
    const buf = await readBodyCapped(res, 10);
    expect(buf).not.toBeNull();
    expect(buf!.byteLength).toBe(5);
    expect([...buf!]).toEqual([1, 2, 3, 4, 5]);
  });

  it("aborts mid-stream when the body exceeds the cap despite a tiny/absent Content-Length", async () => {
    const { res, canceled } = makeRes({
      contentLength: "1", // lying
      chunks: [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12],
      ],
    });
    expect(await readBodyCapped(res, 10)).toBeNull();
    expect(canceled()).toBe(true); // reader was cancelled
  });

  it("falls back to arrayBuffer (still capped) when there is no stream", async () => {
    const ok = makeRes({ noBody: true, arrayBuffer: [1, 2, 3, 4] });
    expect((await readBodyCapped(ok.res, 10))?.byteLength).toBe(4);

    const tooBig = makeRes({ noBody: true, arrayBuffer: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    expect(await readBodyCapped(tooBig.res, 10)).toBeNull();
  });
});

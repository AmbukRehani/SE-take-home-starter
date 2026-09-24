import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { MockLanguageModelV1, simulateReadableStream } from "ai/test";
import { app } from "../app.js";

// vi.mock is hoisted above imports and consts, so shared state must use
// vi.hoisted.
const mockModel = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@ai-sdk/openai", () => ({ openai: () => mockModel.current }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected server to bind to a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server.close();
});

describe("GET /trials/:id/summary", () => {
  it("returns 200 JSON for a trial with a null response rate", async () => {
    const res = await fetch(`${baseUrl}/trials/NCT-003/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: string };
    expect(body.summary).toContain("not yet available");
  });
});

describe("GET /trials query validation", () => {
  it("rejects a search param nested as an object", async () => {
    const res = await fetch(`${baseUrl}/trials?search[a]=b`);
    expect(res.status).toBe(400);
  });

  it("rejects a repeated query param that becomes an array", async () => {
    const res = await fetch(`${baseUrl}/trials?phase=I&phase=II`);
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric minEnrollment", async () => {
    const res = await fetch(`${baseUrl}/trials?minEnrollment=abc`);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown sort field", async () => {
    const res = await fetch(`${baseUrl}/trials?sort=bogus`);
    expect(res.status).toBe(400);
  });

  it("treats minEnrollment=0 as a real filter, not a skipped one", async () => {
    const res = await fetch(`${baseUrl}/trials?minEnrollment=0`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(8);
  });
});

describe("POST /trials/:id/analyze focus validation", () => {
  it.each([
    ["missing focus", {}],
    ["an unknown focus value", { focus: "bogus" }],
    ["a prototype-pollution attempt", { focus: "constructor" }],
  ])("rejects %s without calling the model", async (_label, body) => {
    const doStream = vi.fn();
    mockModel.current = new MockLanguageModelV1({ doStream });

    const res = await fetch(`${baseUrl}/trials/NCT-001/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(doStream).not.toHaveBeenCalled();
  });
});

describe("POST /trials/:id/analyze streaming", () => {
  it("emits an SSE error event and never sends [DONE] when the model errors", async () => {
    mockModel.current = new MockLanguageModelV1({
      doStream: async () => {
        throw new Error("mock upstream 429");
      },
    });

    const res = await fetch(`${baseUrl}/trials/NCT-001/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus: "safety" }),
    });

    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("[DONE]");
  });

  it("aborts the upstream call when the client disconnects", async () => {
    let capturedSignal: AbortSignal | undefined;
    const doStream = vi.fn(async (options: { abortSignal?: AbortSignal }) => {
      capturedSignal = options.abortSignal;
      return {
        stream: simulateReadableStream({
          chunks: [{ type: "text-delta" as const, textDelta: "chunk one" }],
          initialDelayInMs: 20,
          chunkDelayInMs: 2000,
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    });
    mockModel.current = new MockLanguageModelV1({ doStream });

    const controller = new AbortController();
    const fetchPromise = fetch(`${baseUrl}/trials/NCT-001/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ focus: "safety" }),
      signal: controller.signal,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    await fetchPromise;

    await vi.waitFor(() => {
      expect(capturedSignal?.aborted).toBe(true);
    });
  });
});

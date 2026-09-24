import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { app } from "../app.js";

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

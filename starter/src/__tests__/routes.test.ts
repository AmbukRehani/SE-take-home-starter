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
    const body = await res.json();
    expect(body.summary).toContain("not yet available");
  });
});

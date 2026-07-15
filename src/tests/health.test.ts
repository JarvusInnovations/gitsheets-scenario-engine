import { describe, test, expect } from "bun:test";
import { buildTestApp } from "./helpers.ts";

describe("GET /health", () => {
  test("returns 200 with an ok status", async () => {
    const fastify = await buildTestApp();

    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });

    await fastify.close();
  });
});

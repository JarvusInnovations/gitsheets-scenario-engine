import { describe, test, expect } from "bun:test";
import Fastify from "fastify";
import { app } from "../app.ts";

describe("GET /health", () => {
  test("returns 200 with an ok status", async () => {
    const fastify = Fastify();
    await fastify.register(app);
    await fastify.ready();

    const response = await fastify.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });

    await fastify.close();
  });
});

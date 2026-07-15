// Serializer parity (specs/facade.md § Stack): "Serializer parity between
// modes uses Fastify's per-route response schemas — one schema serializes
// both backends' responses, which is itself a contract-conformance check."
//
// A `dual` route only ever declares ONE `schema.response` object in
// register-route.ts — Fastify's own fast-json-stringify serializer already
// enforces that structurally (there's no second schema to diverge from).
// This helper is the explicit, assertable half of that check: given the
// same schema object, validate a concrete response body produced by EACH
// backend against it, so a test can prove both bodies satisfy the one
// declared contract rather than relying on fast-json-stringify's
// permissive "serialize the declared shape and drop the rest" behavior to
// silently hide a mismatch.
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });

/** Throws with the ajv validation errors if `body` doesn't satisfy `schema`. */
export function assertMatchesResponseSchema(schema: object, body: unknown): void {
  const validate = ajv.compile(schema);
  if (!validate(body)) {
    throw new Error(
      `response does not satisfy the route's declared schema: ${JSON.stringify(validate.errors)}`,
    );
  }
}

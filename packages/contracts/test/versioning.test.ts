import assert from "node:assert/strict";
import test from "node:test";
import { isAdditiveSchemaChange } from "../src/index.js";

test("versioning accepts optional additions and new union members", () => {
  const oldSchema = { fields: { id: { type: "string", optional: false } }, unionMembers: ["old"] };
  assert.equal(isAdditiveSchemaChange(oldSchema, { fields: { ...oldSchema.fields, note: { type: "string", optional: true } }, unionMembers: ["old", "new"] }), true);
  assert.equal(isAdditiveSchemaChange(oldSchema, { fields: {}, unionMembers: ["old"] }), false);
});

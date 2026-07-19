import assert from "node:assert/strict";
import test from "node:test";
import { HerdrCommandLine } from "../src/client/cli.js";
import { extractEventVariants } from "../src/startup.js";

test("real Herdr schema pin is opt-in", async (context) => {
  if (process.env.HERDR_PIN_TEST !== "1") { context.skip("set HERDR_PIN_TEST=1 to exercise the installed Herdr binary"); return; }
  const schema = await new HerdrCommandLine().schema(10_000); assert.equal(schema.protocol, 16); assert.equal(schema.schema_version, 1); assert.equal(extractEventVariants(schema).length, 23);
});

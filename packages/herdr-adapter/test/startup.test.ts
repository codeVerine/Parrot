import assert from "node:assert/strict";
import test from "node:test";
import { runStartupChecks } from "../src/startup.js";
import { ProtocolMismatchError } from "../src/errors.js";
import { FakeHerdr } from "./fake-herdr.js";

test("startup pins protocol, schema, and event count", async () => {
  const fake = new FakeHerdr();
  const result = await runStartupChecks(fake, fake, { protocol: 16, schemaVersion: 1, requiredIntegrations: [], mode: "production", turnDeadlineMs: 100, graceTimerMs: 10, artifactSizeLimitBytes: 1000, watchDebounceMs: 1, reconnectBackoffMs: [], operationTimeoutMs: 100, pollIntervalMs: 5, supportedProviders: ["codex"] });
  assert.equal(result.degraded, false);
  const original = fake.schema.bind(fake);
  fake.schema = async (timeout) => ({ ...(await original(timeout)), protocol: 15 });
  await assert.rejects(() => runStartupChecks(fake, fake, { requiredIntegrations: [], mode: "production" }), ProtocolMismatchError);
});

test("development mode reports missing integrations", async () => {
  const fake = new FakeHerdr(); fake.missingIntegrations = ["codex"];
  const result = await runStartupChecks(fake, fake, { requiredIntegrations: ["codex"], mode: "development" });
  assert.deepEqual(result.missingIntegrations, ["codex"]);
  assert.equal(result.degraded, true);
});

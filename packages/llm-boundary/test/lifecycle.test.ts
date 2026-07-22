import assert from "node:assert/strict";
import test from "node:test";
import { applyObjectionTransition } from "../src/index.js";

test("legal transitions accepted; illegal rejected", () => {
  assert.equal(
    applyObjectionTransition({ current: "open", requested: "resolved", actor: "verifier" }).ok,
    true,
  );
  assert.equal(
    applyObjectionTransition({ current: "superseded", requested: "open", actor: "system" }).ok,
    false,
  );
});

test("verifier_reject keeps open", () => {
  const result = applyObjectionTransition({
    current: "accepted",
    requested: "verifier_reject",
    actor: "verifier",
  });
  assert.deepEqual(result, { ok: true, next: "open" });
});

test("only human may waive", () => {
  const denied = applyObjectionTransition({
    current: "open",
    requested: "waived",
    actor: "planner",
  });
  assert.equal(denied.ok, false);
  const allowed = applyObjectionTransition({
    current: "open",
    requested: "waived",
    actor: "human",
  });
  assert.deepEqual(allowed, { ok: true, next: "waived" });
});

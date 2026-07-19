import assert from "node:assert/strict";
import test from "node:test";
import { FAILURE_SIGNAL_MAP, TIMEOUT_SIGNAL_MAPPING } from "../src/signalmap.js";

test("every adapter error class has one fault mapping", () => {
  assert.deepEqual(FAILURE_SIGNAL_MAP.map((row) => row.errorName), ["AgentSpawnError", "TurnDeliveryError", "ResultWatchError", "ArtifactRejectedError", "ReconnectError", "ProtocolMismatchError", "DegradedModeError"]);
  assert.equal(TIMEOUT_SIGNAL_MAPPING.kind, "DeadlineExpired");
  assert.equal(TIMEOUT_SIGNAL_MAPPING.group, "observation");
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NewerSchemaError, PersistenceStore } from "../src/index.js";
import { sampleEvent, seedTurn } from "./helpers.js";

test("recovery re-discovers committed outbox events and active deadlines", () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-persistence-"));
  const path = join(dir, "parrot.db");
  const first = new PersistenceStore({ path });
  seedTurn(first);
  first.appendEvent(sampleEvent());
  assert.equal(first.recover().undispatchedEvents.length, 1);
  first.close();

  const restarted = new PersistenceStore({ path });
  const recovery = restarted.recover();
  assert.equal(recovery.undispatchedEvents[0].eventId, "event-1");
  assert.deepEqual(recovery.pendingDeadlines, [{ turnId: "turn-1", deadline: "2026-07-19T10:05:00.000Z", attempt: "primary" }]);
  restarted.close();
});

test("events reject deletes and updates except the one-time dispatch marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-events-"));
  const path = join(dir, "events.db");
  const seeded = new PersistenceStore({ path });
  seeded.appendEvent(sampleEvent());
  seeded.close();
  const raw = new DatabaseSync(path);
  assert.throws(() => raw.prepare("UPDATE events SET kind = 'TurnFailed'").run(), /append-only/);
  assert.throws(() => raw.prepare("DELETE FROM events").run(), /append-only/);
  raw.prepare("UPDATE events SET dispatched_at = ? WHERE event_id = ?").run("2026-07-19T10:01:00.000Z", "event-1");
  assert.throws(() => raw.prepare("UPDATE events SET dispatched_at = NULL WHERE event_id = ?").run("event-1"), /append-only/);
  raw.close();
});

test("startup refuses a database schema newer than the package", () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-schema-"));
  const path = join(dir, "future.db");
  const store = new PersistenceStore({ path });
  store.close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(99, "2026-07-19T10:00:00.000Z");
  db.close();
  assert.throws(() => new PersistenceStore({ path }), (error: unknown) => error instanceof NewerSchemaError);
});

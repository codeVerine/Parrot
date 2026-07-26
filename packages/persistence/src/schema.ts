export const CURRENT_SCHEMA_VERSION = 2;

export const PERSISTED_TABLES = [
  "workflows",
  "iterations",
  "turns",
  "runtime_signals",
  "events",
  "agents",
  "requirements",
  "objections",
  "decisions",
  "human_feedback",
  "artifacts",
  "usage_ledger",
] as const;

export type PersistedTable = (typeof PERSISTED_TABLES)[number];

export const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      task TEXT NOT NULL,
      config_toon TEXT NOT NULL,
      state_toon TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE iterations (
      iteration_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      state_toon TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workflow_id, iteration_number)
    );
    CREATE INDEX iterations_workflow_idx ON iterations(workflow_id, iteration_number);

    CREATE TABLE turns (
      turn_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT NOT NULL REFERENCES iterations(iteration_id),
      agent_id TEXT,
      state TEXT NOT NULL,
      attempt TEXT NOT NULL CHECK (attempt IN ('primary', 'repair')),
      deadline_at TEXT,
      prompt_path TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      nonce TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      result_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX turns_workflow_idx ON turns(workflow_id, iteration_id);
    CREATE INDEX turns_deadline_idx ON turns(deadline_at, state);

    CREATE TABLE runtime_signals (
      signal_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      classification TEXT NOT NULL CHECK (classification IN ('observation', 'fault')),
      observed_at TEXT NOT NULL,
      source TEXT NOT NULL,
      workflow_id TEXT,
      iteration_id TEXT,
      turn_id TEXT,
      agent_id TEXT,
      payload_toon TEXT NOT NULL
    );
    CREATE INDEX runtime_signals_turn_idx ON runtime_signals(turn_id, observed_at);
    CREATE INDEX runtime_signals_observed_idx ON runtime_signals(observed_at);

    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      iteration_id TEXT,
      turn_id TEXT,
      agent_id TEXT,
      payload_toon TEXT NOT NULL,
      dispatched_at TEXT
    );
    CREATE INDEX events_workflow_idx ON events(workflow_id, sequence);
    CREATE INDEX events_dispatch_idx ON events(dispatched_at, sequence);

    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      pane_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_session_id TEXT,
      agent_session_path TEXT,
      status TEXT NOT NULL,
      remap_history_toon TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(pane_id)
    );
    CREATE INDEX agents_workspace_idx ON agents(workspace_id, status);

    CREATE TABLE requirements (
      requirement_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      priority TEXT NOT NULL CHECK (priority IN ('must', 'should', 'could')),
      external_id TEXT,
      text TEXT NOT NULL
    );
    CREATE INDEX requirements_external_idx ON requirements(external_id);

    CREATE TABLE objections (
      objection_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT NOT NULL REFERENCES iterations(iteration_id),
      turn_id TEXT NOT NULL REFERENCES turns(turn_id),
      dimension TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('blocking', 'major', 'minor')),
      claim TEXT NOT NULL,
      evidence_toon TEXT NOT NULL,
      evidence_missing INTEGER NOT NULL CHECK (evidence_missing IN (0, 1)),
      status TEXT NOT NULL,
      raised_by TEXT NOT NULL,
      cluster_id TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX objections_workflow_idx ON objections(workflow_id, status, severity);
    CREATE INDEX objections_cluster_idx ON objections(cluster_id);

    CREATE TABLE decisions (
      decision_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT NOT NULL REFERENCES iterations(iteration_id),
      turn_id TEXT NOT NULL REFERENCES turns(turn_id),
      decision TEXT NOT NULL,
      chosen TEXT NOT NULL,
      alternatives_toon TEXT NOT NULL,
      reason TEXT NOT NULL,
      confidence REAL,
      objection_ids_toon TEXT NOT NULL,
      payload_toon TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX decisions_workflow_idx ON decisions(workflow_id, iteration_id);

    CREATE TABLE human_feedback (
      feedback_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT,
      turn_id TEXT,
      decision TEXT NOT NULL,
      comment TEXT,
      payload_toon TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX human_feedback_workflow_idx ON human_feedback(workflow_id, created_at);

    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT NOT NULL REFERENCES iterations(iteration_id),
      turn_id TEXT NOT NULL REFERENCES turns(turn_id),
      agent_id TEXT,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      orphan INTEGER NOT NULL CHECK (orphan IN (0, 1)),
      metadata_toon TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(turn_id, path, content_hash)
    );
    CREATE INDEX artifacts_workflow_idx ON artifacts(workflow_id, turn_id);
    CREATE INDEX artifacts_hash_idx ON artifacts(content_hash);

    CREATE TABLE usage_ledger (
      usage_id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(workflow_id),
      iteration_id TEXT,
      turn_id TEXT,
      agent_id TEXT,
      provider TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      cache_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      pricing_version TEXT NOT NULL,
      wall_clock_ms INTEGER NOT NULL,
      retry_count INTEGER NOT NULL,
      repair_count INTEGER NOT NULL,
      timeout_count INTEGER NOT NULL,
      startup_ms INTEGER NOT NULL,
      payload_toon TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX usage_workflow_idx ON usage_ledger(workflow_id, recorded_at);

    CREATE TRIGGER events_append_only_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'events are append-only');
    END;

    CREATE TRIGGER events_append_only_update
    BEFORE UPDATE ON events
    WHEN NEW.sequence IS NOT OLD.sequence
      OR NEW.event_id IS NOT OLD.event_id
      OR NEW.kind IS NOT OLD.kind
      OR NEW.occurred_at IS NOT OLD.occurred_at
      OR NEW.workflow_id IS NOT OLD.workflow_id
      OR NEW.iteration_id IS NOT OLD.iteration_id
      OR NEW.turn_id IS NOT OLD.turn_id
      OR NEW.agent_id IS NOT OLD.agent_id
      OR NEW.payload_toon IS NOT OLD.payload_toon
      OR OLD.dispatched_at IS NOT NULL
      OR NEW.dispatched_at IS NULL
    BEGIN
      SELECT RAISE(ABORT, 'events are append-only; only dispatched_at may be set once');
    END;
  `,
  `ALTER TABLE workflows ADD COLUMN post_review_stage TEXT DEFAULT NULL;`,
];

export function schemaTables(): readonly PersistedTable[] { return PERSISTED_TABLES; }

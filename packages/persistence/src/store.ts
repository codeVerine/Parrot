import { mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import {
  DecisionSchema,
  EventSchema,
  RuntimeSignalSchema,
  encodeToon,
  parseToon,
  type EventKind,
  type PlatformEvent,
  type RuntimeSignal,
} from "@platform/contracts";
import { withConfig, type PersistenceConfig } from "./config.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, schemaTables, type PersistedTable } from "./schema.js";
import type {
  AgentInput,
  ArtifactInput,
  DecisionInput,
  HumanFeedbackInput,
  IterationInput,
  ObjectionInput,
  PendingDeadline,
  RecoverySnapshot,
  RequirementInput,
  StoredEvent,
  StoredSignal,
  TurnInput,
  UsageInput,
  WorkflowInput,
} from "./types.js";

export type PersistedRow = Record<string, SQLOutputValue>;
type Row = PersistedRow;

export class NewerSchemaError extends Error {
  constructor(readonly observedVersion: number, readonly supportedVersion: number) {
    super(`Database schema version ${observedVersion} is newer than supported version ${supportedVersion}.`);
    this.name = "NewerSchemaError";
  }
}

export class PersistenceTransaction {
  constructor(private readonly db: DatabaseSync) {}

  saveWorkflow(input: WorkflowInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO workflows (workflow_id, workspace_id, status, task, config_toon, state_toon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id) DO UPDATE SET workspace_id = excluded.workspace_id, status = excluded.status,
        task = excluded.task, config_toon = excluded.config_toon, state_toon = excluded.state_toon, updated_at = excluded.updated_at
    `).run(input.workflowId, input.workspaceId, input.status, input.task, encodeToon(input.config ?? {}), encodeToon(input.state ?? {}), now, now);
  }

  saveIteration(input: IterationInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO iterations (iteration_id, workflow_id, iteration_number, status, state_toon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(iteration_id) DO UPDATE SET status = excluded.status, state_toon = excluded.state_toon, updated_at = excluded.updated_at
    `).run(input.iterationId, input.workflowId, input.iterationNumber, input.status, encodeToon(input.state ?? {}), now, now);
  }

  saveTurn(input: TurnInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO turns (turn_id, workflow_id, iteration_id, agent_id, state, attempt, deadline_at, prompt_path, prompt_hash, nonce, prompt_version, result_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET agent_id = excluded.agent_id, state = excluded.state, attempt = excluded.attempt,
        deadline_at = excluded.deadline_at, prompt_path = excluded.prompt_path, prompt_hash = excluded.prompt_hash,
        nonce = excluded.nonce, prompt_version = excluded.prompt_version, result_path = excluded.result_path, updated_at = excluded.updated_at
    `).run(input.turnId, input.workflowId, input.iterationId, input.agentId ?? null, input.state, input.attempt, input.deadlineAt ?? null, input.promptPath, input.promptHash, input.nonce, input.promptVersion, input.resultPath, now, now);
  }

  saveAgent(input: AgentInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agents (agent_id, pane_id, workspace_id, provider, role, agent_session_id, agent_session_path, status, remap_history_toon, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET pane_id = excluded.pane_id, workspace_id = excluded.workspace_id,
        provider = excluded.provider, role = excluded.role, agent_session_id = excluded.agent_session_id,
        agent_session_path = excluded.agent_session_path, status = excluded.status, remap_history_toon = excluded.remap_history_toon,
        updated_at = excluded.updated_at
    `).run(input.agentId, input.paneId, input.workspaceId, input.provider, input.role, input.sessionId ?? null, input.sessionPath ?? null, input.status, encodeToon({ history: input.remapHistory ?? [] }), now, now);
  }

  saveRequirement(input: RequirementInput): void {
    this.db.prepare(`
      INSERT INTO requirements (requirement_id, source_path, content_hash, priority, external_id, text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(requirement_id) DO UPDATE SET source_path = excluded.source_path, content_hash = excluded.content_hash,
        priority = excluded.priority, external_id = excluded.external_id, text = excluded.text
    `).run(input.requirementId, input.sourcePath, input.contentHash, input.priority, input.externalId ?? null, input.text);
  }

  saveObjection(input: ObjectionInput): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO objections (objection_id, workflow_id, iteration_id, turn_id, dimension, severity, claim, evidence_toon, evidence_missing, status, raised_by, cluster_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(objection_id) DO UPDATE SET severity = excluded.severity, claim = excluded.claim,
        evidence_toon = excluded.evidence_toon, evidence_missing = excluded.evidence_missing, status = excluded.status,
        raised_by = excluded.raised_by, cluster_id = excluded.cluster_id, updated_at = excluded.updated_at
    `).run(input.objectionId, input.workflowId, input.iterationId, input.turnId, input.dimension, input.severity, input.claim, encodeToon({ evidence: input.evidence }), input.evidenceMissing ? 1 : 0, input.status, input.raisedBy, input.clusterId ?? null, now);
  }

  /** Update only the status of an objection row, preserving all other fields. */
  updateObjectionStatus(objectionId: string, status: string): void {
    this.db.prepare(`
      UPDATE objections SET status = ?, updated_at = ? WHERE objection_id = ?
    `).run(status, new Date().toISOString(), objectionId);
  }

  updatePostReviewStage(workflowId: string, stage: string): void {
    this.db.prepare(`
      UPDATE workflows SET post_review_stage = ?, updated_at = ? WHERE workflow_id = ?
    `).run(stage, new Date().toISOString(), workflowId);
  }

  saveDecision(input: DecisionInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    const decision = DecisionSchema.parse({
      decision: input.decision,
      chosen: input.chosen,
      alternatives: input.alternatives,
      reason: input.reason,
      ...(input.confidence === undefined || input.confidence === null ? {} : { confidence: input.confidence }),
      provenance: { workflowId: input.workflowId, iterationId: input.iterationId, turnId: input.turnId, objectionIds: input.objectionIds },
    });
    const payload = DecisionSchema.parse(input.payload ?? decision);
    if (!isDeepStrictEqual(payload, decision)) {
      throw new Error("Decision payload must match the validated decision.");
    }
    this.db.prepare(`
      INSERT INTO decisions (decision_id, workflow_id, iteration_id, turn_id, decision, chosen, alternatives_toon, reason, confidence, objection_ids_toon, payload_toon, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_id) DO UPDATE SET decision = excluded.decision, chosen = excluded.chosen, alternatives_toon = excluded.alternatives_toon,
        reason = excluded.reason, confidence = excluded.confidence, objection_ids_toon = excluded.objection_ids_toon, payload_toon = excluded.payload_toon
    `).run(input.decisionId, input.workflowId, input.iterationId, input.turnId, input.decision, input.chosen, encodeToon({ alternatives: input.alternatives }), input.reason, input.confidence ?? null, encodeToon({ objectionIds: input.objectionIds }), encodeToon(payload), now);
  }

  saveHumanFeedback(input: HumanFeedbackInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO human_feedback (feedback_id, workflow_id, iteration_id, turn_id, decision, comment, payload_toon, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feedback_id) DO UPDATE SET decision = excluded.decision, comment = excluded.comment, payload_toon = excluded.payload_toon
    `).run(input.feedbackId, input.workflowId, input.iterationId ?? null, input.turnId ?? null, input.decision, input.comment ?? null, encodeToon(input.payload ?? {}), now);
  }

  saveArtifact(input: ArtifactInput): void {
    const now = input.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO artifacts (artifact_id, workflow_id, iteration_id, turn_id, agent_id, kind, path, content_hash, orphan, metadata_toon, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id, path, content_hash) DO UPDATE SET orphan = excluded.orphan, metadata_toon = excluded.metadata_toon
    `).run(input.artifactId, input.workflowId, input.iterationId, input.turnId, input.agentId ?? null, input.kind, input.path, input.contentHash, input.orphan ? 1 : 0, encodeToon(input.metadata ?? {}), now);
  }

  recordUsage(input: UsageInput): void {
    this.db.prepare(`
      INSERT INTO usage_ledger (usage_id, workflow_id, iteration_id, turn_id, agent_id, provider, message_id, cache_tokens, input_tokens, output_tokens, cost, pricing_version, wall_clock_ms, retry_count, repair_count, timeout_count, startup_ms, payload_toon, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(input.usageId, input.workflowId, input.iterationId ?? null, input.turnId ?? null, input.agentId ?? null, input.provider, input.messageId, input.cacheTokens, input.inputTokens, input.outputTokens, input.cost, input.pricingVersion, input.wallClockMs, input.retryCount, input.repairCount, input.timeoutCount, input.startupMs, encodeToon(input.payload ?? {}), input.recordedAt ?? new Date().toISOString());
  }

  recordSignal(signal: RuntimeSignal): void {
    const parsed = RuntimeSignalSchema.parse(signal);
    this.db.prepare(`
      INSERT INTO runtime_signals (signal_id, kind, classification, observed_at, source, workflow_id, iteration_id, turn_id, agent_id, payload_toon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(signal_id) DO NOTHING
    `).run(parsed.signalId, parsed.kind, parsed.classification, parsed.observedAt, parsed.source, parsed.workflowId, parsed.iterationId, parsed.turnId, parsed.agentId, encodeToon(parsed));
  }

  appendEvent(event: PlatformEvent): StoredEvent | null {
    const parsed = EventSchema.parse(event) as PlatformEvent;
    const result = this.db.prepare(`
      INSERT INTO events (event_id, kind, occurred_at, workflow_id, iteration_id, turn_id, agent_id, payload_toon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(parsed.eventId, parsed.kind as EventKind, parsed.occurredAt, parsed.workflowId, parsed.iterationId ?? null, parsed.turnId ?? null, parsed.agentId ?? null, encodeToon(parsed.payload));
    if (Number(result.changes) === 0) return null;
    const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(parsed.eventId);
    if (!row) throw new Error(`Inserted event ${parsed.eventId} could not be read back.`);
    return eventFromRow(row);
  }
}

export class PersistenceStore {
  readonly config: PersistenceConfig;
  private readonly db: DatabaseSync;

  constructor(config: Partial<PersistenceConfig> = {}) {
    this.config = withConfig(config);
    if (this.config.path !== ":memory:") mkdirSync(dirname(this.config.path), { recursive: true });
    this.db = new DatabaseSync(this.config.path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.exec(`PRAGMA synchronous = ${this.config.synchronous}; PRAGMA busy_timeout = ${this.config.busyTimeoutMs};`);
    this.migrate();
  }

  close(): void { if (this.db.isOpen) this.db.close(); }

  transaction<T>(work: (transaction: PersistenceTransaction) => T): T {
    const transaction = new PersistenceTransaction(this.db);
    if (this.db.isTransaction) return work(transaction);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = work(transaction);
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  recordSignal(signal: RuntimeSignal): void { this.transaction((tx) => tx.recordSignal(signal)); }
  appendEvent(event: PlatformEvent): StoredEvent | null { return this.transaction((tx) => tx.appendEvent(event)); }

  saveWorkflow(input: WorkflowInput): void { this.transaction((tx) => tx.saveWorkflow(input)); }
  saveIteration(input: IterationInput): void { this.transaction((tx) => tx.saveIteration(input)); }
  saveTurn(input: TurnInput): void { this.transaction((tx) => tx.saveTurn(input)); }
  saveAgent(input: AgentInput): void { this.transaction((tx) => tx.saveAgent(input)); }
  saveRequirement(input: RequirementInput): void { this.transaction((tx) => tx.saveRequirement(input)); }
  saveObjection(input: ObjectionInput): void { this.transaction((tx) => tx.saveObjection(input)); }
  updateObjectionStatus(objectionId: string, status: string): void { this.transaction((tx) => tx.updateObjectionStatus(objectionId, status)); }
  updatePostReviewStage(workflowId: string, stage: string): void { this.transaction((tx) => tx.updatePostReviewStage(workflowId, stage)); }
  saveDecision(input: DecisionInput): void { this.transaction((tx) => tx.saveDecision(input)); }
  saveHumanFeedback(input: HumanFeedbackInput): void { this.transaction((tx) => tx.saveHumanFeedback(input)); }
  saveArtifact(input: ArtifactInput): void { this.transaction((tx) => tx.saveArtifact(input)); }
  recordUsage(input: UsageInput): void { this.transaction((tx) => tx.recordUsage(input)); }

  listEvents(options: { workflowId?: string; afterSequence?: number; limit?: number | null } = {}): StoredEvent[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.workflowId) { where.push("workflow_id = ?"); params.push(options.workflowId); }
    if (options.afterSequence !== undefined) { where.push("sequence > ?"); params.push(options.afterSequence); }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    if (options.limit === null) {
      const rows = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY sequence ASC`).all(...params);
      return rows.map(eventFromRow);
    }
    const limit = Math.max(1, options.limit ?? 10_000);
    const rows = this.db.prepare(`SELECT * FROM events ${clause} ORDER BY sequence ASC LIMIT ?`).all(...params, limit);
    return rows.map(eventFromRow);
  }

  /** Cursor over the event log in sequence order. Never truncates. */
  *iterateEvents(options: { workflowId?: string; afterSequence?: number; batchSize?: number } = {}): Generator<StoredEvent> {
    const batchSize = Math.max(1, options.batchSize ?? 1_000);
    let afterSequence = options.afterSequence ?? 0;
    for (;;) {
      const batch = this.listEvents({
        workflowId: options.workflowId,
        afterSequence,
        limit: batchSize,
      });
      if (batch.length === 0) return;
      for (const entry of batch) {
        yield entry;
        afterSequence = entry.sequence;
      }
      if (batch.length < batchSize) return;
    }
  }

  getWorkflow(workflowId: string): Row | null {
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId);
    return row ? (row as Row) : null;
  }

  /**
   * Workflows that have not reached a terminal review outcome, newest first. Used to
   * auto-select which run to resume when no explicit id is given. `status` is derived
   * from the folded phase on every state write (see planning `persist`), so a running
   * workflow keeps `running` until it reaches `approved`/`rejected`/`escalated`.
   */
  listResumableWorkflows(): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare(`
      SELECT * FROM workflows
      WHERE status = 'running'
         OR (status = 'approved' AND (post_review_stage IS NULL OR post_review_stage != 'complete'))
      ORDER BY updated_at DESC
    `).all() as Row[];
  }

  getTurn(turnId: string): Row | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId);
    return row ? (row as Row) : null;
  }

  listUndispatchedEvents(limit = this.config.dispatcherBatchSize): StoredEvent[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE dispatched_at IS NULL ORDER BY sequence ASC LIMIT ?").all(Math.max(1, limit));
    return rows.map(eventFromRow);
  }

  markEventDispatched(eventId: string, dispatchedAt = new Date().toISOString()): boolean {
    const result = this.db.prepare("UPDATE events SET dispatched_at = ? WHERE event_id = ? AND dispatched_at IS NULL").run(dispatchedAt, eventId);
    return Number(result.changes) === 1;
  }

  listSignals(options: { turnId?: string; limit?: number } = {}): StoredSignal[] {
    const limit = Math.max(1, options.limit ?? 10_000);
    const rows = options.turnId
      ? this.db.prepare("SELECT * FROM runtime_signals WHERE turn_id = ? ORDER BY observed_at ASC LIMIT ?").all(options.turnId, limit)
      : this.db.prepare("SELECT * FROM runtime_signals ORDER BY observed_at ASC LIMIT ?").all(limit);
    return rows.map(signalFromRow);
  }

  pendingDeadlines(): PendingDeadline[] {
    const rows = this.db.prepare(`
      SELECT turn_id, deadline_at, attempt FROM turns
      WHERE deadline_at IS NOT NULL AND state NOT IN ('completed', 'failed', 'timed_out', 'cancelled')
      ORDER BY deadline_at ASC
    `).all();
    return rows.map((row) => ({ turnId: stringValue(row.turn_id), deadline: stringValue(row.deadline_at), attempt: stringValue(row.attempt) as PendingDeadline["attempt"] }));
  }

  recover(): RecoverySnapshot {
    return { undispatchedEvents: this.listUndispatchedEvents(), pendingDeadlines: this.pendingDeadlines() };
  }

  pruneSignals(now = new Date()): number {
    if (this.config.signalRetentionDays === null) return 0;
    const cutoff = new Date(now.getTime() - this.config.signalRetentionDays * 24 * 60 * 60 * 1_000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM runtime_signals
      WHERE observed_at < ? AND (
        turn_id IS NULL OR
        turn_id IN (SELECT turn_id FROM turns WHERE state IN ('completed', 'failed', 'timed_out', 'cancelled'))
      )
    `).run(cutoff);
    return Number(result.changes);
  }

  tableNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return rows.map((row) => stringValue(row.name));
  }

  readRows(table: PersistedTable): ReadonlyArray<Readonly<Row>> {
    if (!schemaTables().includes(table)) throw new Error(`Unknown persistence table: ${table}`);
    return this.db.prepare(`SELECT * FROM ${table}`).all();
  }

  listObjections(workflowId: string): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare("SELECT * FROM objections WHERE workflow_id = ? ORDER BY updated_at ASC").all(workflowId) as Row[];
  }

  listDecisions(workflowId: string): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare("SELECT * FROM decisions WHERE workflow_id = ? ORDER BY created_at ASC").all(workflowId) as Row[];
  }

  listArtifacts(workflowId: string): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare("SELECT * FROM artifacts WHERE workflow_id = ? ORDER BY created_at ASC").all(workflowId) as Row[];
  }

  listTurns(workflowId: string): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare("SELECT * FROM turns WHERE workflow_id = ? ORDER BY created_at ASC").all(workflowId) as Row[];
  }

  listUsage(workflowId: string): ReadonlyArray<Readonly<Row>> {
    return this.db.prepare("SELECT * FROM usage_ledger WHERE workflow_id = ? ORDER BY recorded_at ASC").all(workflowId) as Row[];
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get();
    const observed = numberValue(row?.version);
    if (observed > CURRENT_SCHEMA_VERSION) throw new NewerSchemaError(observed, CURRENT_SCHEMA_VERSION);
    for (let version = observed + 1; version <= CURRENT_SCHEMA_VERSION; version += 1) {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(MIGRATIONS[version - 1]);
        this.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
        this.db.exec("COMMIT;");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }
}

function eventFromRow(row: Row): StoredEvent {
  const payload = parseToon(stringValue(row.payload_toon));
  const event = EventSchema.parse({
    eventId: stringValue(row.event_id),
    kind: stringValue(row.kind),
    occurredAt: stringValue(row.occurred_at),
    workflowId: stringValue(row.workflow_id),
    iterationId: nullableString(row.iteration_id) ?? undefined,
    turnId: nullableString(row.turn_id) ?? undefined,
    agentId: nullableString(row.agent_id) ?? undefined,
    payload,
  }) as PlatformEvent & { kind: EventKind };
  return {
    sequence: numberValue(row.sequence), eventId: event.eventId, kind: event.kind as EventKind, occurredAt: event.occurredAt,
    workflowId: event.workflowId, iterationId: event.iterationId ?? null, turnId: event.turnId ?? null, agentId: event.agentId ?? null,
    payloadToon: stringValue(row.payload_toon), dispatchedAt: nullableString(row.dispatched_at), event,
  };
}

function signalFromRow(row: Row): StoredSignal {
  const signal = RuntimeSignalSchema.parse(parseToon(stringValue(row.payload_toon)));
  return {
    signalId: signal.signalId, kind: signal.kind, classification: signal.classification, observedAt: signal.observedAt,
    source: signal.source, workflowId: signal.workflowId, iterationId: signal.iterationId, turnId: signal.turnId, agentId: signal.agentId,
    payloadToon: stringValue(row.payload_toon), signal,
  };
}

function stringValue(value: SQLOutputValue | undefined): string { if (typeof value !== "string") throw new Error("Expected a SQLite text value."); return value; }
function nullableString(value: SQLOutputValue | undefined): string | null { return value === null || value === undefined ? null : stringValue(value); }
function numberValue(value: SQLOutputValue | undefined): number { if (typeof value !== "number") throw new Error("Expected a SQLite numeric value."); return value; }

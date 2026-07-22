import assert from "node:assert/strict";
import test from "node:test";
import { PersistenceStore } from "@platform/persistence";
import { WorkflowEngine } from "@platform/workflow-engine";
import {
  adaptEscalationSink,
  anthropicAdapter,
  createMemorySink,
  deriveHealthMetrics,
  ingestSessionLog,
  openaiAdapter,
  scanAndRedact,
  shouldRenderTranscriptContent,
  withHumanLoopConfig,
} from "../src/index.js";

function setup(budgetCap: number | null = null) {
  const store = new PersistenceStore({ path: ":memory:" });
  const memory = createMemorySink();
  const config = withHumanLoopConfig();
  const engine = new WorkflowEngine({
    store,
    config: { budgetCap },
    notifications: adaptEscalationSink(memory, config),
    now: () => "2026-07-22T10:00:00.000Z",
  });
  engine.startWorkflow({
    workflowId: "workflow-1",
    workspaceId: "workspace-1",
    task: "Ship",
    config: { budgetCap },
  });
  return { store, engine, memory, config };
}

test("anthropic adapter parses usage lines", () => {
  const log = [
    JSON.stringify({
      type: "usage",
      message_id: "msg-1",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
    }),
  ].join("\n");
  const parsed = anthropicAdapter().parse(log);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.records[0].messageId, "msg-1");
    assert.equal(parsed.records[0].inputTokens, 100);
  }
});

test("unparseable log degrades without workflow failure", () => {
  const { store, engine, config } = setup();
  const results = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "openai",
    logText: "this is not a session log at all",
  });
  assert.equal(results[0].status, "degraded");
  assert.equal(engine.getState("workflow-1").phase, "planner_turn");
});

test("duplicate message id is idempotent end to end", () => {
  const { store, engine, config } = setup();
  const log = JSON.stringify({
    type: "usage",
    message_id: "msg-dup",
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0 },
  });
  const first = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
  });
  const second = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
  });
  assert.equal(first[0].status, "recorded");
  assert.equal(second[0].status, "duplicate");
  assert.equal(store.readRows("usage_ledger").length, 1);
});

test("pricing correction is audit-only and does not inflate spendTotal", () => {
  const { store, engine, config } = setup();
  const log = JSON.stringify({
    type: "usage",
    message_id: "msg-price",
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 },
  });
  const first = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
  });
  assert.equal(first[0].status, "recorded");
  const spendAfterFirst = engine.getState("workflow-1").spendTotal;

  const correction = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
    asPricingCorrection: true,
  });
  assert.equal(correction[0].status, "correction_recorded");
  if (correction[0].status === "correction_recorded") {
    assert.equal(correction[0].messageId, "msg-price@v1");
  }
  assert.equal(store.listUsage("workflow-1").length, 2);
  assert.equal(engine.getState("workflow-1").spendTotal, spendAfterFirst);
});

test("cap crossing through submitUsage pauses and notifies", async () => {
  const { store, engine, memory, config } = setup(0.0001);
  const log = JSON.stringify({
    type: "usage",
    message_id: "msg-cap",
    usage: { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0 },
  });
  const results = ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
  });
  assert.equal(results[0].status, "recorded");
  if (results[0].status === "recorded") {
    assert.equal(results[0].budgetCapReached, true);
  }
  assert.equal(engine.getState("workflow-1").phase, "escalated");
  await engine.flush();
  assert.ok(memory.requests.some((r) => r.kind === "budget_pause" || r.kind === "escalation"));
});

test("health metrics count once per turn across multi-message ingest", () => {
  const { store, engine, config } = setup();
  store.saveIteration({
    iterationId: "iteration-1",
    workflowId: "workflow-1",
    iterationNumber: 1,
    status: "active",
  });
  store.saveTurn({
    turnId: "turn-1",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    state: "completed",
    attempt: "primary",
    promptPath: "p",
    promptHash: "h",
    nonce: "n",
    promptVersion: "v",
    resultPath: "r",
  });
  const log = [
    JSON.stringify({
      type: "usage",
      message_id: "msg-a",
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0 },
    }),
    JSON.stringify({
      type: "usage",
      message_id: "msg-b",
      usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0 },
    }),
  ].join("\n");
  ingestSessionLog({
    store,
    engine,
    config,
    workflowId: "workflow-1",
    provider: "anthropic",
    logText: log,
    turnId: "turn-1",
    health: { wallClockMs: 1000, retryCount: 2, startupMs: 50 },
  });
  const metrics = deriveHealthMetrics({
    store,
    workflowId: "workflow-1",
    folded: engine.getState("workflow-1"),
  });
  assert.equal(store.listUsage("workflow-1").length, 2);
  assert.equal(metrics.wallClockMsTotal, 1000);
  assert.equal(metrics.retryCountTotal, 2);
  assert.equal(metrics.startupMsTotal, 50);
});

test("API default bind is 8787 so Vite 5173 proxy works", () => {
  const config = withHumanLoopConfig();
  assert.equal(config.dashboardBind.port, 8787);
  assert.match(config.dashboardDeepLinkBase, /:5173\//);
});

test("redaction scanner never returns match text", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const result = scanAndRedact(`token ${secret} end`);
  assert.equal(result.text.includes(secret), false);
  assert.match(result.text, /\[REDACTED:aws_key\]/);
  assert.ok(result.hits.some((h) => h.ruleId === "aws_key" && h.count === 1));
  assert.equal(shouldRenderTranscriptContent({ locallyReadable: true, sensitive: true }), false);
  assert.equal(shouldRenderTranscriptContent({ locallyReadable: true, sensitive: false }), true);
});

test("openai adapter fixture", () => {
  const log = JSON.stringify({
    object: "usage",
    id: "ou-1",
    prompt_tokens: 3,
    completion_tokens: 4,
    cached_tokens: 1,
  });
  const parsed = openaiAdapter().parse(log);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.records[0].outputTokens, 4);
});

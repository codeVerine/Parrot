import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { PersistenceStore } from "@platform/persistence";
import { createMemorySink } from "@platform/human-loop";
import { createComposition, createFixtureRunner, type AgentTurnRequest } from "../src/index.js";
import { envelope, approvedProposal } from "./author-pair-fixtures.js";

function setup(resolver: (req: AgentTurnRequest) => string) {
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  const comp = createComposition({
    store,
    runner: createFixtureRunner(resolver),
    humanSink: createMemorySink(),
    writePrompts: false,
    now: () => "2026-07-23T10:00:00.000Z",
    newId: () => `turn-${(counter += 1)}`,
    nonceFactory: () => "nonce-1",
  });
  comp.startWorkflow({ workflowId: "workflow-1", workspaceId: "workspace-1", task: "Ship feature" });
  return { store, comp };
}

test("implementation turn validates and completes", async () => {
  const { store, comp } = setup((req) =>
    envelope(req, "implementation", { status: "completed", summary: "shipped auth guard" }),
  );
  const proposal = approvedProposal();
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "completed");
  const turns = store.readRows("turns");
  assert.equal(turns.length, 1);
  assert.equal(String(turns[0].state), "completed");
});

test("planner bad citation triggers repair; good citation on repair validates", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "parrot-turn-cite-"));
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: projectDir });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  writeFileSync(join(projectDir, "src", "api.ts"), "export function existingGate() {}\n");
  execFileSync("git", ["add", "src/api.ts"], { cwd: projectDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projectDir });

  const runsRoot = join(projectDir, "runs");
  const store = new PersistenceStore({ path: ":memory:" });
  let counter = 0;
  let repairReason = "";
  const comp = createComposition({
    store,
    runner: createFixtureRunner((req) => {
      const proposalPath = join(dirname(req.resultPath), "proposal.md");
      mkdirSync(dirname(proposalPath), { recursive: true });
      writeFileSync(proposalPath, "# Plan\n\nuse the gate\n", "utf8");
      const payload = {
        proposalPath,
        summary: "use the gate",
        objectionsAddressed: [] as unknown[],
        citations: [
          {
            path: "src/api.ts",
            startLine: 1,
            endLine: 1,
            quote: req.attempt === "primary"
              ? "export function missingGate() {}"
              : "export function existingGate() {}",
          },
        ],
      };
      if (req.attempt === "repair") {
        repairReason = req.promptContent;
      }
      return envelope(req, "planner", payload);
    }),
    humanSink: createMemorySink(),
    writePrompts: false,
    runsRoot,
    projectDir,
    now: () => "2026-07-23T10:00:00.000Z",
    newId: () => `turn-${(counter += 1)}`,
    nonceFactory: () => "nonce-1",
  });
  comp.startWorkflow({ workflowId: "workflow-1", workspaceId: "workspace-1", task: "Ship feature" });

  const out = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-planner",
    context: { task: "Ship feature" },
  });

  assert.equal(out.status, "valid");
  assert.match(repairReason, /citation verification failed/);
  assert.match(repairReason, /quote does not match/);
  const turn = store.readRows("turns")[0];
  assert.equal(String(turn.attempt), "repair");
  assert.equal(String(turn.state), "completed");

  const snapshotPath = join(runsRoot, "workflow-1", "iteration-1", "turn-1", "citations.toon");
  assert.equal(existsSync(snapshotPath), true);
  assert.match(readFileSync(snapshotPath, "utf8"), /existingGate/);
});

test("planner turn without projectDir skips citation verification", async () => {
  const { store, comp } = setup((req) => {
    const proposalPath = join(dirname(req.resultPath), "proposal.md");
    mkdirSync(dirname(proposalPath), { recursive: true });
    writeFileSync(proposalPath, "# Plan\n\ninvented citation stays unchecked without projectDir\n", "utf8");
    return envelope(req, "planner", {
      proposalPath,
      summary: "invented citation stays unchecked without projectDir",
      objectionsAddressed: [],
      citations: [
        {
          path: "does-not-exist.ts",
          startLine: 1,
          endLine: 1,
          quote: "export const nope = 1;",
        },
      ],
    });
  });
  const out = await comp.runTurn({
    turnType: "planner_propose",
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-planner",
    context: { task: "Ship feature" },
  });
  assert.equal(out.status, "valid");
  assert.equal(String(store.readRows("turns")[0].state), "completed");
});

test("first result fails validation, bounded repair completes the turn", async () => {
  const { store, comp } = setup((req) =>
    req.attempt === "primary"
      ? "this is not a toon envelope"
      : envelope(req, "implementation", { status: "completed", summary: "fixed output" }),
  );
  const proposal = approvedProposal();
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "completed");
  const turn = store.readRows("turns")[0];
  assert.equal(String(turn.attempt), "repair");
  assert.equal(String(turn.state), "completed");
});

test("two validation failures fail the turn", async () => {
  const { store, comp } = setup(() => "still not a toon envelope");
  const proposal = approvedProposal();
  const out = await comp.runImplementation({
    workflowId: "workflow-1",
    iterationId: "iteration-1",
    agentId: "agent-impl",
    task: "Implement the approved plan",
    proposalPath: proposal.proposalPath,
    proposalHash: proposal.proposalHash,
  });
  assert.equal(out.status, "failed");
  assert.equal(String(store.readRows("turns")[0].state), "failed");
});

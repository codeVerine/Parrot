import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_KINDS } from "@platform/contracts";
import {
  GUARD_INPUT_EVENTS,
  hasOpenObjections,
  humanRuleAllows,
  initialFoldedState,
  underBudgetCap,
  underIterationCap,
  withWorkflowConfig,
  type FoldedState,
} from "../src/index.js";

function state(partial: Partial<FoldedState> = {}): FoldedState {
  return { ...initialFoldedState("workflow-1"), ...partial };
}

test("hasOpenObjections is true for any severity including minor", () => {
  assert.equal(hasOpenObjections(state()), false);
  assert.equal(hasOpenObjections(state({
    objections: {
      "OBJ-1": { objectionId: "OBJ-1", severity: "minor", status: "open" },
    },
  })), true);
  assert.equal(hasOpenObjections(state({
    objections: {
      "OBJ-1": { objectionId: "OBJ-1", severity: "blocking", status: "resolved" },
    },
  })), false);
});

test("underIterationCap boundary: exact cap is not under", () => {
  const config = withWorkflowConfig({ maxIterations: 5 });
  assert.equal(underIterationCap(state({ iterationCount: 4 }), config), true);
  assert.equal(underIterationCap(state({ iterationCount: 5 }), config), false);
});

test("underBudgetCap: null cap always passes; exact cap fails", () => {
  assert.equal(underBudgetCap(state({ spendTotal: 999 }), withWorkflowConfig({ budgetCap: null })), true);
  assert.equal(underBudgetCap(state({ spendTotal: 1 }), withWorkflowConfig({ budgetCap: 1 })), false);
  assert.equal(underBudgetCap(state({ spendTotal: 0.99 }), withWorkflowConfig({ budgetCap: 1 })), true);
});

test("humanRuleAllows asks human when no rule matches", () => {
  const match = humanRuleAllows(state(), withWorkflowConfig({ humanAutoRules: [] }));
  assert.equal(match.action, "ask_human");
});

test("humanRuleAllows applies first matching predicate", () => {
  const match = humanRuleAllows(state(), withWorkflowConfig({
    humanAutoRules: [
      { id: "r1", version: 1, predicate: "noOpenObjections", action: "approve" },
    ],
  }));
  assert.equal(match.action, "approve");
});

test("guard-input events are members of the platform catalog", () => {
  const catalog = new Set<string>(EVENT_KINDS);
  for (const kinds of Object.values(GUARD_INPUT_EVENTS)) {
    for (const kind of kinds) {
      assert.ok(catalog.has(kind), `missing catalog kind ${kind}`);
    }
  }
});

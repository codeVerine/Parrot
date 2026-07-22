import assert from "node:assert/strict";
import test from "node:test";
import {
  findingsFromReport,
  objectionDraftsFromFindings,
  detectPanelContradictions,
  contradictionFindings,
  frontierFailedAttention,
  withHumanLoopConfig,
} from "../src/index.js";
import type { FrontierResult } from "../src/index.js";

test("not_ready risks become blocking findings and objection drafts", () => {
  const report: FrontierResult = {
    role: "frontier",
    readiness: "not_ready",
    risks: ["Auth missing on delete", "No rollback plan"],
    questions: ["Who owns secrets?"],
  };
  const findings = findingsFromReport(report, { turnId: "t1" });
  assert.equal(findings.filter((f) => f.blocking).length, 2);
  assert.equal(findings.every((f) => f.claim.kind === "untrusted"), true);
  const drafts = objectionDraftsFromFindings(findings);
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].severity, "blocking");
});

test("ready risks are non-blocking", () => {
  const findings = findingsFromReport({
    role: "frontier",
    readiness: "ready",
    risks: ["Minor polish"],
    questions: [],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].blocking, false);
  assert.equal(objectionDraftsFromFindings(findings).length, 0);
});

test("panel divergent readiness and exclusive risks surface contradictions", () => {
  const reports: FrontierResult[] = [
    { role: "frontier", readiness: "ready", risks: ["missing auth on delete"], questions: [] },
    { role: "frontier", readiness: "not_ready", risks: ["no missing auth on delete"], questions: [] },
  ];
  const contradictions = detectPanelContradictions(reports);
  assert.ok(contradictions.some((c) => c.kind === "divergent_readiness"));
  assert.ok(contradictions.some((c) => c.kind === "exclusive_risk"));
  const findings = contradictionFindings(contradictions);
  assert.ok(findings.every((f) => f.blocking));
});

test("frontier TurnFailed maps to frontier_failed attention", () => {
  const config = withHumanLoopConfig();
  const request = frontierFailedAttention("wf-1", config);
  assert.equal(request.kind, "frontier_failed");
  assert.match(request.dashboardDeepLink, /wf-1/);
});

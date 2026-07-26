#!/usr/bin/env node
// Flatten a Parrot workflow's artifacts into one review-ready markdown file.
//
// Usage:
//   node bundle-review.mjs [projectDirOrRunsDirOrDb] [workflowId]
//
// Args (all optional):
//   arg1  a project dir, its runs/ dir, or a parrot.db path. Default: ./runs
//   arg2  workflow id. Default: newest workflow in the db.
//
// Output: writes review-bundle.md next to the db and prints its path.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

function findDb(arg) {
  const base = resolve(arg ?? "runs");
  const candidates = [
    base,
    join(base, "parrot.db"),
    join(base, "runs", "parrot.db"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  throw new Error(`No parrot.db found from "${arg ?? "runs"}". Pass the project dir, its runs/ dir, or the parrot.db path.`);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

const dbPath = findDb(process.argv[2]);
const db = new DatabaseSync(dbPath);

let workflowId = process.argv[3];
if (!workflowId) {
  const row = db.prepare("SELECT workflow_id FROM workflows ORDER BY updated_at DESC LIMIT 1").get();
  if (!row) throw new Error("No workflows in the database.");
  workflowId = String(row.workflow_id);
}

const wf = db.prepare("SELECT * FROM workflows WHERE workflow_id=?").get(workflowId);
if (!wf) throw new Error(`No workflow "${workflowId}" in ${dbPath}.`);

const turns = db.prepare("SELECT * FROM turns WHERE workflow_id=? ORDER BY created_at, rowid").all(workflowId);
const objections = db.prepare("SELECT * FROM objections WHERE workflow_id=? ORDER BY rowid").all(workflowId);
let decisions = [];
try {
  decisions = db.prepare("SELECT * FROM decisions WHERE workflow_id=? ORDER BY rowid").all(workflowId);
} catch {
  // decisions table may be absent in older dbs
}

const out = [];
const push = (s = "") => out.push(s);

push(`# Parrot review bundle`);
push();
push(`- **workflow:** ${workflowId}`);
push(`- **status:** ${wf.status}`);
push(`- **updated:** ${wf.updated_at}`);
push(`- **turns:** ${turns.length}   **objections:** ${objections.length}   **decisions:** ${decisions.length}`);
push();
push(`## Task`);
push();
push("```");
push(String(wf.task ?? "(none)").trim());
push("```");
push();
if (wf.config_toon) {
  push(`## Config`);
  push();
  push("```toon");
  push(String(wf.config_toon).trim());
  push("```");
  push();
}

push(`## Timeline (chronological)`);
push();
push(`Each turn: the prompt the agent was given, then its structured reply, then the plan it produced (planner turns).`);
push();

for (const t of turns) {
  const role = String(t.agent_id ?? "?");
  push(`---`);
  push();
  push(`### ${t.iteration_id} — ${role} — state=${t.state}`);
  push(`- turn_id: ${t.turn_id}`);
  push(`- created: ${t.created_at}`);
  push();
  const prompt = t.prompt_path ? read(String(t.prompt_path)) : null;
  if (prompt) {
    push(`<details><summary>prompt.md</summary>`);
    push();
    push("```md");
    push(prompt.trim());
    push("```");
    push();
    push(`</details>`);
    push();
  }
  const result = t.result_path ? read(String(t.result_path)) : null;
  if (result) {
    push(`**result.toon:**`);
    push();
    push("```toon");
    push(result.trim());
    push("```");
    push();
  } else if (t.state !== "completed") {
    push(`_(no result - turn state is "${t.state}"; this is where the run stalled)_`);
    push();
  }
  const proposal = t.result_path ? read(join(dirname(String(t.result_path)), "proposal.md")) : null;
  if (proposal) {
    push(`<details><summary>proposal.md (the plan this turn produced)</summary>`);
    push();
    push("```md");
    push(proposal.trim());
    push("```");
    push();
    push(`</details>`);
    push();
  }
}

push(`---`);
push();
push(`## Objections (raised across the run)`);
push();
if (objections.length === 0) {
  push(`_none_`);
  push();
} else {
  for (const o of objections) {
    push(`- **${o.objection_id}** [${o.severity}/${o.dimension}] status=**${o.status}** raised_by=${o.raised_by} (${o.iteration_id})`);
    if (o.claim) push(`  - claim: ${String(o.claim).trim()}`);
    if (o.evidence_toon) push(`  - evidence: ${String(o.evidence_toon).replace(/\s+/g, " ").trim()}`);
  }
  push();
}

if (decisions.length > 0) {
  push(`## Human decisions`);
  push();
  for (const d of decisions) {
    push(`- ${JSON.stringify(d)}`);
  }
  push();
}

const outPath = join(dirname(dbPath), "review-bundle.md");
writeFileSync(outPath, out.join("\n"), "utf8");
console.log(`Wrote ${outPath}`);
console.log(`workflow=${workflowId} turns=${turns.length} objections=${objections.length}`);

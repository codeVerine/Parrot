import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Guards the transport against drifting back into a fictional wire API. The fixture is
 * the verbatim output of `herdr api schema --json` (protocol 16). For every request the
 * socket client issues, we assert the method exists and that the exact params object we
 * send satisfies the schema: all required keys present, and no unknown keys (Herdr's
 * deserializer rejects unknown fields, which silently closes the socket).
 */
type SchemaNode = Record<string, any>;
const schema = JSON.parse(readFileSync(new URL("./fixtures/herdr-schema.json", import.meta.url), "utf8")) as SchemaNode;

function resolve(node: SchemaNode): SchemaNode {
  if (node && typeof node.$ref === "string") {
    let cur: SchemaNode = schema;
    for (const segment of node.$ref.replace(/^#\//, "").split("/")) cur = cur[segment];
    return cur;
  }
  return node;
}

function paramsDefFor(method: string): SchemaNode {
  const variant = (schema.schemas.request.oneOf as SchemaNode[]).find((v) => v.properties?.method?.const === method);
  assert.ok(variant, `method ${method} is not in the schema`);
  return resolve(variant.properties.params);
}

function pickVariant(variants: SchemaNode[], sample: Record<string, unknown>): SchemaNode | null {
  for (const variant of variants) {
    let matches = true;
    for (const [key, propSchema] of Object.entries<SchemaNode>(variant.properties ?? {})) {
      if (typeof propSchema.const === "string" && sample[key] !== propSchema.const) { matches = false; break; }
    }
    if (matches) return variant;
  }
  return null;
}

function validate(def: SchemaNode, sample: unknown, path: string, errors: string[]): void {
  def = resolve(def);
  if (def.oneOf) {
    const variant = pickVariant(def.oneOf as SchemaNode[], sample as Record<string, unknown>);
    if (!variant) { errors.push(`${path}: no oneOf variant matches ${JSON.stringify(sample)}`); return; }
    validate(variant, sample, path, errors);
    return;
  }
  if (def.type === "object" || def.properties) {
    const props: Record<string, SchemaNode> = def.properties ?? {};
    const required: string[] = def.required ?? [];
    const openMap = def.additionalProperties !== undefined && def.additionalProperties !== false;
    const value = sample as Record<string, unknown>;
    for (const key of required) if (!(key in value)) errors.push(`${path}: missing required '${key}'`);
    for (const [key, child] of Object.entries(value)) {
      if (!(key in props)) { if (!openMap) errors.push(`${path}: unknown field '${key}' rejected by schema`); continue; }
      const childDef = resolve(props[key]);
      if (childDef.oneOf) validate(childDef, child, `${path}.${key}`, errors);
      else if (childDef.type === "array" && childDef.items && Array.isArray(child)) child.forEach((item, index) => validate(childDef.items, item, `${path}.${key}[${index}]`, errors));
      else if ((childDef.type === "object" || childDef.properties) && child && typeof child === "object" && !Array.isArray(child)) validate(childDef, child, `${path}.${key}`, errors);
    }
  }
}

const REQUESTS: Array<{ method: string; params: Record<string, unknown> }> = [
  { method: "tab.create", params: { workspace_id: "workspace-1", label: "parrot agents", focus: false } },
  { method: "agent.start", params: { name: "claude-planner", argv: ["claude"], cwd: null, workspace_id: "workspace-1", tab_id: "w7:t3", env: {}, focus: false } },
  { method: "pane.send_text", params: { pane_id: "pane-1", text: "read the prompt" } },
  { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["Enter"] } },
  { method: "pane.read", params: { pane_id: "pane-1", source: "visible", format: "text", strip_ansi: true } },
  { method: "events.wait", params: { match_event: { event: "pane_agent_status_changed", pane_id: "pane-1", agent_status: "done" }, timeout_ms: 1000 } },
  { method: "events.subscribe", params: { subscriptions: [{ type: "pane.agent_status_changed", pane_id: "pane-1" }] } },
  { method: "pane.send_keys", params: { pane_id: "pane-1", keys: ["C-c"] } },
  { method: "pane.close", params: { pane_id: "pane-1" } },
  { method: "agent.list", params: {} },
  { method: "session.snapshot", params: {} },
];

test("fixture is the real protocol 16 schema", () => {
  assert.equal(schema.protocol, 16);
  assert.equal(schema.schema_version, 1);
});

for (const { method, params } of REQUESTS) {
  test(`${method} params conform to the live schema`, () => {
    const errors: string[] = [];
    validate(paramsDefFor(method), params, method, errors);
    assert.deepEqual(errors, [], errors.join("\n"));
  });
}

test("retired fictional methods are absent from the schema", () => {
  const methods = new Set((schema.schemas.request.oneOf as SchemaNode[]).map((v) => v.properties?.method?.const));
  for (const fiction of ["agent.wait", "agent.interrupt", "agent.stop", "integration.status", "api.schema", "events.unsubscribe"]) {
    assert.equal(methods.has(fiction), false, `${fiction} should not exist in Herdr protocol 16`);
  }
});

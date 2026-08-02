import assert from "node:assert/strict";
import test from "node:test";
import {
  ASK_PROVIDER_ARGV,
  BYPASS_PROVIDER_ARGV,
  DEFAULT_CONFIG,
  parsePermissionMode,
  PROJECT_SCOPED_PROVIDER_ARGV,
  providerArgvForPermissionMode,
} from "../src/config.js";

test("default provider argv is project-scoped auto-approve", () => {
  assert.deepEqual(DEFAULT_CONFIG.providerArgv.claude, PROJECT_SCOPED_PROVIDER_ARGV.claude);
  assert.deepEqual(DEFAULT_CONFIG.providerArgv.codex, PROJECT_SCOPED_PROVIDER_ARGV.codex);
  assert.deepEqual(DEFAULT_CONFIG.providerArgv.gemini, PROJECT_SCOPED_PROVIDER_ARGV.gemini);
  assert.ok(DEFAULT_CONFIG.providerArgv.claude.includes("acceptEdits"));
  assert.ok(DEFAULT_CONFIG.providerArgv.codex.includes("--full-auto"));
  assert.ok(DEFAULT_CONFIG.providerArgv.gemini.includes("auto_edit"));
});

test("parsePermissionMode maps aliases", () => {
  assert.equal(parsePermissionMode(undefined), "project");
  assert.equal(parsePermissionMode("project"), "project");
  assert.equal(parsePermissionMode("acceptEdits"), "project");
  assert.equal(parsePermissionMode("bypass"), "bypass");
  assert.equal(parsePermissionMode("YOLO"), "bypass");
  assert.equal(parsePermissionMode("ask"), "ask");
  assert.equal(parsePermissionMode("manual"), "ask");
  assert.equal(parsePermissionMode("nope"), "project");
});

test("providerArgvForPermissionMode selects argv tables", () => {
  assert.deepEqual(providerArgvForPermissionMode("project"), PROJECT_SCOPED_PROVIDER_ARGV);
  assert.deepEqual(providerArgvForPermissionMode("bypass"), BYPASS_PROVIDER_ARGV);
  assert.deepEqual(providerArgvForPermissionMode("ask"), ASK_PROVIDER_ARGV);
  assert.ok(BYPASS_PROVIDER_ARGV.claude.includes("--dangerously-skip-permissions"));
  assert.ok(BYPASS_PROVIDER_ARGV.codex.includes("--yolo"));
});

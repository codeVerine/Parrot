export type AdapterMode = "production" | "development";

/** How provider CLIs handle tool approval relative to the agent cwd / workspace. */
export type PermissionMode = "project" | "bypass" | "ask";

export type AdapterConfig = {
  protocol: number;
  schemaVersion: number;
  requiredIntegrations: string[];
  mode: AdapterMode;
  turnDeadlineMs: number;
  graceTimerMs: number;
  artifactSizeLimitBytes: number;
  watchDebounceMs: number;
  reconnectBackoffMs: number[];
  operationTimeoutMs: number;
  pollIntervalMs: number;
  supportedProviders: string[];
  providerArgv: Record<string, string[]>;
  signalHistoryLimit: number;
  signalQueueLimit: number;
  orphanTurnLimit: number;
};

/** Auto-approve work inside the agent cwd / workspace; still prompt or sandbox-deny outside. */
export const PROJECT_SCOPED_PROVIDER_ARGV: Record<string, string[]> = {
  claude: ["claude", "--permission-mode", "acceptEdits"],
  // Codex has no "ask outside, auto inside" split: workspace-write + never ask
  // auto-approves inside the sandbox and denies (not prompts) outside it.
  codex: ["codex", "--full-auto"],
  gemini: ["gemini", "--approval-mode", "auto_edit"],
};

/** Skip all provider permission prompts (host-wide). Prefer only in isolated envs. */
export const BYPASS_PROVIDER_ARGV: Record<string, string[]> = {
  claude: ["claude", "--dangerously-skip-permissions"],
  codex: ["codex", "--yolo"],
  gemini: ["gemini", "--approval-mode", "yolo"],
};

/** Stock CLI defaults — every edit / shell call may prompt. */
export const ASK_PROVIDER_ARGV: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  gemini: ["gemini"],
};

export function providerArgvForPermissionMode(mode: PermissionMode): Record<string, string[]> {
  switch (mode) {
    case "bypass":
      return { ...BYPASS_PROVIDER_ARGV };
    case "ask":
      return { ...ASK_PROVIDER_ARGV };
    case "project":
    default:
      return { ...PROJECT_SCOPED_PROVIDER_ARGV };
  }
}

/** Parse `PARROT_PERMISSION_MODE` (and aliases). Unknown values fall back to project. */
export function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (!raw) return "project";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "bypass" || normalized === "yolo" || normalized === "full") return "bypass";
  if (normalized === "ask" || normalized === "manual" || normalized === "default") return "ask";
  if (normalized === "project" || normalized === "acceptedits" || normalized === "workspace") return "project";
  return "project";
}

export const DEFAULT_CONFIG: AdapterConfig = {
  protocol: 16,
  schemaVersion: 1,
  requiredIntegrations: ["claude", "codex"],
  mode: "production",
  turnDeadlineMs: 120_000,
  graceTimerMs: 5_000,
  artifactSizeLimitBytes: 4 * 1024 * 1024,
  watchDebounceMs: 50,
  reconnectBackoffMs: [100, 250, 1_000],
  operationTimeoutMs: 10_000,
  pollIntervalMs: 250,
  supportedProviders: ["claude", "codex", "gemini"],
  providerArgv: providerArgvForPermissionMode("project"),
  signalHistoryLimit: 1_000,
  signalQueueLimit: 100,
  orphanTurnLimit: 1_000,
};

export function withConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    requiredIntegrations: overrides.requiredIntegrations ?? [...DEFAULT_CONFIG.requiredIntegrations],
    reconnectBackoffMs: overrides.reconnectBackoffMs ?? [...DEFAULT_CONFIG.reconnectBackoffMs],
    supportedProviders: overrides.supportedProviders ?? [...DEFAULT_CONFIG.supportedProviders],
    providerArgv: overrides.providerArgv ?? { ...DEFAULT_CONFIG.providerArgv },
  };
  if (config.signalHistoryLimit < 1 || config.signalQueueLimit < 1 || config.orphanTurnLimit < 1) {
    throw new Error("Runtime retention limits must be positive.");
  }
  return config;
}

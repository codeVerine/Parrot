export type AdapterMode = "production" | "development";

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
  providerArgv: { claude: ["claude"], codex: ["codex"], gemini: ["gemini"] },
  signalHistoryLimit: 1_000,
  signalQueueLimit: 100,
  orphanTurnLimit: 1_000,
};

export function withConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides, requiredIntegrations: overrides.requiredIntegrations ?? [...DEFAULT_CONFIG.requiredIntegrations], reconnectBackoffMs: overrides.reconnectBackoffMs ?? [...DEFAULT_CONFIG.reconnectBackoffMs], supportedProviders: overrides.supportedProviders ?? [...DEFAULT_CONFIG.supportedProviders], providerArgv: overrides.providerArgv ?? { ...DEFAULT_CONFIG.providerArgv } };
  if (config.signalHistoryLimit < 1 || config.signalQueueLimit < 1 || config.orphanTurnLimit < 1) throw new Error("Runtime retention limits must be positive.");
  return config;
}

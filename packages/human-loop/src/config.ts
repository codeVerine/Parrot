export type HumanLoopConfig = {
  frontierPanelSize: number;
  notificationSink: "herdr" | "noop" | "memory";
  dashboardDeepLinkBase: string;
  ledgerSweepCadenceMs: number;
  pricingTableVersion: string;
  adapterVersionByProvider: Record<string, string>;
  secretScannerRulesetVersion: string;
  transcriptRetentionWindowMs: number | null;
  dashboardBind: { host: string; port: number };
  sensitiveWorkflowDefault: boolean;
  herdrBin: string;
};

export const DEFAULT_HUMAN_LOOP_CONFIG: HumanLoopConfig = {
  frontierPanelSize: 1,
  notificationSink: "noop",
  dashboardDeepLinkBase: "http://127.0.0.1:5173/workflows",
  ledgerSweepCadenceMs: 60_000,
  pricingTableVersion: "v1",
  adapterVersionByProvider: {
    anthropic: "anthropic-session-v1",
    openai: "openai-session-v1",
    google: "google-session-v1",
  },
  secretScannerRulesetVersion: "secrets-v1",
  transcriptRetentionWindowMs: 30 * 24 * 60 * 60 * 1000,
  dashboardBind: { host: "127.0.0.1", port: 8787 },
  sensitiveWorkflowDefault: false,
  herdrBin: "herdr",
};

export function withHumanLoopConfig(overrides: Partial<HumanLoopConfig> = {}): HumanLoopConfig {
  return {
    ...DEFAULT_HUMAN_LOOP_CONFIG,
    ...overrides,
    adapterVersionByProvider: {
      ...DEFAULT_HUMAN_LOOP_CONFIG.adapterVersionByProvider,
      ...overrides.adapterVersionByProvider,
    },
    dashboardBind: {
      ...DEFAULT_HUMAN_LOOP_CONFIG.dashboardBind,
      ...overrides.dashboardBind,
    },
  };
}

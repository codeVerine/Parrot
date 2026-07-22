export type PersistenceConfig = {
  path: string;
  synchronous: "NORMAL" | "FULL";
  busyTimeoutMs: number;
  dispatcherBatchSize: number;
  dispatcherRetryBackoffMs: number;
  signalRetentionDays: number | null;
};

const DEFAULT_CONFIG: PersistenceConfig = {
  path: "runs/parrot.db",
  synchronous: "NORMAL",
  busyTimeoutMs: 5_000,
  dispatcherBatchSize: 50,
  dispatcherRetryBackoffMs: 250,
  signalRetentionDays: null,
};

export function withConfig(overrides: Partial<PersistenceConfig> = {}): PersistenceConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (config.busyTimeoutMs < 0) throw new Error("busyTimeoutMs must be non-negative.");
  if (config.dispatcherBatchSize < 1) throw new Error("dispatcherBatchSize must be positive.");
  if (config.dispatcherRetryBackoffMs < 0) throw new Error("dispatcherRetryBackoffMs must be non-negative.");
  if (config.signalRetentionDays !== null && config.signalRetentionDays < 1) {
    throw new Error("signalRetentionDays must be positive or null.");
  }
  return config;
}

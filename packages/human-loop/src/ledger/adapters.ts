import type { ParsedUsageRecord } from "../types.js";

export type SessionLogAdapter = {
  provider: string;
  version: string;
  /**
   * Parse a session log. Return records or throw / return degrade.
   * Format drift → degrade, never workflow failure.
   */
  parse(logText: string): { ok: true; records: ParsedUsageRecord[] } | { ok: false; reason: string };
};

function linesJson(logText: string): unknown[] {
  const out: unknown[] = [];
  for (const line of logText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip non-json lines
    }
  }
  return out;
}

export function anthropicAdapter(version = "anthropic-session-v1"): SessionLogAdapter {
  return {
    provider: "anthropic",
    version,
    parse(logText) {
      try {
        const records: ParsedUsageRecord[] = [];
        for (const item of linesJson(logText)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          if (row.type !== "usage" && row.kind !== "usage") continue;
          const messageId = String(row.message_id ?? row.messageId ?? "");
          if (!messageId) continue;
          const usage = (row.usage as Record<string, unknown> | undefined) ?? row;
          records.push({
            messageId,
            provider: "anthropic",
            cacheTokens: Number(usage.cache_read_input_tokens ?? usage.cacheTokens ?? 0),
            inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
            outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
            adapterVersion: version,
            raw: row,
          });
        }
        if (records.length === 0 && logText.trim().length > 0 && !logText.includes("usage")) {
          return { ok: false, reason: "anthropic_log_unparseable" };
        }
        return { ok: true, records };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "anthropic_parse_error" };
      }
    },
  };
}

export function openaiAdapter(version = "openai-session-v1"): SessionLogAdapter {
  return {
    provider: "openai",
    version,
    parse(logText) {
      try {
        const records: ParsedUsageRecord[] = [];
        for (const item of linesJson(logText)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          if (row.object !== "usage" && row.type !== "usage") continue;
          const messageId = String(row.id ?? row.message_id ?? row.messageId ?? "");
          if (!messageId) continue;
          records.push({
            messageId,
            provider: "openai",
            cacheTokens: Number(row.cached_tokens ?? row.cacheTokens ?? 0),
            inputTokens: Number(row.prompt_tokens ?? row.input_tokens ?? row.inputTokens ?? 0),
            outputTokens: Number(row.completion_tokens ?? row.output_tokens ?? row.outputTokens ?? 0),
            adapterVersion: version,
            raw: row,
          });
        }
        if (records.length === 0 && logText.trim().length > 0 && !/usage|prompt_tokens/.test(logText)) {
          return { ok: false, reason: "openai_log_unparseable" };
        }
        return { ok: true, records };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "openai_parse_error" };
      }
    },
  };
}

export function googleAdapter(version = "google-session-v1"): SessionLogAdapter {
  return {
    provider: "google",
    version,
    parse(logText) {
      try {
        const records: ParsedUsageRecord[] = [];
        for (const item of linesJson(logText)) {
          if (!item || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          if (row.kind !== "usage" && row.type !== "usageMetadata") continue;
          const messageId = String(row.messageId ?? row.message_id ?? row.id ?? "");
          if (!messageId) continue;
          const meta = (row.usageMetadata as Record<string, unknown> | undefined) ?? row;
          records.push({
            messageId,
            provider: "google",
            cacheTokens: Number(meta.cachedContentTokenCount ?? meta.cacheTokens ?? 0),
            inputTokens: Number(meta.promptTokenCount ?? meta.inputTokens ?? 0),
            outputTokens: Number(meta.candidatesTokenCount ?? meta.outputTokens ?? 0),
            adapterVersion: version,
            raw: row,
          });
        }
        if (records.length === 0 && logText.trim().length > 0 && !/usage|TokenCount/.test(logText)) {
          return { ok: false, reason: "google_log_unparseable" };
        }
        return { ok: true, records };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "google_parse_error" };
      }
    },
  };
}

export function adapterForProvider(
  provider: string,
  versionPins: Record<string, string>,
): SessionLogAdapter {
  const version = versionPins[provider] ?? `${provider}-session-v1`;
  switch (provider) {
    case "anthropic":
      return anthropicAdapter(version);
    case "openai":
      return openaiAdapter(version);
    case "google":
      return googleAdapter(version);
    default:
      throw new Error(`No session-log adapter for provider ${provider}`);
  }
}

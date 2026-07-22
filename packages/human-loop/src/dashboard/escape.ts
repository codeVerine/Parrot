import type { UntrustedText } from "@platform/llm-boundary";
import { isUntrustedText } from "@platform/llm-boundary";

/** Escape for HTML text nodes / raw-HTML surfaces. Never unescapes. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Render untrusted text for raw-HTML surfaces — always escaped. */
export function renderUntrusted(value: string | UntrustedText): string {
  const text = isUntrustedText(value) ? value.value : value;
  return escapeHtml(text);
}

/**
 * True when `value` needs no escaping for HTML text (no angle brackets),
 * or already equals its escaped form. Used to detect raw markup before render.
 */
export function isInertHtml(value: string): boolean {
  return !/[<>]/.test(value) || escapeHtml(value) === value;
}

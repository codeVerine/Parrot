const MAX_INPUT_BYTES = 4 * 1024 * 1024;
type Primitive = string | number | boolean | null;
type Value = Primitive | Value[] | { [key: string]: Value };

export function encodeToon(value: unknown): string {
  const normalized = normalize(value);
  if (!isRecord(normalized)) throw new Error("TOON roots must be objects.");
  return `${writeObject(normalized, 0).join("\n")}\n`;
}

export function parseToon(input: string, maxBytes = MAX_INPUT_BYTES): unknown {
  if (Buffer.byteLength(input, "utf8") > maxBytes) throw new Error("TOON input exceeds the size limit.");
  const lines = input.split(/\r?\n/).filter((line) => line.trim()).map((line) => ({ indent: line.length - line.trimStart().length, text: line.trimStart() }));
  if (!lines.length) return {};
  const parsed = readObject(lines, 0, lines[0].indent);
  if (parsed.next !== lines.length) throw new Error(`Unexpected TOON line: ${lines[parsed.next].text}`);
  return parsed.value;
}

function writeObject(value: Record<string, Value>, indent: number): string[] {
  return Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, child]) => writeField(key, child, indent, ""));
}
function writeField(key: string, value: Value, indent: number, prefix: string): string[] {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}${prefix}${key}: []`];
    if (value.every(isPrimitive)) return [`${pad}${prefix}${key}[${value.length}]: ${value.map(primitive).join(",")}`];
    return [`${pad}${prefix}${key}[${value.length}]:`, ...value.flatMap((item) => isRecord(item) ? writeObjectItem(item, indent + 1) : isPrimitive(item) ? [`${"  ".repeat(indent + 1)}- ${primitive(item)}`] : (() => { throw new Error("Nested TOON arrays are not supported."); })())];
  }
  if (isRecord(value)) return [`${pad}${prefix}${key}:`, ...writeObject(value, indent + 1)];
  return [`${pad}${prefix}${key}: ${primitive(value)}`];
}
function writeObjectItem(value: Record<string, Value>, indent: number): string[] {
  const [[first, firstValue], ...rest] = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return [...writeField(first, firstValue, indent, "- "), ...rest.flatMap(([key, child]) => writeField(key, child, indent + 1, ""))];
}
function primitive(value: Primitive): string {
  if (typeof value !== "string") return String(value);
  return value && value.trim() === value && !/^(true|false|null|-|[-+]?\d+(?:\.\d+)?)$/.test(value) && !/[,:\\"\[\]{}\n\r\t]/.test(value) ? value : JSON.stringify(value);
}
function readObject(lines: Array<{ indent: number; text: string }>, start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const value: Record<string, unknown> = {};
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent || line.text.startsWith("-")) break;
    if (line.indent > indent) throw new Error(`Unexpected indentation before ${line.text}`);
    const field = /^([^:[\]]+?)(?:\[(\d+)\])?:\s*(.*)$/.exec(line.text);
    if (!field || unsafeKey(field[1].trim())) throw new Error(`Invalid TOON field: ${line.text}`);
    const key = field[1].trim();
    const length = field[2] ? Number(field[2]) : undefined;
    const rest = field[3];
    if (length !== undefined) {
      if (rest) value[key] = rest === "[]" ? [] : rest.split(",").map(parsePrimitive);
      else {
        const items: unknown[] = [];
        let cursor = index + 1;
        while (cursor < lines.length && lines[cursor].indent === indent + 2 && lines[cursor].text.startsWith("-")) {
          const text = lines[cursor].text.slice(1).trimStart();
          if (text.includes(":")) {
            const first = parseInline(text);
            const nested = readObject(lines, cursor + 1, indent + 4);
            items.push({ [first.key]: first.value, ...nested.value });
            cursor = nested.next;
          } else { items.push(parsePrimitive(text)); cursor += 1; }
        }
        if (items.length !== length) throw new Error(`Expected ${length} array entries, got ${items.length}.`);
        value[key] = items;
        index = cursor - 1;
      }
    } else if (rest) value[key] = rest === "[]" ? [] : parsePrimitive(rest);
    else if (index + 1 < lines.length && lines[index + 1].indent > indent) {
      const nested = readObject(lines, index + 1, lines[index + 1].indent); value[key] = nested.value; index = nested.next - 1;
    } else value[key] = {};
    index += 1;
  }
  return { value, next: index };
}
function parseInline(text: string): { key: string; value: unknown } {
  const match = /^([^:]+):\s*(.*)$/.exec(text);
  if (!match || unsafeKey(match[1].trim())) throw new Error(`Invalid TOON list item: ${text}`);
  return { key: match[1].trim(), value: match[2] ? parsePrimitive(match[2]) : {} };
}
function parsePrimitive(value: string): Primitive {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed) as string;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
function normalize(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => { if (unsafeKey(key)) throw new Error(`Unsafe TOON key: ${key}`); return [key, normalize(child)]; }));
  throw new Error("TOON values must be JSON-compatible.");
}
function isRecord(value: unknown): value is Record<string, Value> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPrimitive(value: Value): value is Primitive { return value === null || typeof value !== "object"; }
function unsafeKey(key: string): boolean { return key === "__proto__" || key === "constructor" || key === "prototype"; }

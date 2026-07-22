const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const NUMBER_PATTERN = /^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i;

type Primitive = string | number | boolean | null;
type Value = Primitive | Value[] | { [key: string]: Value };

type Line = {
  indent: number;
  text: string;
};

type FieldHeader = {
  key: string;
  arrayLength?: number;
  fields?: string[];
  value: string;
};

export function encodeToon(value: unknown): string {
  const normalized = normalize(value);
  if (!isRecord(normalized)) throw new Error("TOON roots must be objects.");
  return `${writeObject(normalized, 0).join("\n")}\n`;
}

export function parseToon(input: string, maxBytes = MAX_INPUT_BYTES): unknown {
  if (Buffer.byteLength(input, "utf8") > maxBytes) {
    throw new Error("TOON input exceeds the size limit.");
  }

  const lines = input
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ({
      indent: line.length - line.trimStart().length,
      text: line.trimStart(),
    }));

  if (lines.length === 0) return {};

  const parsed = readObject(lines, 0, lines[0].indent);
  if (parsed.next !== lines.length) {
    throw new Error(`Unexpected TOON line: ${lines[parsed.next].text}`);
  }
  return parsed.value;
}

function writeObject(value: Record<string, Value>, indent: number): string[] {
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, child]) => writeField(key, child, indent, ""));
}

function writeField(key: string, value: Value, indent: number, prefix: string): string[] {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}${prefix}${key}: []`];
    if (value.every(isPrimitive)) {
      return [`${pad}${prefix}${key}[${value.length}]: ${value.map(primitive).join(",")}`];
    }
    if (isTabularArray(value)) {
      const fields = Object.keys(value[0]).sort((left, right) => left.localeCompare(right));
      return [
        `${pad}${prefix}${key}[${value.length}]{${fields.join(",")}}:`,
        ...value.map((item) => `${"  ".repeat(indent + 1)}${fields.map((field) => primitive(item[field] as Primitive)).join(",")}`),
      ];
    }
    return [
      `${pad}${prefix}${key}[${value.length}]:`,
      ...value.flatMap((item) => {
        if (isRecord(item)) return writeObjectItem(item, indent + 1);
        if (isPrimitive(item)) return [`${"  ".repeat(indent + 1)}- ${primitive(item)}`];
        throw new Error("Nested TOON arrays are not supported.");
      }),
    ];
  }

  if (isRecord(value)) return [`${pad}${prefix}${key}:`, ...writeObject(value, indent + 1)];
  return [`${pad}${prefix}${key}: ${primitive(value)}`];
}

function writeObjectItem(value: Record<string, Value>, indent: number): string[] {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return [`${"  ".repeat(indent)}-`];

  const [[firstKey, firstValue], ...rest] = entries;
  return [
    ...writeField(firstKey, firstValue, indent, "- "),
    ...rest.flatMap(([key, child]) => writeField(key, child, indent + 1, "")),
  ];
}

function primitive(value: Primitive): string {
  if (typeof value !== "string") return String(value);

  const needsQuotes =
    value.length === 0 ||
    value.trim() !== value ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    value === "-" ||
    value.startsWith("-") ||
    NUMBER_PATTERN.test(value) ||
    /[:,\\"[\]{}\n\r\t]/.test(value);

  return needsQuotes ? JSON.stringify(value) : value;
}

function readObject(lines: Line[], start: number, indent: number): { value: Record<string, unknown>; next: number } {
  const value: Record<string, unknown> = {};
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent || line.text.startsWith("-")) break;
    if (line.indent > indent) throw new Error(`Unexpected indentation before ${line.text}`);

    const parsed = readField(lines, index, indent);
    value[parsed.key] = parsed.value;
    index = parsed.next;
  }

  return { value, next: index };
}

function readField(
  lines: Line[],
  index: number,
  indent: number,
): { key: string; value: unknown; next: number } {
  const header = parseFieldHeader(lines[index].text);

  if (header.arrayLength !== undefined) {
    if (header.fields) {
      const parsed = parseTabularArray(lines, index + 1, indent + 2, header.arrayLength, header.fields);
      return { key: header.key, value: parsed.value, next: parsed.next };
    }
    if (header.value.length > 0) {
      const values = parseInlineArray(header.value);
      if (values.length !== header.arrayLength) {
        throw new Error(`Expected ${header.arrayLength} array entries, got ${values.length}.`);
      }
      return { key: header.key, value: values, next: index + 1 };
    }
    const parsed = parseListArray(lines, index + 1, indent + 2, header.arrayLength);
    return { key: header.key, value: parsed.value, next: parsed.next };
  }

  if (header.value === "[]") return { key: header.key, value: [], next: index + 1 };
  if (header.value.length > 0) {
    return { key: header.key, value: parsePrimitive(header.value), next: index + 1 };
  }
  if (index + 1 >= lines.length || lines[index + 1].indent <= indent) {
    return { key: header.key, value: {}, next: index + 1 };
  }

  const parsed = readObject(lines, index + 1, indent + 2);
  return { key: header.key, value: parsed.value, next: parsed.next };
}

function parseListArray(
  lines: Line[],
  start: number,
  indent: number,
  expectedLength: number,
): { value: unknown[]; next: number } {
  const value: unknown[] = [];
  let index = start;

  while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("-")) {
    const rest = lines[index].text.slice(1).trimStart();
    if (rest.length === 0) {
      value.push({});
      index += 1;
      continue;
    }

    if (!rest.startsWith('"') && looksLikeObjectField(rest)) {
      const item: Record<string, unknown> = {};
      const first = readInlineObjectField(lines, index, indent, rest);
      item[first.key] = first.value;
      index = first.next;

      const extra = readObject(lines, index, indent + 2);
      Object.assign(item, extra.value);
      value.push(item);
      index = extra.next;
      continue;
    }

    value.push(parsePrimitive(rest));
    index += 1;
  }

  if (value.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} array entries, got ${value.length}.`);
  }
  return { value, next: index };
}

function readInlineObjectField(
  lines: Line[],
  index: number,
  indent: number,
  text: string,
): { key: string; value: unknown; next: number } {
  const header = parseFieldHeader(text);

  if (header.arrayLength !== undefined) {
    if (header.fields) {
      const parsed = parseTabularArray(lines, index + 1, indent + 2, header.arrayLength, header.fields);
      return { key: header.key, value: parsed.value, next: parsed.next };
    }
    if (header.value.length > 0) {
      const values = parseInlineArray(header.value);
      if (values.length !== header.arrayLength) {
        throw new Error(`Expected ${header.arrayLength} array entries, got ${values.length}.`);
      }
      return { key: header.key, value: values, next: index + 1 };
    }
    const parsed = parseListArray(lines, index + 1, indent + 2, header.arrayLength);
    return { key: header.key, value: parsed.value, next: parsed.next };
  }

  if (header.value === "[]") return { key: header.key, value: [], next: index + 1 };
  if (header.value.length > 0) {
    return { key: header.key, value: parsePrimitive(header.value), next: index + 1 };
  }

  const parsed = readObject(lines, index + 1, indent + 2);
  return { key: header.key, value: parsed.value, next: parsed.next };
}

function parseTabularArray(
  lines: Line[],
  start: number,
  indent: number,
  expectedLength: number,
  fields: string[],
): { value: unknown[]; next: number } {
  const value: unknown[] = [];
  let index = start;

  while (value.length < expectedLength) {
    if (index >= lines.length || lines[index].indent !== indent || lines[index].text.startsWith("-")) {
      throw new Error(`Expected ${expectedLength} TOON table rows, got ${value.length}.`);
    }

    const cells = splitCommaValues(lines[index].text);
    if (cells.length !== fields.length) {
      throw new Error(`Expected ${fields.length} TOON table cells, got ${cells.length}.`);
    }

    value.push(Object.fromEntries(fields.map((field, fieldIndex) => [field, parsePrimitive(cells[fieldIndex])])))
    index += 1;
  }

  return { value, next: index };
}

function parseFieldHeader(text: string): FieldHeader {
  const header = /^([^:[\]{}]+?)(?:\[(\d+)\](?:\{([^}]*)\})?)?:\s*(.*)$/.exec(text);
  if (!header || unsafeKey(header[1].trim())) throw new Error(`Invalid TOON field: ${text}`);

  const fields = header[3] === undefined
    ? undefined
    : header[3].split(",").map((field) => field.trim());
  if (fields?.some((field) => field.length === 0 || unsafeKey(field))) {
    throw new Error(`Invalid TOON table fields: ${text}`);
  }

  return {
    key: header[1].trim(),
    arrayLength: header[2] === undefined ? undefined : Number(header[2]),
    fields,
    value: header[4] ?? "",
  };
}

function parseInlineArray(value: string): unknown[] {
  if (value === "[]") return [];
  return splitCommaValues(value).map(parsePrimitive);
}

function splitCommaValues(value: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (inQuotes) throw new Error(`Unterminated quoted TOON value: ${value}`);
  values.push(current.trim());
  return values;
}

function parsePrimitive(value: string): Primitive {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) throw new Error(`Invalid quoted TOON value: ${value}`);
    return JSON.parse(trimmed) as string;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (NUMBER_PATTERN.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function normalize(value: unknown): Value {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TOON values must use finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (unsafeKey(key)) throw new Error(`Unsafe TOON key: ${key}`);
      return [key, normalize(child)];
    }));
  }
  throw new Error("TOON values must be JSON-compatible.");
}

function isTabularArray(value: Value[]): value is Array<Record<string, Value>> {
  if (!value.every(isRecord)) return false;
  const firstKeys = Object.keys(value[0]).sort();
  return value.every((item) => {
    const keys = Object.keys(item).sort();
    return keys.length === firstKeys.length && keys.every((key, index) => key === firstKeys[index]) && Object.values(item).every(isPrimitive);
  });
}

function looksLikeObjectField(value: string): boolean {
  return /^[^:[\]{}]+?(?:\[(\d+)\](?:\{[^}]*\})?)?:\s*/.test(value);
}

function isRecord(value: unknown): value is Record<string, Value> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitive(value: Value): value is Primitive {
  return value === null || typeof value !== "object";
}

function unsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

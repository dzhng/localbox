import type { Json, ResponseEnvelope } from "../../../packages/contract/src/index.js";

export interface Rendered { stdout: string; stderr: string; exitCode: number }

const GIB = 1024 ** 3;
const isEnvelope = (value: unknown): value is ResponseEnvelope => !!value && typeof value === "object" && "ok" in value && "release_id" in value;
const isObject = (value: Json): value is { [key: string]: Json } => !!value && typeof value === "object" && !Array.isArray(value);
const isActionReport = (value: Json): value is { requested: Json; produced: Json; actions: Json[] } => isObject(value) && Array.isArray(value.actions) && "produced" in value && "requested" in value;

/**
 * The one way the CLI prints a result. `--json` prints the envelope (or the plain value for local commands); text
 * prints the same facts: every key of the result, with an action report's actions first, one per line.
 */
export function render(value: ResponseEnvelope | Json, options: { json: boolean }): Rendered {
  if (isEnvelope(value)) {
    if (options.json) return { stdout: `${JSON.stringify(value, null, 2)}\n`, stderr: value.ok ? "" : `${value.error.code}: ${value.error.message}\n`, exitCode: exitCode(value) };
    if (value.ok) return { stdout: text(value.result), stderr: "", exitCode: 0 };
    const details = value.error.details === undefined ? "" : text(value.error.details);
    return { stdout: "", stderr: `${value.error.code}: ${value.error.message}\n${details}`, exitCode: exitCode(value) };
  }
  return { stdout: options.json ? `${JSON.stringify(value, null, 2)}\n` : text(value), stderr: "", exitCode: 0 };
}

const exitCode = (envelope: ResponseEnvelope) => envelope.ok ? 0 : envelope.error.code === "unauthorized" ? 2 : 1;

function text(value: Json): string {
  if (isActionReport(value)) {
    const { actions, produced, requested, ...rest } = value;
    const done = actions.length ? actions.map((action) => isObject(action) ? actionLine(action) : `- ${scalar(action)}`) : ["- no changes"];
    return [...done, ...lines({ produced, requested, ...rest }, "")].join("\n") + "\n";
  }
  if (!isObject(value) && !Array.isArray(value)) return `${scalar(value)}\n`;
  const body = lines(value, "").join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

function actionLine(action: { [key: string]: Json }): string {
  const { kind, detail, ...rest } = action;
  const extra = Object.entries(rest).map(([key, item]) => `${key}=${isObject(item) || Array.isArray(item) ? JSON.stringify(item) : scalar(item)}`);
  return `- ${scalar(kind)}${detail === undefined ? "" : `: ${scalar(detail)}`}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

function lines(value: Json, indent: string): string[] {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}(none)`];
    return value.flatMap((item) => {
      if (isObject(item) && Object.values(item).every((field) => !isObject(field) && !Array.isArray(field) && !multiline(field))) return [`${indent}- ${namedFirst(item).map(([key, field]) => `${key}: ${scalar(field, key)}`).join(", ")}`];
      if (isObject(item) || Array.isArray(item)) return [`${indent}-`, ...lines(item, `${indent}  `)];
      return multiline(item) ? [`${indent}-`, block(item as string)] : [`${indent}- ${scalar(item)}`];
    });
  }
  if (!isObject(value)) return [`${indent}${scalar(value)}`];
  return Object.entries(value).flatMap(([key, item]) => {
    if (multiline(item)) return [`${indent}${key}:`, block(item as string)];
    if (Array.isArray(item) && item.every((entry) => !isObject(entry) && !Array.isArray(entry) && !multiline(entry))) return [`${indent}${key}: ${item.length ? item.map((entry) => scalar(entry)).join(", ") : "(none)"}`];
    if (isObject(item) && !Object.keys(item).length) return [`${indent}${key}: (none)`];
    if (isObject(item) || Array.isArray(item)) return [`${indent}${key}:`, ...lines(item, `${indent}  `)];
    return [`${indent}${key}: ${scalar(item, key)}`];
  });
}

/** A row reads by its name first (Convex returns keys sorted). */
const namedFirst = (item: { [key: string]: Json }) => Object.entries(item).sort(([a], [b]) => Number(b === "name") - Number(a === "name"));
const multiline = (value: Json) => typeof value === "string" && value.includes("\n");
/** Multi-line strings (command output, file content) print verbatim so they can be read or copied as they are. */
const block = (value: string) => value.endsWith("\n") ? value.slice(0, -1) : value;
function scalar(value: Json, key = ""): string {
  if (typeof value === "number" && key.endsWith("bytes") && value >= GIB) return `${value} (${Math.round(value / GIB * 10) / 10} GiB)`;
  return value === null ? "null" : String(value);
}

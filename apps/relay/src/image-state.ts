import {
  BUILT_IN_IMAGE, ERROR_CODES, failure, gibibytes, HOST_OPERATION_KINDS, sizeText,
  type ErrorCode, type HostOperationRecord, type ImageOperationState, type Json,
} from "../../../packages/contract/src/index.js";
import { contractError } from "../../../packages/contract/src/convex-errors.js";
import { MACOS_IMAGE_MINIMUM } from "../../../packages/placement/src/index.js";
import { answer, toHttp, type OpsDeps, type OpsResponse, type Principal, type Relayed } from "./relay-wait.js";

/** A row of `images:list` / `images:get`. */
export interface ImageRow {
  image_id: string; name: string; os: "linux" | "macos"; size_bytes: number | null; disk_bytes: number | null; min_macos: string | null; source: { kind: "sandbox" | "ipsw" | "release"; sandboxName?: string; ipswVersion?: string };
  default: boolean; created_at: number | null;
  holders: Array<{ machine_id: string; machine_name: string | null; state: "building" | "copying" | "ready" | "failed"; operation_id: string | null; error: { code: string; message: string; next_step: string } | null; updated_at: number | null }>;
}
type Holder = ImageRow["holders"][number];

/** A row of `images:copyByOperation` / `images:startCopy`: one copy, without its key. */
export interface CopyRow {
  copy_id: string; image_id: string; operation_id: string; state: "waiting" | "copying" | "copied" | "failed";
  from_machine_id: string; from_machine_name: string | null; to_machine_id: string; to_machine_name: string | null;
  result: { bytes: number; duration_ms: number; path: "local_network" | "internet" } | null; error: { code: string; message: string; next_step: string } | null;
}

/** What a finished `image.copy` keeps (both sides). */
interface CopyResult { size_bytes?: number; bytes?: number; duration_ms?: number; path?: string }
/** What a finished `sandbox.create_after_copy` keeps: the sandbox as created, and what its copy moved. */
interface AfterCopyResult { name: string; cpus: number; memory_bytes: number; disk_bytes: number; state: string; copy_operation_id?: string; copy: CopyResult | null }
/** What a finished `image.capture` reports: the image's size and disk size, and how the source got through it. */
interface CaptureResult { size_bytes: number; disk_bytes: number; stall_ms: number | null; woke?: string; made_room?: string[] }
/** What a finished `macos.build` reports: the release it installed, what it holds and its disk size, the oldest macOS that runs it, and the sandboxes slept to free a macOS VM slot for it. */
interface BuildResult { size_bytes: number; disk_bytes: number; ipsw_version: string; ipsw_build?: string; min_macos?: string; chrome_version?: string; made_room?: string[] }

/** A record's progress as the contract shows it: bytes when the kind counts them, else 0 of 0. */
export const progressOf = (record: HostOperationRecord): ImageOperationState["progress"] =>
  record.progress ? { phase: record.progress.phase, done_bytes: record.progress.completed ?? 0, total_bytes: record.progress.total ?? 0 } : undefined;
/** "12 MiB of 64 MiB" while bytes move, else the phase in words. */
export const progressText = (progress: NonNullable<ImageOperationState["progress"]>) => progress.total_bytes > 0 ? `${sizeText(progress.done_bytes)} of ${sizeText(progress.total_bytes)}` : progress.phase.replaceAll("_", " ");
/** The two Macs a copy runs between, by name. */
const copyEnds = (copy: CopyRow | undefined) => ({ from: copy?.from_machine_name ?? copy?.from_machine_id ?? "its source", to: copy?.to_machine_name ?? copy?.to_machine_id ?? "the target" });
const errorCode = (code: string): ErrorCode => (ERROR_CODES as readonly string[]).includes(code) ? code as ErrorCode : "internal";
export const nextStepFor = (image: ImageRow) => `delete it with localbox image delete ${image.name} --confirm ${image.name}, then create or copy it again`;
const identity = (image: ImageRow) => ({ image: image.image_id, name: image.name, os: image.os });
const withProgress = (record: HostOperationRecord) => { const progress = progressOf(record); return progress ? { progress } : {}; };

/**
 * A machine's `image.wait`, `image.create` or `image.copy` answer (its operation record) as the image's operation
 * state, with the image's name and OS from the catalog. Used on the first call and on every continuation, so a long
 * wait reads the same either way; any other answer passes through.
 */
export async function imageWaitAnswer(principal: Principal, relayed: Relayed, deps: OpsDeps, known?: ImageRow, knownCopy?: CopyRow): Promise<OpsResponse> {
  const response = "response" in relayed ? relayed.response : undefined;
  if (!response?.ok) return toHttp(relayed);
  const record = response.result as unknown as HostOperationRecord;
  let image = known; let copy = knownCopy;
  try {
    image ??= await deps.accountCall(principal, "query", "images:get", { image: record.subject }) as ImageRow;
    const copyKey = record.kind === HOST_OPERATION_KINDS.copy ? record.key : record.kind === HOST_OPERATION_KINDS.createAfterCopy ? (record.result as unknown as AfterCopyResult | undefined)?.copy_operation_id : undefined;
    if (copyKey) copy ??= await deps.accountCall(principal, "query", "images:copyByOperation", { operationId: copyKey }) as CopyRow | null ?? undefined;
  } catch (error) { return answer(failure(relayed.request, contractError(error))); }
  // A copy answers for its operation, whatever the request was; a request's id stays its own.
  const state = record.kind === HOST_OPERATION_KINDS.copy ? copyState(image, record, copy) : record.kind === HOST_OPERATION_KINDS.createAfterCopy ? afterCopyState(image, record, copy) : operationState(image, record);
  return answer({ ...response, result: state as unknown as Json });
}

/**
 * A sandbox create chained to its image's copy, as `image wait` follows it on the Mac the copy goes to: `copying` with the
 * copy's progress, then the copy's line and the created sandbox's, or why it failed and what to try next.
 */
function afterCopyState(image: ImageRow, record: HostOperationRecord, copy: CopyRow | undefined): ImageOperationState {
  if (record.state === "running") return { ...identity(image), state: "copying", ...withProgress(record) };
  if (record.state === "failed") return { ...identity(image), state: "failed", error: { code: errorCode(record.error?.code ?? "internal"), message: record.error?.message ?? "the create failed", next_step: record.error?.next_step ?? nextStepFor(image) } };
  const made = record.result as unknown as AfterCopyResult;
  const to = copy ? copyEnds(copy).to : "this Mac";
  return { ...identity(image), state: "ready", report: [
    copiedLine(image, copy, { size: made.copy?.size_bytes ?? image.size_bytes, duration: copy?.result?.duration_ms ?? made.copy?.duration_ms ?? 0, path: copy?.result?.path ?? made.copy?.path }),
    `created sandbox ${made.name} on ${to}: ${made.cpus} CPUs, ${gibibytes(made.memory_bytes)} of memory and ${gibibytes(made.disk_bytes)} of disk, ${made.state}`,
    `run a command in it: localbox shell exec --sandbox ${made.name} -- CMD`,
  ] };
}

/** `copied image NAME from A to B (SIZE, DURATION, PATH)`. */
function copiedLine(image: ImageRow, copy: CopyRow | undefined, done: { size: number | null | undefined; duration: number; path: string | undefined }): string {
  const { from, to } = copyEnds(copy);
  return `copied image ${image.name} from ${from} to ${to} (${sizeText(done.size ?? null)}, ${durationText(done.duration)}, ${done.path === "internet" ? "internet" : "local network"})`;
}

/**
 * A copy's state, from the target's record and the copy's row. A row that finished wins over a record answered before
 * it did (a replay gets the first answer back from the relay). A copied image reports size, duration and the path.
 */
function copyState(image: ImageRow, record: HostOperationRecord, copy: CopyRow | undefined): ImageOperationState {
  const { from, to } = copyEnds(copy);
  const result = record.result as unknown as CopyResult | undefined;
  if (copy?.state === "copied" || record.state === "succeeded") {
    const done = { size: result?.size_bytes ?? image.size_bytes, duration: copy?.result?.duration_ms ?? result?.duration_ms ?? 0, path: copy?.result?.path ?? result?.path };
    return { ...identity(image), state: "ready", report: [
      copiedLine(image, copy, done),
      `start a sandbox from it there: localbox sandbox create --image ${image.name} --machine ${to}`,
    ] };
  }
  const failed = record.state === "failed" ? record.error : copy?.state === "failed" ? copy.error : undefined;
  if (failed) return { ...identity(image), state: "failed", error: { code: errorCode(failed.code), message: `copying ${image.name} from ${from} to ${to} failed: ${failed.message}`, next_step: failed.next_step ?? nextStepFor(image) } };
  return { ...identity(image), state: "copying", ...withProgress(record) };
}

/** A duration for a report: "9.5 s", "3 min 5 s", "1 h 2 min". */
export function durationText(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 100) / 10} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

/** A running record shows its holder's state (`building` or `copying`); a finished one is `ready` or `failed`. */
function operationState(image: ImageRow, record: HostOperationRecord): ImageOperationState {
  const holder = image.holders.find((candidate) => candidate.operation_id === record.key);
  const state = record.state === "succeeded" ? "ready" : record.state === "failed" ? "failed" : holder?.state === "copying" ? "copying" : "building";
  const report = record.state !== "succeeded" ? undefined
    : record.kind === HOST_OPERATION_KINDS.capture ? captureReport(image, record.result as unknown as CaptureResult, holder)
    : record.kind === HOST_OPERATION_KINDS.macosBuild ? buildReport(image, record.result as unknown as BuildResult, holder) : undefined;
  return {
    ...identity(image), state, ...withProgress(record),
    ...(record.error ? { error: { code: errorCode(record.error.code), message: record.error.message, next_step: record.error.next_step ?? nextStepFor(image) } } : {}),
    ...(report ? { report } : {}),
  };
}

/**
 * A saved sandbox, line by line (the map's output standard): what was saved, how long the sandbox froze for it, where
 * the image lives, and the next command. A stopped source was saved without a freeze and says so; a sleeping one woke
 * first, and anything slept to make room for it is named.
 */
function captureReport(image: ImageRow, result: CaptureResult, holder: Holder | undefined): string[] {
  const source = image.source.sandboxName ?? "the sandbox";
  const froze = result.stall_ms === null
    ? `${source} was stopped, so its disk was saved as it lay, without a freeze`
    : `${source} ${result.woke ? "woke from sleep, then " : ""}froze for ${(result.stall_ms / 1000).toFixed(1)} s while its disk was saved, and is running again`;
  return [
    `image ${image.name} saved from sandbox ${source} (${image.os}, ${sizeText(result.size_bytes)}; sandboxes from it get a disk of at least ${gibibytes(result.disk_bytes)})`,
    froze,
    ...(result.made_room ?? []).map((detail) => `made room for it: ${detail}`),
    `on machine ${holder?.machine_name ?? holder?.machine_id ?? "its source's Mac"}; copies to other Macs on first use`,
    `start a sandbox from it: localbox sandbox create --image ${image.name}`,
  ];
}

/** A built macOS base, line by line: where it came from, what is in it, anything slept to make room for it, where it lives, and the next command. */
function buildReport(image: ImageRow, result: BuildResult, holder: Holder | undefined): string[] {
  return [
    `image ${image.name} built from the macOS ${result.ipsw_version}${result.ipsw_build ? ` (${result.ipsw_build})` : ""} IPSW (${image.os}, ${sizeText(result.size_bytes)}; sandboxes from it get a disk of at least ${gibibytes(result.disk_bytes)})`,
    `SIP is disabled, Google Chrome${result.chrome_version ? ` ${result.chrome_version}` : ""} is installed, Remote Login is off, and there is no Xcode`,
    ...(result.made_room ?? []).map((detail) => `made room for it: ${detail}`),
    `on machine ${holder?.machine_name ?? holder?.machine_id ?? "the Mac that built it"}; runs on Macs with macOS ${result.min_macos ?? image.min_macos ?? MACOS_IMAGE_MINIMUM} or later`,
    `start a sandbox from it: localbox sandbox create --image ${image.name}`,
  ];
}

/** No Mac is building or copying the image, so the catalog's holder rows say how it stands. */
export function catalogState(image: ImageRow): ImageOperationState {
  const ready = image.holders.filter((holder) => holder.state === "ready");
  if (image.image_id === BUILT_IN_IMAGE || ready.length) {
    const on = image.image_id === BUILT_IN_IMAGE ? "every Mac" : ready.map(holderName).join(", ");
    return { ...identity(image), state: "ready", report: [`image ${image.name} is ready on ${on}`, `start a sandbox from it: localbox sandbox create --image ${image.name}`] };
  }
  const failed = image.holders.find((holder) => holder.state === "failed");
  if (failed) {
    const where = failed.machine_name ?? failed.machine_id;
    return { ...identity(image), state: "failed", error: failed.error ? { code: errorCode(failed.error.code), message: `on ${where}: ${failed.error.message}`, next_step: failed.error.next_step } : { code: "internal", message: `the operation on ${where} failed`, next_step: nextStepFor(image) } };
  }
  return { ...identity(image), state: "failed", error: { code: "machine_not_found", message: `no machine holds ${image.name} any more (the Macs that held it left the account)`, next_step: nextStepFor(image) } };
}

export const holderName = (holder: Holder) => `${holder.machine_name ?? holder.machine_id}${holder.state === "ready" ? "" : ` (${holder.state})`}`;
const imageSource = (source: ImageRow["source"]) => source.kind === "release" ? "release" : source.kind === "ipsw" ? `macOS ${source.ipswVersion ?? ""} IPSW`.replace("  ", " ") : `sandbox ${source.sandboxName ?? "(unknown)"}`;

/**
 * One `image list` row: the facts its table shows (`NAME OS SIZE DISK FROM ON DEFAULT`) and nothing else, so text and
 * JSON carry the same. `on` names the Macs holding the image, with any holding not yet ready marked; `linux` is on every Mac.
 */
export function imageListRow(image: ImageRow): Json {
  return { name: image.name, os: image.os, size_bytes: image.size_bytes, disk_bytes: image.disk_bytes, from: imageSource(image.source), on: image.image_id === BUILT_IN_IMAGE ? ["every Mac"] : image.holders.map(holderName), default: image.default };
}

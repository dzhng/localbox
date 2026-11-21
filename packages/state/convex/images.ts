import { internalMutationGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireAccount, requireIdentity } from "./lib/identity.js";
import { boundedRows, byField, id, liveMachines, refuse } from "./lib/relay.js";
import { copyCandidate, copyResult, holderFailure, holderState, imageOs, imageSource } from "./schema.js";
import { sandboxName, validateLabel } from "../../names/src/index.js";
import { BUILT_IN_IMAGE } from "../../contract/src/index.js";

// The account's images, the machines holding each, and the account default. The built-in `linux` is never a row:
// every Mac has the build its release shipped, so `list` synthesizes it with every live machine as a ready holder,
// and holder rows for it could only drift.

/** Reserved for the account's macOS base: it resolves to the most recent image built from an IPSW. */
const MACOS_IMAGE = "macos";
const NAME_ATTEMPTS = 20;
const HOLDER_BATCH = 200;
/** A copy's rendezvous row, and its key, last a day; a copy still unfinished then has failed. */
export const COPY_TTL_MS = 24 * 60 * 60 * 1000;
/** Candidates one end may publish: every interface address plus what STUN reflected is far fewer. */
const MAX_CANDIDATES = 16;
/** Copies a machine's subscription carries per direction, newest first. */
const COPY_BATCH = 50;

const accountImages = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("images").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId)), "image list");
const accountHolders = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("imageHolders").withIndex("by_account", (q: any) => q.eq("accountId", accountId)), "image holders");
const imageHolders = async (ctx: any, imageId: string) => await boundedRows(ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", imageId)), "image holders");
const named = async (ctx: any, accountId: string, name: string) => await ctx.db.query("images").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId).eq("name", name)).first();
const account = async (ctx: any, accountId: string) => await byField(ctx, "accounts", "by_account", "accountId", accountId);
const machineNames = async (ctx: any, accountId: string) => new Map<string, string>((await liveMachines(ctx, accountId)).map((row: any) => [row.machineId, row.name]));

/** A name the caller chose: a valid label, neither built-in name, and free on the account. */
async function freeName(ctx: any, accountId: string, name: string): Promise<string> {
  validateLabel(name);
  if (name === BUILT_IN_IMAGE || name === MACOS_IMAGE) refuse("invalid_input", `${name} is a built-in image name; choose another`);
  if (await named(ctx, accountId, name)) {
    const names = (await accountImages(ctx, accountId)).map((row: any) => row.name).sort();
    refuse("name_conflict", `${name} is taken on this account; images: ${names.join(", ")}`, { names });
  }
  return name;
}

/**
 * The image `wanted` names (a name or id) on the account: `linux` is the built-in (`undefined`), `macos` the most
 * recent IPSW-built image. Anything else not found names the images there are.
 */
async function resolve(ctx: any, accountId: string, wanted: string): Promise<any | undefined> {
  if (wanted === BUILT_IN_IMAGE) return undefined;
  const rows = await accountImages(ctx, accountId);
  if (wanted === MACOS_IMAGE) {
    const base = rows.filter((row: any) => row.source.kind === "ipsw").sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
    return base ?? refuse("image_not_found", "no macOS image yet; build one with: localbox image create --macos");
  }
  const row = rows.find((candidate: any) => candidate.imageId === wanted) ?? rows.find((candidate: any) => candidate.name === wanted);
  if (row) return row;
  const names = [BUILT_IN_IMAGE, ...rows.map((candidate: any) => candidate.name).sort()];
  return refuse("image_not_found", `no image ${wanted} on this account; images: ${names.join(", ")}`, { names });
}

const holderView = (row: any, machines: Map<string, string>) => ({
  machine_id: row.machineId, machine_name: machines.get(row.machineId) ?? null, state: row.state, operation_id: row.operationId ?? null,
  error: row.error ? { code: row.error.code, message: row.error.message, next_step: row.error.nextStep } : null, updated_at: row.updatedAt,
});
const view = (row: any, holders: any[], machines: Map<string, string>, defaultImageId: string | undefined) => ({
  image_id: row.imageId, name: row.name, os: row.os, size_bytes: row.sizeBytes ?? null, source: row.source, min_macos: row.minMacOS ?? null,
  created_at: row.createdAt, default: row.imageId === defaultImageId, holders: holders.map((holder) => holderView(holder, machines)),
});

/** The built-in `linux`, synthesized: every live machine holds it, ready. */
const linuxView = (live: any[], defaultImageId: string | undefined) => ({
  image_id: BUILT_IN_IMAGE, name: BUILT_IN_IMAGE, os: "linux", size_bytes: null, source: { kind: "release" }, min_macos: null, created_at: null,
  default: defaultImageId === undefined, holders: live.map((row: any) => ({ machine_id: row.machineId, machine_name: row.name, state: "ready", operation_id: null, error: null, updated_at: null })),
});

/** Every image on the account, `linux` first; an image whose holders are all gone stays listed with `holders: []`. */
export const list = queryGeneric({ args: {}, handler: async (ctx) => {
  const { accountId } = await requireAccount(ctx);
  const live = await liveMachines(ctx, accountId);
  const machines = new Map<string, string>(live.map((row: any) => [row.machineId, row.name]));
  const defaultImageId = (await account(ctx, accountId))?.defaultImageId;
  const holders = await accountHolders(ctx, accountId);
  const images = (await accountImages(ctx, accountId)).sort((a: any, b: any) => a.createdAt - b.createdAt);
  return [linuxView(live, defaultImageId), ...images.map((row: any) => view(row, holders.filter((holder: any) => holder.imageId === row.imageId), machines, defaultImageId))];
} });

/**
 * One image (a name or id; `linux`, `macos` as `list` and `rename` read them) as `list` shows it. With no image, the
 * account default: `sandbox create` names none.
 */
export const get = queryGeneric({ args: { image: v.optional(v.string()) }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const live = await liveMachines(ctx, accountId);
  const defaultImageId = (await account(ctx, accountId))?.defaultImageId;
  const row = await resolve(ctx, accountId, args.image ?? defaultImageId ?? BUILT_IN_IMAGE);
  if (!row) return linuxView(live, defaultImageId);
  return view(row, await imageHolders(ctx, row.imageId), new Map<string, string>(live.map((machine: any) => [machine.machineId, machine.name])), defaultImageId);
} });

/**
 * Reserves a new image's identity and makes `machineId` its first holder, `building`; that machine then builds it. A
 * reserve carrying a mutation id this account already reserved with returns that image instead of a second one.
 */
export const reserve = mutationGeneric({ args: { machineId: v.string(), name: v.optional(v.string()), os: imageOs, source: imageSource, minMacOS: v.optional(v.string()), createMutationId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const machine = await byField(ctx, "machines", "by_machine", "machineId", args.machineId);
  if (!machine || machine.accountId !== accountId || machine.revokedAt !== undefined) refuse("machine_not_found", `no machine ${args.machineId} on this account`);
  const machines = await machineNames(ctx, accountId);
  const defaultImageId = (await account(ctx, accountId))?.defaultImageId;
  const reserved = await ctx.db.query("images").withIndex("by_account_mutation", (q: any) => q.eq("accountId", accountId).eq("createMutationId", args.createMutationId)).first();
  if (reserved) return view(reserved, await imageHolders(ctx, reserved.imageId), machines, defaultImageId);
  let name = args.name === undefined ? undefined : await freeName(ctx, accountId, args.name);
  for (let attempt = 0; attempt < NAME_ATTEMPTS && name === undefined; attempt++) { const candidate = sandboxName(); if (!(await named(ctx, accountId, candidate))) name = candidate; }
  if (name === undefined) refuse("name_conflict", `no free generated name after ${NAME_ATTEMPTS} tries; pass a name`);
  const now = Date.now();
  const row = { imageId: id("image"), accountId, name: name!, os: args.os, source: args.source, ...(args.minMacOS === undefined ? {} : { minMacOS: args.minMacOS }), createdAt: now, createMutationId: args.createMutationId };
  const holder = { imageId: row.imageId, accountId, machineId: machine.machineId, state: "building" as const, operationId: args.createMutationId, updatedAt: now };
  await ctx.db.insert("images", row);
  await ctx.db.insert("imageHolders", holder);
  return view(row, [holder], machines, defaultImageId);
} });

export const rename = mutationGeneric({ args: { image: v.string(), name: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await resolve(ctx, accountId, args.image);
  if (!row) return refuse("invalid_input", "linux is the built-in image and can't be renamed");
  if (args.name !== row.name) await ctx.db.patch(row._id, { name: await freeName(ctx, accountId, args.name) });
  return { image_id: row.imageId, name: args.name, previous_name: row.name };
} });

/** Makes the image the account default; `linux` clears the field, since absent means `linux`. */
export const setDefault = mutationGeneric({ args: { image: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await resolve(ctx, accountId, args.image);
  const owner = await account(ctx, accountId);
  if (!owner) return refuse("invalid_input", "account not found");
  await ctx.db.patch(owner._id, { defaultImageId: row?.imageId });
  return { image_id: row?.imageId ?? BUILT_IN_IMAGE, name: row?.name ?? BUILT_IN_IMAGE };
} });

/**
 * Deletes the image's record and its holder rows (the machines delete their files when told); sandboxes made from it
 * keep their own disks. Deleting the default resets it to `linux`, and the result says so.
 */
export const remove = mutationGeneric({ args: { image: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await resolve(ctx, accountId, args.image);
  if (!row) return refuse("invalid_input", "linux is the built-in image and can't be deleted");
  const holders = await imageHolders(ctx, row.imageId);
  for (const holder of holders) await ctx.db.delete(holder._id);
  // A copy of a deleted image has nothing left to make; its two Macs give up when their rendezvous row goes.
  for (const copy of await boundedRows(ctx.db.query("copies").withIndex("by_image", (q: any) => q.eq("imageId", row.imageId)), "image copies")) await ctx.db.delete(copy._id);
  await ctx.db.delete(row._id);
  const owner = await account(ctx, accountId);
  const defaultReset = owner?.defaultImageId === row.imageId;
  if (defaultReset) await ctx.db.patch(owner._id, { defaultImageId: undefined });
  return { image_id: row.imageId, name: row.name, holders: holders.map((holder: any) => holder.machineId), default_reset_to: defaultReset ? BUILT_IN_IMAGE : null };
} });

/**
 * The calling machine's holding of an image, as its connector reports it: started, progressing, ready or failed. A
 * `ready` report may carry what only the finished image knows, which the record keeps: its size, and for a macOS base
 * built from an IPSW, the oldest macOS that runs it (placement needs it) and the IPSW's version. A `failed` one carries
 * why and what to try next.
 */
export const setHolder = mutationGeneric({ args: { imageId: v.string(), state: holderState, operationId: v.optional(v.string()), sizeBytes: v.optional(v.number()), minMacOS: v.optional(v.string()), ipswVersion: v.optional(v.string()), error: v.optional(holderFailure) }, handler: async (ctx, args) => {
  const { machineId, accountId } = await requireIdentity(ctx, "machine");
  const image = await byField(ctx, "images", "by_image", "imageId", args.imageId);
  if (!image || image.accountId !== accountId) return refuse("image_not_found", `no image ${args.imageId} on this account`);
  if ((args.state === "failed") !== (args.error !== undefined)) return refuse("invalid_input", "a failed holding carries its error, and only a failed one does");
  const existing = await ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", args.imageId).eq("machineId", machineId)).first();
  const holder = { state: args.state, ...(args.operationId === undefined ? {} : { operationId: args.operationId }), ...(args.error === undefined ? {} : { error: args.error }), updatedAt: Date.now() };
  // A patch without `error` clears a failure an earlier report left.
  if (existing) await ctx.db.patch(existing._id, { error: undefined, ...holder });
  else await ctx.db.insert("imageHolders", { imageId: args.imageId, accountId, machineId: machineId!, ...holder });
  if (args.state === "ready") {
    const learned = {
      ...(args.sizeBytes !== undefined && args.sizeBytes !== image.sizeBytes ? { sizeBytes: args.sizeBytes } : {}),
      ...(args.minMacOS !== undefined && args.minMacOS !== image.minMacOS ? { minMacOS: args.minMacOS } : {}),
      ...(args.ipswVersion !== undefined && image.source.kind === "ipsw" && args.ipswVersion !== image.source.ipswVersion ? { source: { ...image.source, ipswVersion: args.ipswVersion } } : {}),
    };
    if (Object.keys(learned).length) await ctx.db.patch(image._id, learned);
  }
  return { image_id: args.imageId, machine_id: machineId, state: args.state };
} });

/**
 * The calling machine's holdings, for its daemon's image mirror: every image the account lists on it, with the
 * holding's state so a change (building to ready) reaches the mirror too.
 */
export const forMachine = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const rows = await ctx.db.query("imageHolders").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)).take(HOLDER_BATCH);
  return rows.map((row: any) => ({ image_id: row.imageId, state: row.state })).sort((a: any, b: any) => a.image_id.localeCompare(b.image_id));
} });

/** One machine stops holding an image (`image delete --machine`, or a copy that failed); the image record stays. */
export const dropHolder = mutationGeneric({ args: { image: v.string(), machineId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const row = await resolve(ctx, accountId, args.image);
  if (!row) return refuse("invalid_input", "linux is on every machine and can't be dropped from one");
  const holder = await ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", row.imageId).eq("machineId", args.machineId)).first();
  if (holder) await ctx.db.delete(holder._id);
  return { image_id: row.imageId, name: row.name, machine_id: args.machineId, dropped: holder !== null };
} });

/**
 * A removed machine's holder rows go with it, a bounded batch at a time (a larger set continues in a scheduled run);
 * the images themselves stay, listed with whatever holders remain. Returns how many rows this run deleted.
 */
export async function dropMachineHolders(ctx: any, machineId: string): Promise<number> {
  const rows = await ctx.db.query("imageHolders").withIndex("by_machine", (q: any) => q.eq("machineId", machineId)).take(HOLDER_BATCH);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length === HOLDER_BATCH) await ctx.scheduler.runAfter(0, makeFunctionReference<"mutation">("images:dropRevokedHolders") as any, { machineId });
  return rows.length;
}
export const dropRevokedHolders = internalMutationGeneric({ args: { machineId: v.string() }, handler: async (ctx, args) => ({ deleted: await dropMachineHolders(ctx, args.machineId) }) });

// Copies. A copy moves an image's files directly from a Mac holding it to another (Q4, Q5): the relay starts it
// (`startCopy`), each Mac's connector meets the other at the row (`copiesForMachine`, `offerCandidates`) and reports
// how its side ended (`endCopy`), and the target's holder row follows. The transfer key is in the row, readable only
// by the copy's two machines; agents and every other machine see the copy without it.

const holderRow = async (ctx: any, imageId: string, machineId: string) => await ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", imageId).eq("machineId", machineId)).first();
const copyByMutation = async (ctx: any, accountId: string, createMutationId: string) => await ctx.db.query("copies").withIndex("by_account_mutation", (q: any) => q.eq("accountId", accountId).eq("createMutationId", createMutationId)).first();
const live = (copy: any) => copy.expiresAt > Date.now();
const transferKey = () => { const bytes = crypto.getRandomValues(new Uint8Array(32)); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };

/** A copy as the account sees it: everything but the key. */
const copyView = (copy: any, machines: Map<string, string>) => ({
  copy_id: copy.copyId, image_id: copy.imageId, operation_id: copy.createMutationId, state: copy.state,
  from_machine_id: copy.fromMachineId, from_machine_name: machines.get(copy.fromMachineId) ?? null, to_machine_id: copy.toMachineId, to_machine_name: machines.get(copy.toMachineId) ?? null,
  result: copy.result ? { bytes: copy.result.bytes, duration_ms: copy.result.durationMs, path: copy.result.path } : null,
  error: copy.error ? { code: copy.error.code, message: copy.error.message, next_step: copy.error.nextStep } : null, created_at: copy.createdAt, expires_at: copy.expiresAt,
});

/** Sets the target's holding as the copy left it; the copy's own machine reports it, or the account when it expires. */
async function setTargetHolder(ctx: any, copy: any, fields: { state: "copying" | "ready" | "failed"; error?: any }) {
  const existing = await holderRow(ctx, copy.imageId, copy.toMachineId);
  const holder = { state: fields.state, operationId: copy.createMutationId, ...(fields.error ? { error: fields.error } : {}), updatedAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, { error: undefined, ...holder });
  else await ctx.db.insert("imageHolders", { imageId: copy.imageId, accountId: copy.accountId, machineId: copy.toMachineId, ...holder });
}

/**
 * Starts copying an image (an id) from `fromMachineId`, which holds it ready, to `toMachineId`: the copy's row with a
 * fresh key, and the target's holder row `copying` under the copy's mutation id. A start carrying a mutation id this
 * account already started a copy with returns that copy. A target that holds the image, or is building or copying it
 * under another operation, is refused; with `join` (a sandbox create that needs the image there), a copy already
 * running to it is returned instead, so the create follows that one.
 */
export const startCopy = mutationGeneric({ args: { image: v.string(), fromMachineId: v.string(), toMachineId: v.string(), createMutationId: v.string(), join: v.optional(v.boolean()) }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const machines = await machineNames(ctx, accountId);
  const started = await copyByMutation(ctx, accountId, args.createMutationId);
  if (started) return copyView(started, machines);
  const row = await resolve(ctx, accountId, args.image);
  if (!row) return refuse("invalid_input", "linux is on every Mac from its own release, so it is never copied");
  if (args.fromMachineId === args.toMachineId) return refuse("invalid_input", "a copy goes from one machine to another");
  for (const machineId of [args.fromMachineId, args.toMachineId]) if (!machines.has(machineId)) return refuse("machine_not_found", `no machine ${machineId} on this account`);
  const source = await holderRow(ctx, row.imageId, args.fromMachineId);
  if (source?.state !== "ready") return refuse("image_not_found", `${machines.get(args.fromMachineId)} does not hold ${row.name} ready, so it can't be copied from there`);
  const target = await holderRow(ctx, row.imageId, args.toMachineId);
  const toName = machines.get(args.toMachineId);
  if (target?.state === "ready") return refuse("conflict", `${toName} already holds ${row.name}`);
  if (target?.state === "building") return refuse("conflict", `${toName} is still building ${row.name}`);
  if (target?.state === "copying") {
    const running = target.operationId === undefined ? null : await copyByMutation(ctx, accountId, target.operationId);
    if (running && live(running) && (running.state === "waiting" || running.state === "copying")) return args.join ? copyView(running, machines) : refuse("conflict", `${row.name} is already being copied to ${toName}; follow it with: localbox image wait ${row.name}`, { operation_id: target.operationId });
  }
  const now = Date.now();
  const copy = { copyId: id("copy"), accountId, imageId: row.imageId, fromMachineId: args.fromMachineId, toMachineId: args.toMachineId, key: transferKey(), candidates: {}, state: "waiting" as const, createdAt: now, expiresAt: now + COPY_TTL_MS, createMutationId: args.createMutationId };
  await ctx.db.insert("copies", copy);
  await setTargetHolder(ctx, copy, { state: "copying" });
  return copyView(copy, machines);
} });

/** The account's copy started under this mutation id (the operation both Macs journal it under), without its key; null when there is none. */
export const copyByOperation = queryGeneric({ args: { operationId: v.string() }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const copy = await copyByMutation(ctx, accountId, args.operationId);
  return copy && live(copy) ? copyView(copy, await machineNames(ctx, accountId)) : null;
} });

/**
 * The calling machine's copies, newest first, with what its side needs: its role, the key, the image's size, the peer's
 * candidates and the copy's state. Its connector subscribes and hands each change to its daemon.
 */
export const copiesForMachine = queryGeneric({ args: {}, handler: async (ctx) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const sides = [["sender", "by_from", "fromMachineId"], ["receiver", "by_to", "toMachineId"]] as const;
  const rows: any[] = [];
  for (const [role, index, field] of sides) {
    for (const copy of await ctx.db.query("copies").withIndex(index, (q: any) => q.eq(field, machineId)).order("desc").take(COPY_BATCH)) {
      if (!live(copy)) continue;
      const image = await byField(ctx, "images", "by_image", "imageId", copy.imageId);
      const own = role === "sender" ? copy.candidates.from : copy.candidates.to; const peer = role === "sender" ? copy.candidates.to : copy.candidates.from;
      rows.push({
        copy_id: copy.copyId, operation_id: copy.createMutationId, image_id: copy.imageId, role, key: copy.key, size_bytes: image?.sizeBytes ?? null, state: copy.state,
        candidates: own ?? null, peer_candidates: peer ?? null, error: copy.error ? { code: copy.error.code, message: copy.error.message, next_step: copy.error.nextStep } : null,
      });
    }
  }
  return rows.sort((a, b) => a.copy_id.localeCompare(b.copy_id));
} });

/** The calling machine's own side of a copy, or a refusal when it is neither end; an expired copy takes nothing. */
async function ownCopy(ctx: any, copy: any, machineId: string): Promise<"sender" | "receiver"> {
  if (copy?.fromMachineId === machineId) return "sender";
  if (copy?.toMachineId === machineId) return "receiver";
  return refuse("image_not_found", "no such copy for this machine");
}

/**
 * Publishes where the calling end of a copy can be reached, replacing what it published before (a restarted end
 * gathers new ones). Once both ends have, the copy is `copying`.
 */
export const offerCandidates = mutationGeneric({ args: { copyId: v.string(), candidates: v.array(copyCandidate) }, handler: async (ctx, args) => {
  const { machineId } = await requireIdentity(ctx, "machine");
  const copy = await byField(ctx, "copies", "by_copy", "copyId", args.copyId);
  const role = await ownCopy(ctx, copy, machineId!);
  if (args.candidates.length > MAX_CANDIDATES) return refuse("invalid_input", `a copy end publishes at most ${MAX_CANDIDATES} candidates`);
  if (!live(copy)) return { copy_id: copy.copyId, state: copy.state, expired: true };
  const candidates = { ...copy.candidates, [role === "sender" ? "from" : "to"]: args.candidates };
  const state = copy.state === "waiting" && candidates.from && candidates.to ? "copying" : copy.state;
  await ctx.db.patch(copy._id, { candidates, state });
  return { copy_id: copy.copyId, state, expired: false };
} });

/**
 * How the calling end's side of a copy ended, as its connector reports the finished operation. The receiver's outcome
 * is the copy's: copied (its holding `ready`, with the image's size) or failed (its holding `failed`, with why). A
 * sender that failed fails the copy, so the receiver stops waiting; the receiver reports its own holding. A copy that
 * expired or whose image was deleted has nothing left to report.
 */
export const endCopy = mutationGeneric({ args: { operationId: v.string(), state: v.union(v.literal("succeeded"), v.literal("failed")), sizeBytes: v.optional(v.number()), result: v.optional(copyResult), error: v.optional(holderFailure) }, handler: async (ctx, args) => {
  const { machineId, accountId } = await requireIdentity(ctx, "machine");
  if ((args.state === "failed") !== (args.error !== undefined)) return refuse("invalid_input", "a failed copy carries its error, and only a failed one does");
  const copy = await copyByMutation(ctx, accountId!, args.operationId);
  if (!copy || !live(copy)) return { operation_id: args.operationId, reported: false };
  const role = await ownCopy(ctx, copy, machineId!);
  if (role === "sender") {
    if (args.state === "failed" && copy.state !== "copied" && copy.state !== "failed") await ctx.db.patch(copy._id, { state: "failed", error: args.error });
    return { operation_id: args.operationId, reported: true, state: args.state === "failed" ? "failed" : copy.state };
  }
  if (args.state === "succeeded") {
    await ctx.db.patch(copy._id, { state: "copied", error: undefined, ...(args.result ? { result: args.result } : {}) });
    await setTargetHolder(ctx, copy, { state: "ready" });
    const image = await byField(ctx, "images", "by_image", "imageId", copy.imageId);
    if (image && args.sizeBytes !== undefined && image.sizeBytes === undefined) await ctx.db.patch(image._id, { sizeBytes: args.sizeBytes });
    return { operation_id: args.operationId, reported: true, state: "copied" };
  }
  // The first failure names the copy's cause (a sender that gave up, say); the receiver's holding carries its own.
  if (copy.state !== "failed") await ctx.db.patch(copy._id, { state: "failed", error: args.error });
  await setTargetHolder(ctx, copy, { state: "failed", error: args.error });
  return { operation_id: args.operationId, reported: true, state: "failed" };
} });

/**
 * A copy that never started on its two Macs (one didn't take the request): the copy fails with why, and the target's
 * holding, which nothing was written to, goes.
 */
export const cancelCopy = mutationGeneric({ args: { copyId: v.string(), error: holderFailure }, handler: async (ctx, args) => {
  const { accountId } = await requireAccount(ctx);
  const copy = await byField(ctx, "copies", "by_copy", "copyId", args.copyId);
  if (!copy || copy.accountId !== accountId) return refuse("image_not_found", `no copy ${args.copyId} on this account`);
  if (copy.state === "copied") return { copy_id: copy.copyId, cancelled: false };
  await ctx.db.patch(copy._id, { state: "failed", error: args.error });
  const target = await holderRow(ctx, copy.imageId, copy.toMachineId);
  if (target?.state === "copying" && target.operationId === copy.createMutationId) await ctx.db.delete(target._id);
  return { copy_id: copy.copyId, cancelled: true };
} });

/**
 * Copies past their day: each row and its key go, and a target still copying then has failed. The daily cleanup
 * (`relay:cleanupExpired`) runs it a bounded batch at a time; until then every function already treats the row as gone.
 * Returns how many rows it deleted.
 */
export async function expireCopies(ctx: any, now: number, batch: number): Promise<number> {
  const rows = await ctx.db.query("copies").withIndex("by_expires", (q: any) => q.lt("expiresAt", now)).take(batch);
  for (const copy of rows) {
    const target = await holderRow(ctx, copy.imageId, copy.toMachineId);
    if (target?.state === "copying" && target.operationId === copy.createMutationId) {
      await setTargetHolder(ctx, copy, { state: "failed", error: { code: "copy_unreachable", message: "the copy did not finish within a day", nextStep: "put both Macs on the same network once, then copy" } });
    }
    await ctx.db.delete(copy._id);
  }
  return rows.length;
}

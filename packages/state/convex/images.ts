import { internalMutationGeneric, makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireAccount, requireIdentity } from "./lib/identity.js";
import { boundedRows, byField, id, liveMachines, refuse } from "./lib/relay.js";
import { holderState, imageOs, imageSource } from "./schema.js";
import { sandboxName, validateLabel } from "../../names/src/index.js";

// The account's images, the machines holding each, and the account default.

/**
 * The built-in image, never a row: every Mac has the build its release shipped, so `list` synthesizes it with every
 * live machine as a ready holder, and holder rows for it could only drift.
 */
const LINUX_IMAGE = "linux";
/** Reserved for the account's macOS base: it resolves to the most recent image built from an IPSW. */
const MACOS_IMAGE = "macos";
const NAME_ATTEMPTS = 20;
const HOLDER_BATCH = 200;

const accountImages = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("images").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId)), "image list");
const accountHolders = async (ctx: any, accountId: string) => await boundedRows(ctx.db.query("imageHolders").withIndex("by_account", (q: any) => q.eq("accountId", accountId)), "image holders");
const imageHolders = async (ctx: any, imageId: string) => await boundedRows(ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", imageId)), "image holders");
const named = async (ctx: any, accountId: string, name: string) => await ctx.db.query("images").withIndex("by_account_name", (q: any) => q.eq("accountId", accountId).eq("name", name)).first();
const account = async (ctx: any, accountId: string) => await byField(ctx, "accounts", "by_account", "accountId", accountId);
const machineNames = async (ctx: any, accountId: string) => new Map<string, string>((await liveMachines(ctx, accountId)).map((row: any) => [row.machineId, row.name]));

/** A name the caller chose: a valid label, neither built-in name, and free on the account. */
async function freeName(ctx: any, accountId: string, name: string): Promise<string> {
  validateLabel(name);
  if (name === LINUX_IMAGE || name === MACOS_IMAGE) refuse("invalid_input", `${name} is a built-in image name; choose another`);
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
  if (wanted === LINUX_IMAGE) return undefined;
  const rows = await accountImages(ctx, accountId);
  if (wanted === MACOS_IMAGE) {
    const base = rows.filter((row: any) => row.source.kind === "ipsw").sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
    return base ?? refuse("image_not_found", "no macOS image yet; build one with: localbox image create --macos");
  }
  const row = rows.find((candidate: any) => candidate.imageId === wanted) ?? rows.find((candidate: any) => candidate.name === wanted);
  if (row) return row;
  const names = [LINUX_IMAGE, ...rows.map((candidate: any) => candidate.name).sort()];
  return refuse("image_not_found", `no image ${wanted} on this account; images: ${names.join(", ")}`, { names });
}

const holderView = (row: any, machines: Map<string, string>) => ({ machine_id: row.machineId, machine_name: machines.get(row.machineId) ?? null, state: row.state, updated_at: row.updatedAt });
const view = (row: any, holders: any[], machines: Map<string, string>, defaultImageId: string | undefined) => ({
  image_id: row.imageId, name: row.name, os: row.os, size_bytes: row.sizeBytes ?? null, source: row.source, min_macos: row.minMacOS ?? null,
  created_at: row.createdAt, default: row.imageId === defaultImageId, holders: holders.map((holder) => holderView(holder, machines)),
});

/** Every image on the account, `linux` first; an image whose holders are all gone stays listed with `holders: []`. */
export const list = queryGeneric({ args: {}, handler: async (ctx) => {
  const { accountId } = await requireAccount(ctx);
  const live = await liveMachines(ctx, accountId);
  const machines = new Map<string, string>(live.map((row: any) => [row.machineId, row.name]));
  const defaultImageId = (await account(ctx, accountId))?.defaultImageId;
  const holders = await accountHolders(ctx, accountId);
  const linux = {
    image_id: LINUX_IMAGE, name: LINUX_IMAGE, os: "linux", size_bytes: null, source: { kind: "release" }, min_macos: null, created_at: null,
    default: defaultImageId === undefined, holders: live.map((row: any) => ({ machine_id: row.machineId, machine_name: row.name, state: "ready", updated_at: null })),
  };
  const images = (await accountImages(ctx, accountId)).sort((a: any, b: any) => a.createdAt - b.createdAt);
  return [linux, ...images.map((row: any) => view(row, holders.filter((holder: any) => holder.imageId === row.imageId), machines, defaultImageId))];
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
  return { image_id: row?.imageId ?? LINUX_IMAGE, name: row?.name ?? LINUX_IMAGE };
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
  await ctx.db.delete(row._id);
  const owner = await account(ctx, accountId);
  const defaultReset = owner?.defaultImageId === row.imageId;
  if (defaultReset) await ctx.db.patch(owner._id, { defaultImageId: undefined });
  return { image_id: row.imageId, name: row.name, holders: holders.map((holder: any) => holder.machineId), default_reset_to: defaultReset ? LINUX_IMAGE : null };
} });

/**
 * The calling machine's holding of an image, as its connector reports it: started, progressing, ready or failed. A
 * `ready` report may carry the image's size, which the record keeps.
 */
export const setHolder = mutationGeneric({ args: { imageId: v.string(), state: holderState, operationId: v.optional(v.string()), sizeBytes: v.optional(v.number()) }, handler: async (ctx, args) => {
  const { machineId, accountId } = await requireIdentity(ctx, "machine");
  const image = await byField(ctx, "images", "by_image", "imageId", args.imageId);
  if (!image || image.accountId !== accountId) return refuse("image_not_found", `no image ${args.imageId} on this account`);
  const existing = await ctx.db.query("imageHolders").withIndex("by_image_machine", (q: any) => q.eq("imageId", args.imageId).eq("machineId", machineId)).first();
  const holder = { state: args.state, ...(args.operationId === undefined ? {} : { operationId: args.operationId }), updatedAt: Date.now() };
  if (existing) await ctx.db.patch(existing._id, holder);
  else await ctx.db.insert("imageHolders", { imageId: args.imageId, accountId, machineId: machineId!, ...holder });
  if (args.state === "ready" && args.sizeBytes !== undefined && args.sizeBytes !== image.sizeBytes) await ctx.db.patch(image._id, { sizeBytes: args.sizeBytes });
  return { image_id: args.imageId, machine_id: machineId, state: args.state };
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

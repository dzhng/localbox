import { ConvexError } from "convex/values";

const accountAdjectives = ["brave", "calm", "clever", "kind", "quick", "steady", "bright", "quiet"];
const animals = ["walrus", "otter", "badger", "panda", "raven", "fox", "heron", "beaver"];
const sandboxAdjectives = [...accountAdjectives, "amber", "bold", "brisk", "cosmic", "dapper", "eager", "fuzzy", "gentle", "humble", "jolly", "lucky", "mellow", "nimble", "plucky", "rapid", "sunny", "tidy", "witty", "zesty", "swift"];
const sandboxAnimals = [...animals, "lynx", "moose", "newt", "ocelot", "puffin", "quokka", "robin", "seal", "tapir", "wombat", "yak", "zebra", "gecko", "ibis", "koala", "lemur", "marmot", "narwhal", "orca", "pika"];

/** A sandbox, machine or account name; Convex refuses any other as `invalid_input`. */
export function validateLabel(value: string): string {
  if (!/^[a-z0-9-]{3,40}$/.test(value)) throw new ConvexError({ code: "invalid_input", message: `a name must be 3–40 lowercase letters, digits, or hyphens, not ${JSON.stringify(value)}` });
  return value;
}
export function accountName(random: () => number = Math.random): string {
  return `${accountAdjectives[Math.floor(random() * accountAdjectives.length)]}-${animals[Math.floor(random() * animals.length)]}-${Math.floor(random() * 900) + 100}`;
}
export function sandboxName(random: () => number = Math.random): string {
  return `${sandboxAdjectives[Math.floor(random() * sandboxAdjectives.length)]}-${sandboxAnimals[Math.floor(random() * sandboxAnimals.length)]}`;
}
export function machineName(hostname: string): string {
  const base = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return validateLabel(base.length >= 3 ? base : "machine");
}

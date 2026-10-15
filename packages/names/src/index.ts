const accountAdjectives = ["brave", "calm", "clever", "kind", "quick", "steady", "bright", "quiet"];
const animals = ["walrus", "otter", "badger", "panda", "raven", "fox", "heron", "beaver"];

export function validateLabel(value: string): string {
  if (!/^[a-z0-9-]{3,40}$/.test(value)) throw new Error("label must be 3–40 lowercase letters, digits, or hyphens");
  return value;
}
export function accountName(random: () => number = Math.random): string {
  return `${accountAdjectives[Math.floor(random() * accountAdjectives.length)]}-${animals[Math.floor(random() * animals.length)]}-${Math.floor(random() * 900) + 100}`;
}
export function sandboxName(random: () => number = Math.random): string {
  return `${animals[Math.floor(random() * animals.length)]}-${animals[Math.floor(random() * animals.length)]}`;
}
export function machineName(hostname: string): string {
  const base = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return validateLabel(base.length >= 3 ? base : "machine");
}

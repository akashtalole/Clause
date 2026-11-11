// Tiny JSON-file store. Good enough for a demo; swap for a DB in production.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

const FILE = process.env.CLAUSE_DB || path.resolve("data/pacts.json");
const pacts = new Map();
export const events = new EventEmitter();
events.setMaxListeners(100);

try {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  for (const p of raw) pacts.set(p.id, p);
} catch {
  /* first run */
}

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify([...pacts.values()], null, 2));
    fs.renameSync(tmp, FILE);
  }, 50);
}

export function list() {
  return [...pacts.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function get(id) {
  return pacts.get(id);
}
export function save(pact) {
  pact.updatedAt = new Date().toISOString();
  pacts.set(pact.id, pact);
  persist();
  events.emit("change", pact);
  return pact;
}
export function remove(id) {
  pacts.delete(id);
  persist();
}

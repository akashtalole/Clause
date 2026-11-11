// Tamper-evident audit trail.
// Every pact event is hashed together with the previous event's hash (a hash chain), and every
// deliverable gets a SHA-256 fingerprint at submission. Editing, reordering or deleting any past
// event breaks the chain, and verify() pinpoints where. Receipts combine the fingerprint, the
// verdict digest and the PayPal capture id, which anyone can cross-check in PayPal.
import crypto from "node:crypto";

export const GENESIS = "0".repeat(64);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so the same data always hashes the same. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(",")}}`;
}

const eventCore = (e) => ({ at: e.at, actor: e.actor, type: e.type, message: e.message, data: e.data });
export const eventHash = (prevHash, e) => sha256(`${prevHash}|${canonical(eventCore(e))}`);

/** Append-time: link the new event to the chain. */
export function seal(events, e) {
  const prev = [...events].reverse().find((x) => x.hash)?.hash || GENESIS;
  e.prevHash = prev;
  e.hash = eventHash(prev, e);
  return e;
}

/** Recompute the chain. Events recorded before hashing existed are reported, not counted. */
export function verify(events) {
  let prev = GENESIS;
  let checked = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e.hash) continue;
    if (e.prevHash !== prev) return { valid: false, checked, brokenAt: i, reason: "link to previous event does not match" };
    if (eventHash(prev, e) !== e.hash) return { valid: false, checked, brokenAt: i, reason: "event content was modified" };
    prev = e.hash;
    checked++;
  }
  return { valid: true, checked, head: prev, unsealed: events.filter((e) => !e.hash).length };
}

export function digestSubmission(sub) {
  return sha256(canonical({ text: sub.text || "", links: sub.links || [], images: (sub.images || []).map((i) => sha256(i.data || "")) }));
}

export function digestVerdict(v) {
  return v ? sha256(canonical({ decision: v.decision, confidence: v.confidence, criteria: v.criteria.map((c) => ({ id: c.criterion_id, result: c.result })), red_flags: v.red_flags })) : null;
}

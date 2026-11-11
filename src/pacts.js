// Pact lifecycle + the spend gate.
// Principle: "AI proposes, code disposes." Claude produces verdicts; only this deterministic policy moves money.
import crypto from "node:crypto";
import * as store from "./store.js";
import * as paypal from "./paypal.js";
import * as ai from "./jobs.js";
import * as audit from "./audit.js";

const MIN_CONFIDENCE = Number(process.env.AUTO_RELEASE_MIN_CONFIDENCE || 0.75);
const round2 = (n) => Math.round(n * 100) / 100;
const now = () => new Date().toISOString();
const id = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;

export class PactError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Serialize mutations per pact so two clicks can never double-capture.
const locks = new Map();
function withLock(pactId, fn) {
  const prev = locks.get(pactId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(pactId, next.catch(() => {}));
  return next;
}

function mustGet(pactId) {
  const p = store.get(pactId);
  if (!p) throw new PactError("Pact not found", 404);
  return p;
}

function log(p, actor, type, message, data) {
  p.events.push(audit.seal(p.events, { at: now(), actor, type, message, ...(data ? { data } : {}) }));
}
function trace(p, t) {
  if (t) p.aiTraces.push({ at: now(), ...t });
}

// ------------------------------------------------------------------ derived state
export function view(p) {
  const captured = round2(p.ledger.filter((l) => l.kind === "capture").reduce((s, l) => s + l.amount, 0));
  const refunded = round2(p.ledger.filter((l) => l.kind === "refund").reduce((s, l) => s + l.amount, 0));
  const forfeited = round2(p.milestones.reduce((s, m) => s + (m.settlement ? m.amount - m.settlement.amount : 0), 0));
  const authOpen = p.paypal.authorizationId && !["VOIDED", "CAPTURED", "EXPIRED"].includes(p.paypal.authStatus);
  const held = authOpen ? round2(p.total - captured - forfeited) : 0;
  const current = p.milestones.find((m) => !isSettled(m));
  return {
    ...p,
    schedule: computeSchedule(p),
    audit: audit.verify(p.events),
    money: { total: p.total, held, released: round2(captured - refunded), captured, refunded, returned: round2(p.total - captured + refunded - held) },
    currentMilestoneId: current?.id || null,
    policy: { minConfidence: MIN_CONFIDENCE },
  };
}

// ------------------------------------------------------------------ schedule (drives the Bryntum Gantt)
// Contract deadlines come from the pact (days after funding). The forecast is recomputed from what
// actually happened: settled milestones end when they were settled, every revision the arbiter
// requests adds a buffer, and everything downstream shifts. Milestones forecast past their
// contractual deadline are flagged "at risk" on both the Gantt and the timeline.
export const REVISION_BUFFER_DAYS = Number(process.env.REVISION_BUFFER_DAYS || 2);
const DAY = 86_400_000;

export function computeSchedule(p, at = Date.now()) {
  const funded = Boolean(p.fundedAt);
  const base = new Date(p.fundedAt || at).getTime();
  let cursor = base;
  let prevDue = 0;
  return p.milestones.map((m) => {
    const plannedDays = Math.max(1, m.due_in_days - prevDue);
    prevDue = Math.max(prevDue, m.due_in_days);
    const revisions = m.submissions.filter((s) => s.verdict && s.verdict.decision !== "release").length;
    const start = cursor;
    let end;
    if (m.settlement?.at) end = Math.max(start + DAY / 24, new Date(m.settlement.at).getTime());
    else if (m.status === "voided") end = start + DAY / 24;
    else {
      end = start + (plannedDays + revisions * REVISION_BUFFER_DAYS) * DAY;
      // Work in progress can never be forecast to finish in the past.
      if (funded && end < at) end = at + DAY / 2;
    }
    cursor = end;
    const deadline = base + m.due_in_days * DAY;
    const done = ["released", "settled", "refunded"].includes(m.status);
    return {
      milestoneId: m.id,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      deadline: new Date(deadline).toISOString(),
      plannedDays,
      revisions,
      slipDays: Math.round(((end - deadline) / DAY) * 10) / 10,
      atRisk: !done && m.status !== "voided" && end > deadline,
      projected: !funded,
    };
  });
}

const isSettled = (m) => ["released", "settled", "voided", "refunded"].includes(m.status);

// ------------------------------------------------------------------ create / draft
export async function draftFromText(text) {
  if (!text || text.trim().length < 15) throw new PactError("Describe the deal in a sentence or two.");
  return ai.compilePact(text.trim().slice(0, 6000));
}

export function createPact(draft, { trace: t, sellerKind = "human" } = {}) {
  if (!draft?.milestones?.length) throw new PactError("A pact needs at least one milestone.");
  const milestones = draft.milestones.slice(0, 5).map((m, i) => ({
    id: id("ms"),
    index: i,
    title: String(m.title || `Milestone ${i + 1}`).slice(0, 120),
    description: String(m.description || "").slice(0, 1000),
    amount: round2(Number(m.amount)),
    due_in_days: Number(m.due_in_days) || 7,
    criteria: (m.criteria || []).filter((c) => c?.text?.trim()).map((c, j) => ({ id: c.id || `c${j + 1}`, text: String(c.text).slice(0, 400) })),
    status: "pending",
    submissions: [],
    settlement: null,
    disputes: [],
  }));
  for (const m of milestones) {
    if (!(m.amount > 0)) throw new PactError(`Milestone "${m.title}" needs a positive amount.`);
    if (!m.criteria.length) throw new PactError(`Milestone "${m.title}" needs at least one acceptance criterion.`);
  }
  const total = round2(milestones.reduce((s, m) => s + m.amount, 0));
  if (total > 10000) throw new PactError("Sandbox demo limit is 10,000 per pact.");
  const p = {
    id: id("pact"),
    title: String(draft.title || "Untitled pact").slice(0, 80),
    summary: String(draft.summary || "").slice(0, 600),
    currency: String(draft.currency || "USD").toUpperCase(),
    total,
    buyer: { name: draft.buyer_name || "Buyer" },
    seller: { name: draft.seller_name || "Seller", kind: sellerKind === "agent" ? "agent" : "human" },
    sourceText: draft.source_text || "",
    riskNotes: draft.risk_notes || [],
    clarifyingQuestions: draft.clarifying_questions || [],
    status: "awaiting_funding",
    milestones,
    paypal: { orderId: null, authorizationId: null, authStatus: null, expirationTime: null, payer: null },
    ledger: [],
    events: [],
    aiTraces: [],
    fundingAttempt: 0,
    createdAt: now(),
  };
  trace(p, t);
  log(p, "system", "created", `Pact compiled: ${milestones.length} milestone(s), ${total.toFixed(2)} ${p.currency}.`);
  store.save(p);
  return view(p);
}

// ------------------------------------------------------------------ funding (PayPal hold)
export function startFunding(pactId, { baseUrl }) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (p.status !== "awaiting_funding") throw new PactError("This pact is already funded.");
    p.fundingAttempt += 1;
    const returnUrl = `${baseUrl}/paypal/return?pact=${p.id}`;
    const order = await paypal.createEscrowOrder(p, { returnUrl, cancelUrl: `${baseUrl}/#/pact/${p.id}` });
    p.paypal.orderId = order.orderId;
    log(p, "paypal", "order_created", `PayPal order ${order.orderId} created (intent AUTHORIZE).`);
    store.save(p);
    return order;
  });
}

export function completeFunding(pactId, orderId) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (p.status !== "awaiting_funding") return view(p); // idempotent (popup + redirect may both land)
    if (orderId && p.paypal.orderId && orderId !== p.paypal.orderId) throw new PactError("Order does not belong to this pact.");
    const auth = await paypal.authorizeOrder(p.paypal.orderId || orderId);
    Object.assign(p.paypal, { authorizationId: auth.authorizationId, authStatus: auth.status, expirationTime: auth.expirationTime, payer: auth.payer });
    p.status = "active";
    p.fundedAt = now();
    p.ledger.push({ at: now(), kind: "hold", amount: p.total, paypalId: auth.authorizationId, status: auth.status });
    log(p, "paypal", "funded", `${p.total.toFixed(2)} ${p.currency} held on buyer's PayPal (authorization ${auth.authorizationId}). Nothing is charged until work is verified.`, { paypalId: auth.authorizationId, amount: p.total });
    store.save(p);
    return view(p);
  });
}

// ------------------------------------------------------------------ deliverables + arbiter
function currentMilestone(p, milestoneId) {
  const m = p.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new PactError("Milestone not found", 404);
  const current = p.milestones.find((x) => !isSettled(x));
  if (current?.id !== m.id) throw new PactError("Milestones are delivered in order; this one is not open yet.");
  return m;
}

export function submitDeliverable(pactId, milestoneId, { text, images = [], links = [], by = "seller" }) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (p.status !== "active") throw new PactError("Fund the pact before submitting work.");
    const m = currentMilestone(p, milestoneId);
    if (m.status === "reviewing") throw new PactError("A review is already in progress.");
    if (!text?.trim() && !images.length) throw new PactError("Submit text, an image, or both.");
    const sub = { id: id("sub"), at: now(), by, text: (text || "").slice(0, 20000), links, images, verdict: null };
    sub.digest = audit.digestSubmission(sub);
    m.submissions.push(sub);
    m.status = "reviewing";
    log(p, by === "agent" ? "seller-agent" : "seller", "submitted", `Deliverable submitted for "${m.title}" (attempt ${m.submissions.length}).`, { milestoneId: m.id, digest: sub.digest });
    store.save(p);

    let result;
    try {
      result = await ai.arbitrate({ pact: p, milestone: m, submission: sub });
    } catch (err) {
      m.status = "pending";
      log(p, "arbiter", "error", `Review failed: ${err.message}`);
      store.save(p);
      throw err;
    }
    sub.verdict = result.verdict;
    sub.verdictDigest = audit.digestVerdict(result.verdict);
    trace(p, result.trace);
    const v = result.verdict;
    const met = v.criteria.filter((c) => c.result === "met").length;
    log(p, "arbiter", "verdict", `Arbiter: ${v.decision.replace("_", " ")} — ${met}/${v.criteria.length} criteria met, confidence ${(v.confidence * 100).toFixed(0)}%.`, { milestoneId: m.id, verdictDigest: sub.verdictDigest });

    const gate = spendGate(p, m, v);
    sub.gate = gate;
    if (gate.autoRelease) {
      await settle(p, m, 100, "Arbiter verified all acceptance criteria");
    } else {
      m.status = v.decision === "request_revision" ? "revision_requested" : "escalated";
      log(p, "policy", "held", `Funds stay held: ${gate.reasons.join("; ")}.`);
      if (m.status === "revision_requested") {
        const sched = computeSchedule(p).find((x) => x.milestoneId === m.id);
        const downstream = p.milestones.filter((x) => x.index > m.index && !isSettled(x)).length;
        log(
          p,
          "scheduler",
          "rescheduled",
          `Revision buffer +${REVISION_BUFFER_DAYS}d on "${m.title}"${downstream ? `; ${downstream} later milestone(s) shifted` : ""}.${sched?.atRisk ? ` Now forecast ${sched.slipDays}d past its deadline — at risk.` : ""}`
        );
      }
    }
    store.save(p);
    return view(p);
  });
}

/** Deterministic policy. The model can recommend; only this function lets money move without a human. */
export function spendGate(p, m, v) {
  const met = v.criteria.filter((c) => c.result === "met").length;
  const checks = [
    { id: "decision", label: "Arbiter recommends release", pass: v.decision === "release", detail: v.decision.replace("_", " ") },
    { id: "criteria", label: "Every criterion met", pass: met === v.criteria.length, detail: `${met}/${v.criteria.length} met` },
    { id: "confidence", label: `Confidence ≥ ${Math.round(MIN_CONFIDENCE * 100)}%`, pass: v.confidence >= MIN_CONFIDENCE, detail: `${Math.round(v.confidence * 100)}%` },
    { id: "flags", label: "No red flags", pass: !v.red_flags?.length, detail: v.red_flags?.length ? `${v.red_flags.length} flagged` : "clean" },
    { id: "hold", label: "PayPal hold is live", pass: Boolean(p.paypal.authorizationId), detail: p.paypal.authStatus || "none" },
  ];
  const reasons = checks.filter((c) => !c.pass).map((c) => `${c.label.toLowerCase()} — ${c.detail}`);
  return { autoRelease: reasons.length === 0, reasons, checks };
}

// ------------------------------------------------------------------ settlement (PayPal capture / void)
async function settle(p, m, percent, reason) {
  const amount = round2((m.amount * percent) / 100);
  const remainingAfter = p.milestones.filter((x) => x.id !== m.id && !isSettled(x));
  const isLast = remainingAfter.length === 0;
  let capture = null;
  if (amount > 0) {
    capture = await paypal.captureAuthorization(p.paypal.authorizationId, {
      amount,
      currency: p.currency,
      finalCapture: isLast,
      invoiceId: `${p.id}-${m.id}`,
      note: `Clause: milestone "${m.title}" — ${reason}`,
      idempotencyKey: `capture-${p.id}-${m.id}`,
    });
    p.ledger.push({ at: now(), kind: "capture", amount, paypalId: capture.captureId, status: capture.status, milestoneId: m.id });
    log(p, "paypal", "captured", `${amount.toFixed(2)} ${p.currency} released to ${p.seller.name} (capture ${capture.captureId}).`, { milestoneId: m.id, paypalId: capture.captureId, amount });
  }
  if (isLast) {
    if (amount === 0) {
      await paypal.voidAuthorization(p.paypal.authorizationId);
      p.ledger.push({ at: now(), kind: "void", amount: 0, paypalId: p.paypal.authorizationId, status: "VOIDED" });
      p.paypal.authStatus = "VOIDED";
    } else {
      p.paypal.authStatus = "CAPTURED";
    }
    const unspent = round2(p.total - p.ledger.filter((l) => l.kind === "capture").reduce((s, l) => s + l.amount, 0));
    if (unspent > 0) log(p, "paypal", "released_hold", `Remaining hold of ${unspent.toFixed(2)} ${p.currency} returned to the buyer.`);
    p.status = "completed";
    p.completedAt = now();
    log(p, "system", "completed", "Pact completed.");
  } else {
    p.paypal.authStatus = "PARTIALLY_CAPTURED";
  }
  m.status = percent >= 100 ? "released" : "settled";
  m.settlement = { percent, amount, reason, at: now(), captureId: capture?.captureId || null };
}

/** Buyer overrides the arbiter and approves (fully or partially). */
export function buyerRelease(pactId, milestoneId, { percent = 100 } = {}) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (p.status !== "active") throw new PactError("Pact is not active.");
    const m = currentMilestone(p, milestoneId);
    if (!m.submissions.length) throw new PactError("Nothing has been delivered yet.");
    if (m.status === "reviewing") throw new PactError("Wait for the review to finish.");
    const pct = Math.min(100, Math.max(0, Number(percent)));
    log(p, "buyer", "approved", `Buyer approved "${m.title}" at ${pct}%.`);
    await settle(p, m, pct, "Approved by buyer");
    store.save(p);
    return view(p);
  });
}

// ------------------------------------------------------------------ disputes (AI tribunal)
export function openDispute(pactId, milestoneId, { claim, response, by = "buyer" }) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    const m = p.milestones.find((x) => x.id === milestoneId);
    if (!m) throw new PactError("Milestone not found", 404);
    if (!m.submissions.length) throw new PactError("Nothing has been delivered to dispute.");
    const appeal = m.status === "released" || m.status === "settled";
    if (!appeal && p.status !== "active") throw new PactError("Pact is not active.");
    if (!appeal) currentMilestone(p, milestoneId);
    if (m.status === "refunded") throw new PactError("This milestone was already refunded.");

    log(p, by, "dispute", `${by === "buyer" ? "Buyer" : "Seller"} opened a dispute on "${m.title}"${appeal ? " (appeal of released funds)" : ""}.`);
    store.save(p);
    const { ruling, traces } = await ai.tribunal({ pact: p, milestone: m, claim, response });
    traces.forEach((t) => trace(p, t));
    const dispute = { id: id("dsp"), at: now(), by, claim, response, ruling, appeal };
    m.disputes.push(dispute);
    log(p, "tribunal", "ruling", `Tribunal awards ${ruling.award_to_seller_percent}% to the seller.`);

    if (!appeal) {
      await settle(p, m, ruling.award_to_seller_percent, `Tribunal ruling (${ruling.award_to_seller_percent}%)`);
    } else {
      // Funds were already released: refund the buyer the share the seller did not earn.
      const earned = round2((m.amount * ruling.award_to_seller_percent) / 100);
      const refundAmt = round2(m.settlement.amount - earned);
      if (refundAmt > 0 && m.settlement.captureId) {
        const r = await paypal.refundCapture(m.settlement.captureId, {
          amount: refundAmt,
          currency: p.currency,
          note: `Clause tribunal ruling on "${m.title}"`,
          idempotencyKey: `refund-${dispute.id}`,
        });
        p.ledger.push({ at: now(), kind: "refund", amount: refundAmt, paypalId: r.refundId, status: r.status, milestoneId: m.id });
        log(p, "paypal", "refunded", `${refundAmt.toFixed(2)} ${p.currency} refunded to the buyer (refund ${r.refundId}).`, { milestoneId: m.id, paypalId: r.refundId, amount: refundAmt });
        m.settlement = { ...m.settlement, refunded: refundAmt };
        m.status = earned === 0 ? "refunded" : "settled";
      } else {
        log(p, "tribunal", "upheld", "Release upheld; no refund due.");
      }
    }
    store.save(p);
    return view(p);
  });
}

// ------------------------------------------------------------------ seller agent (agent-to-agent commerce)
export function runSellerAgent(pactId, milestoneId) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (p.status !== "active") throw new PactError("Fund the pact before the agent starts work.");
    const m = currentMilestone(p, milestoneId);
    log(p, "seller-agent", "working", `AI seller agent started work on "${m.title}".`);
    store.save(p);
    const { text, trace: t } = await ai.sellerAgent({ pact: p, milestone: m });
    trace(p, t);
    store.save(p);
    return text;
  }).then((text) => submitDeliverable(pactId, milestoneId, { text, by: "agent" }));
}

// ------------------------------------------------------------------ cancel / refresh
export function cancelPact(pactId, { by = "buyer" } = {}) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (["completed", "cancelled"].includes(p.status)) throw new PactError("Pact is already closed.");
    if (p.paypal.authorizationId && !["VOIDED", "CAPTURED"].includes(p.paypal.authStatus)) {
      await paypal.voidAuthorization(p.paypal.authorizationId);
      p.paypal.authStatus = "VOIDED";
      p.ledger.push({ at: now(), kind: "void", amount: 0, paypalId: p.paypal.authorizationId, status: "VOIDED" });
      log(p, "paypal", "voided", "Remaining hold voided and returned to the buyer.");
    }
    for (const m of p.milestones) if (!isSettled(m)) m.status = "voided";
    p.status = "cancelled";
    log(p, by, "cancelled", "Pact cancelled.");
    store.save(p);
    return view(p);
  });
}

export function refreshFromPayPal(pactId) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    if (!p.paypal.authorizationId) return { pact: view(p), authorization: null };
    const a = await paypal.getAuthorization(p.paypal.authorizationId);
    p.paypal.authStatus = a.status;
    p.paypal.expirationTime = a.expiration_time;
    store.save(p);
    return { pact: view(p), authorization: { id: a.id, status: a.status, amount: a.amount, expiration_time: a.expiration_time, seller_protection: a.seller_protection?.status } };
  });
}

export function reauthorize(pactId) {
  return withLock(pactId, async () => {
    const p = mustGet(pactId);
    const v = view(p);
    if (!v.money.held) throw new PactError("Nothing is held.");
    const r = await paypal.reauthorize(p.paypal.authorizationId, { amount: v.money.held, currency: p.currency });
    p.ledger.push({ at: now(), kind: "reauthorize", amount: v.money.held, paypalId: r.authorizationId, status: r.status });
    Object.assign(p.paypal, { authorizationId: r.authorizationId, authStatus: r.status, expirationTime: r.expirationTime });
    log(p, "paypal", "reauthorized", `Hold extended (new authorization ${r.authorizationId}).`);
    store.save(p);
    return view(p);
  });
}

// ------------------------------------------------------------------ maintenance sweep (Render cron job)
// PayPal honors an authorization for 3 days (valid 29). Long-running pacts get reauthorized so the
// hold stays good; milestones past their due date are flagged on the timeline. Idempotent.
const HONOR_MS = 3 * 86_400_000;
export async function sweep({ now = Date.now() } = {}) {
  const report = { checked: 0, reauthorized: [], overdue: [], errors: [] };
  for (const p of store.list()) {
    if (p.status !== "active" || p.demo || !p.paypal.authorizationId) continue;
    report.checked += 1;
    const lastAuthAt = [...p.ledger].reverse().find((l) => l.kind === "hold" || l.kind === "reauthorize")?.at || p.fundedAt;
    if (now - new Date(lastAuthAt).getTime() > HONOR_MS) {
      try {
        await reauthorize(p.id);
        report.reauthorized.push(p.id);
      } catch (e) {
        report.errors.push({ pact: p.id, error: e.message });
      }
    }
    const fundedAt = new Date(p.fundedAt).getTime();
    for (const m of p.milestones) {
      const dueAt = fundedAt + m.due_in_days * 86_400_000;
      if (!isSettled(m) && now > dueAt && !m.overdueFlaggedAt) {
        await withLock(p.id, async () => {
          const fresh = mustGet(p.id);
          const fm = fresh.milestones.find((x) => x.id === m.id);
          if (fm.overdueFlaggedAt) return;
          fm.overdueFlaggedAt = new Date(now).toISOString();
          log(fresh, "system", "overdue", `Milestone "${fm.title}" is past its due date; funds stay held until it is delivered, approved or the pact is cancelled.`);
          store.save(fresh);
        });
        report.overdue.push(`${p.id}/${m.id}`);
      }
    }
  }
  return report;
}

// ------------------------------------------------------------------ receipts
/** A verifiable receipt for one settled milestone. */
export function receipt(pactId, milestoneId) {
  const p = mustGet(pactId);
  const m = p.milestones.find((x) => x.id === milestoneId);
  if (!m) throw new PactError("Milestone not found", 404);
  if (!m.settlement) throw new PactError("This milestone has not been settled yet.");
  const sub = m.submissions.at(-1);
  const capEvent = p.events.find((e) => e.type === "captured" && e.data?.milestoneId === m.id);
  return {
    receiptVersion: 1,
    issuedAt: now(),
    pact: { id: p.id, title: p.title, buyer: p.buyer.name, seller: `${p.seller.name} (${p.seller.kind})`, currency: p.currency, demo: Boolean(p.demo) },
    milestone: { id: m.id, title: m.title, amount: m.amount, criteria: m.criteria.map((c) => c.text) },
    deliverable: sub ? { submittedAt: sub.at, by: sub.by, sha256: sub.digest || audit.digestSubmission(sub), attempts: m.submissions.length } : null,
    verdict: sub?.verdict ? { decision: sub.verdict.decision, confidence: sub.verdict.confidence, criteria: sub.verdict.criteria.map((c) => ({ criterion: c.criterion_id, result: c.result, evidence: c.evidence })), redFlags: sub.verdict.red_flags, spendGate: sub.gate || null, sha256: sub.verdictDigest || audit.digestVerdict(sub.verdict) } : null,
    disputes: m.disputes.map((d) => ({ at: d.at, awardToSellerPercent: d.ruling?.award_to_seller_percent, rationale: d.ruling?.rationale })),
    settlement: { percent: m.settlement.percent, amount: m.settlement.amount, refunded: m.settlement.refunded || 0, settledAt: m.settlement.at, reason: m.settlement.reason },
    paypal: { authorizationId: p.paypal.authorizationId, captureId: m.settlement.captureId, environment: "sandbox" },
    chain: { eventHash: capEvent?.hash || null, ...audit.verify(p.events) },
  };
}

export const verifyPact = (pactId) => audit.verify(mustGet(pactId).events);

export const list = () => store.list().map(view);
export const get = (pid) => view(mustGet(pid));

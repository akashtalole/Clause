// Seeds clearly-labelled demo pacts so the analytics dashboard has history to show.
// Demo records are flagged `demo: true`, use DEMO- ids instead of PayPal ids, and never touch PayPal.
//   npm run seed          (add)      npm run seed -- --reset   (remove demo records first)
import "dotenv/config";
import * as store from "../src/store.js";

const reset = process.argv.includes("--reset");
if (reset) for (const p of store.list()) if (p.demo) store.remove(p.id);

let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const iso = (d) => new Date(d).toISOString();
const DAY = 86_400_000;

const DEALS = [
  ["Bakery logo design", "Human", ["Concepts", "Color version", "Final files"], 450],
  ["Menu translation EN→ES", "Human", ["First 10 items", "Remaining items"], 80],
  ["Product copy for candle shop", "AI agent", ["Descriptions", "Instagram captions"], 120],
  ["Event photography", "Human", ["Shoot", "Edited gallery"], 600],
  ["Landing page build", "Human", ["Wireframe", "Build", "Launch"], 1200],
  ["SEO meta descriptions", "AI agent", ["Batch 1", "Batch 2"], 60],
  ["Podcast show notes", "AI agent", ["Episode notes"], 45],
  ["Bookkeeping cleanup", "Human", ["Categorize", "Reconcile"], 300],
  ["Etsy listing photos", "Human", ["Shoot", "Retouch"], 220],
  ["Customer FAQ draft", "AI agent", ["Draft", "Revision"], 90],
  ["Newsletter template", "Human", ["Design", "Code"], 350],
  ["Data cleanup of CRM export", "AI agent", ["Dedupe", "Normalize"], 150],
];
const SELLERS = { Human: ["Dev Patel", "Ana Ruiz", "Kofi Mensah", "Lena Park", "Sam Okafor"], "AI agent": ["CopyBot", "TransLLM", "DataTidy agent", "NotesAgent"] };
const BUYERS = ["Rise & Crumb", "Ember & Oak", "Luna Yoga", "Northside Books", "Kai's Garage", "Bloom Florist"];

const now = Date.now();
for (let i = 0; i < 26; i++) {
  const [title, kind, phases, base] = pick(DEALS);
  const total = round2(base * (0.8 + rnd() * 0.5));
  const created = now - Math.floor(rnd() * 34 + 1) * DAY;
  const funded = created + Math.floor(rnd() * 2) * DAY + 3600_000;
  const weights = phases.map((_, j) => 1 + j * 0.3);
  const wsum = weights.reduce((a, b) => a + b, 0);
  let left = total;
  const id = `pact_demo${String(i).padStart(3, "0")}`;
  const authId = `DEMO-AUTH-${i}`;
  const ledger = [{ at: iso(funded), kind: "hold", amount: total, paypalId: authId, status: "CREATED" }];
  const outcomeRoll = rnd();
  const cancelled = outcomeRoll < 0.08;
  const milestones = phases.map((ph, j) => {
    const amount = j === phases.length - 1 ? round2(left) : round2((total * weights[j]) / wsum);
    left -= amount;
    return { id: `${id}_m${j + 1}`, index: j, title: ph, description: `${ph} for ${title.toLowerCase()}.`, amount, due_in_days: 3 * (j + 1), criteria: [{ id: "c1", text: `${ph} delivered as specified` }, { id: "c2", text: "Meets the stated format and limits" }], status: "pending", submissions: [], settlement: null, disputes: [] };
  });
  let t = funded;
  let stillOpen = false;
  for (const m of milestones) {
    if (cancelled || stillOpen || t > now) { m.status = cancelled ? "voided" : "pending"; continue; }
    const attempts = rnd() < 0.3 ? 2 : 1;
    for (let a = 0; a < attempts; a++) {
      t += Math.floor(rnd() * 2 + 1) * DAY;
      const last = a === attempts - 1;
      const injection = !last && rnd() < 0.15;
      const decision = last ? (rnd() < 0.85 ? "release" : rnd() < 0.5 ? "escalate" : "request_revision") : injection ? "escalate" : "request_revision";
      const conf = decision === "release" ? 0.78 + rnd() * 0.2 : 0.45 + rnd() * 0.3;
      const allMet = decision === "release";
      m.submissions.push({
        id: `${m.id}_s${a + 1}`, at: iso(Math.min(t, now)), by: kind === "AI agent" ? "agent" : "seller", text: "(demo)", links: [], images: [],
        verdict: { decision, confidence: round2(conf), release_percent: allMet ? 100 : 0, red_flags: injection ? ["Deliverable contains instructions addressed to the reviewer"] : [], feedback_to_seller: "", summary_for_buyer: "", criteria: [{ criterion_id: "c1", result: allMet ? "met" : "partially_met", evidence: "", reasoning: "" }, { criterion_id: "c2", result: allMet || rnd() < 0.5 ? "met" : "not_met", evidence: "", reasoning: "" }] },
        gate: { autoRelease: allMet && conf >= 0.75, reasons: [] },
      });
    }
    const v = m.submissions.at(-1).verdict;
    if (t > now - 2 * DAY && rnd() < 0.35) { m.status = v.decision === "release" ? "reviewing" : v.decision === "escalate" ? "escalated" : "revision_requested"; stillOpen = true; continue; }
    let pct = 100;
    let by = "auto";
    if (v.decision !== "release") {
      if (rnd() < 0.5) { by = "buyer"; pct = pick([100, 75, 50]); }
      else { by = "tribunal"; pct = pick([80, 60, 40, 0]); m.disputes.push({ id: `${m.id}_d`, at: iso(t), by: "buyer", ruling: { award_to_seller_percent: pct, rationale: "(demo)", findings: [], confidence: 0.7 } }); }
    }
    const amt = round2((m.amount * pct) / 100);
    if (amt > 0) ledger.push({ at: iso(t), kind: "capture", amount: amt, paypalId: `DEMO-CAP-${m.id}`, status: "COMPLETED", milestoneId: m.id });
    m.settlement = { percent: pct, amount: amt, reason: by, at: iso(t), captureId: amt ? `DEMO-CAP-${m.id}` : null };
    m.status = pct === 100 ? "released" : "settled";
    if (m.status === "released" && rnd() < 0.05) {
      const r = round2(amt * 0.5);
      ledger.push({ at: iso(t + DAY), kind: "refund", amount: r, paypalId: `DEMO-REF-${m.id}`, status: "COMPLETED", milestoneId: m.id });
      m.settlement.refunded = r;
      m.status = "settled";
    }
  }
  const allSettled = milestones.every((m) => ["released", "settled", "refunded"].includes(m.status));
  if (cancelled) ledger.push({ at: iso(funded + DAY), kind: "void", amount: 0, paypalId: authId, status: "VOIDED" });
  const p = {
    id, demo: true, title, summary: `Demo seed: ${title}.`, currency: "USD", total,
    buyer: { name: pick(BUYERS) }, seller: { name: pick(SELLERS[kind]), kind: kind === "AI agent" ? "agent" : "human" },
    sourceText: "", riskNotes: [], clarifyingQuestions: [],
    status: cancelled ? "cancelled" : allSettled ? "completed" : "active",
    milestones, ledger, events: [{ at: iso(created), actor: "system", type: "created", message: "Demo seed record (not a real PayPal transaction)." }], aiTraces: [],
    paypal: { orderId: `DEMO-ORDER-${i}`, authorizationId: authId, authStatus: cancelled ? "VOIDED" : allSettled ? "CAPTURED" : "PARTIALLY_CAPTURED", expirationTime: null, payer: null },
    fundingAttempt: 1, createdAt: iso(created), fundedAt: iso(funded),
  };
  store.save(p);
}
setTimeout(() => console.log(`Seeded ${store.list().filter((p) => p.demo).length} demo pacts (flagged demo:true, DEMO- ids, no PayPal calls).`), 120);

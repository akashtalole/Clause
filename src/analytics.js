// Flattens pacts into relational tables for the AG Studio escrow analytics dashboard.
//   pacts 1─* milestones 1─* reviews,   pacts 1─* ledger
import * as store from "./store.js";

const day = (iso) => (iso ? iso.slice(0, 10) : null);
const f = (id, name, format, description) => ({ id, name, format, ...(description ? { description } : {}) });
const money = (id, name, d) => f(id, name, "currencyFormat", d);

const FIELDS = {
  pacts: [
    f("pact_id", "Pact ID", "textFormat"), f("title", "Pact", "textFormat"), f("status", "Pact status", "textFormat", "awaiting_funding, active, completed or cancelled"),
    f("seller_type", "Seller type", "textFormat", "Human freelancer or autonomous AI agent"), f("seller", "Seller", "textFormat"), f("buyer", "Buyer", "textFormat"),
    f("created_date", "Created", "dateFormat"), f("funded_date", "Funded", "dateFormat", "Date the PayPal authorization hold was placed"),
    money("escrow_total", "Escrow total", "Amount held on PayPal when funded"), money("released", "Released to seller", "Captured minus refunded"), money("refunded", "Refunded"),
    f("milestone_count", "Milestones", "integerFormat"), f("disputes", "Disputes", "integerFormat"), f("red_flags", "Red-flagged reviews", "integerFormat", "Reviews where the arbiter flagged manipulation such as prompt injection"),
    f("data_source", "Data source", "textFormat", "Live = real sandbox pact; Demo seed = generated demo history"),
  ],
  milestones: [
    f("milestone_id", "Milestone ID", "textFormat"), f("pact_id", "Pact ID", "textFormat"), f("milestone", "Milestone", "textFormat"), f("position", "Position", "integerFormat"),
    money("amount", "Milestone amount"), f("status", "Milestone status", "textFormat"), f("attempts", "Delivery attempts", "integerFormat"),
    f("settled_percent", "Settled %", "integerFormat", "Share of the milestone released to the seller, 0-100"), money("settled_amount", "Settled amount"),
    f("settled_by", "Settled by", "textFormat", "Arbiter (auto) = spend gate released automatically; Buyer = manual approval; Tribunal = AI dispute ruling"), f("disputed", "Disputed", "booleanFormat"),
  ],
  reviews: [
    f("review_id", "Review ID", "textFormat"), f("milestone_id", "Milestone ID", "textFormat"), f("pact_id", "Pact ID", "textFormat"), f("review_date", "Review date", "dateFormat"),
    f("attempt", "Attempt", "integerFormat"), f("submitted_by", "Submitted by", "textFormat"), f("decision", "Arbiter decision", "textFormat"),
    f("confidence", "Confidence %", "integerFormat"), f("criteria_met_pct", "Criteria met %", "integerFormat"), f("red_flag", "Red flag", "booleanFormat"), f("auto_released", "Auto-released", "booleanFormat"),
  ],
  ledger: [
    f("entry_id", "Entry ID", "textFormat"), f("pact_id", "Pact ID", "textFormat"), f("date", "Date", "dateFormat"), f("kind", "Movement", "textFormat", "hold, capture, refund, void, reauthorize"),
    money("amount", "Amount"), f("paypal_id", "PayPal ID", "textFormat"),
  ],
};

export function buildTables({ includeDemo = true } = {}) {
  const pacts = store.list().filter((p) => includeDemo || !p.demo);
  const pactRows = [];
  const milestoneRows = [];
  const reviewRows = [];
  const ledgerRows = [];

  for (const p of pacts) {
    const captured = p.ledger.filter((l) => l.kind === "capture").reduce((s, l) => s + l.amount, 0);
    const refunded = p.ledger.filter((l) => l.kind === "refund").reduce((s, l) => s + l.amount, 0);
    const reviews = p.milestones.flatMap((m) => m.submissions.filter((s) => s.verdict));
    pactRows.push({
      pact_id: p.id,
      title: p.title,
      status: p.status,
      seller_type: p.seller.kind === "agent" ? "AI agent" : "Human",
      seller: p.seller.name,
      buyer: p.buyer.name,
      created_date: day(p.createdAt),
      funded_date: day(p.fundedAt),
      escrow_total: p.total,
      released: Math.round((captured - refunded) * 100) / 100,
      refunded,
      milestone_count: p.milestones.length,
      disputes: p.milestones.reduce((s, m) => s + m.disputes.length, 0),
      red_flags: reviews.reduce((s, r) => s + (r.verdict.red_flags?.length ? 1 : 0), 0),
      data_source: p.demo ? "Demo seed" : "Live",
    });
    for (const m of p.milestones) {
      const auto = m.submissions.some((s) => s.gate?.autoRelease);
      milestoneRows.push({
        milestone_id: m.id,
        pact_id: p.id,
        milestone: m.title,
        position: m.index + 1,
        amount: m.amount,
        status: m.status,
        attempts: m.submissions.length,
        settled_percent: m.settlement?.percent ?? null,
        settled_amount: m.settlement?.amount ?? 0,
        settled_by: m.settlement ? (auto ? "Arbiter (auto)" : m.disputes.length ? "Tribunal" : "Buyer") : null,
        disputed: m.disputes.length > 0,
      });
      m.submissions.forEach((s, i) => {
        if (!s.verdict) return;
        const met = s.verdict.criteria.filter((c) => c.result === "met").length;
        reviewRows.push({
          review_id: s.id,
          milestone_id: m.id,
          pact_id: p.id,
          review_date: day(s.at),
          attempt: i + 1,
          submitted_by: s.by === "agent" ? "AI agent" : "Human",
          decision: s.verdict.decision,
          confidence: Math.round(s.verdict.confidence * 100),
          criteria_met_pct: Math.round((met / Math.max(1, s.verdict.criteria.length)) * 100),
          red_flag: (s.verdict.red_flags?.length || 0) > 0,
          auto_released: Boolean(s.gate?.autoRelease),
        });
      });
    }
    for (const l of p.ledger) {
      ledgerRows.push({ entry_id: `${p.id}:${l.paypalId}:${l.kind}:${l.at}`, pact_id: p.id, date: day(l.at), kind: l.kind, amount: l.amount, paypal_id: l.paypalId });
    }
  }

  return {
    sources: [
      { id: "pacts", name: "Pacts", description: "One row per escrow pact (a deal between a buyer and a seller, funded by a PayPal authorization hold).", primaryKeyField: "pact_id", fields: FIELDS.pacts, data: pactRows },
      { id: "milestones", name: "Milestones", description: "Payment tranches of a pact. status: pending, reviewing, revision_requested, escalated, released, settled (partial), refunded, voided.", primaryKeyField: "milestone_id", fields: FIELDS.milestones, data: milestoneRows },
      { id: "reviews", name: "Arbiter reviews", description: "Each AI arbiter verdict on a submitted deliverable: decision (release, request_revision, escalate), confidence 0-100, and whether the deterministic spend gate auto-released funds.", primaryKeyField: "review_id", fields: FIELDS.reviews, data: reviewRows },
      { id: "ledger", name: "PayPal ledger", description: "PayPal money movements: hold (authorization), capture, refund, void, reauthorize. Amounts in USD.", primaryKeyField: "entry_id", fields: FIELDS.ledger, data: ledgerRows },
    ],
    relationships: [
      { id: "pact_milestones", type: "one-to-many", source: { tableId: "pacts", fieldId: "pact_id" }, target: { tableId: "milestones", fieldId: "pact_id" } },
      { id: "milestone_reviews", type: "one-to-many", source: { tableId: "milestones", fieldId: "milestone_id" }, target: { tableId: "reviews", fieldId: "milestone_id" } },
      { id: "pact_ledger", type: "one-to-many", source: { tableId: "pacts", fieldId: "pact_id" }, target: { tableId: "ledger", fieldId: "pact_id" } },
    ],
  };
}

// In-memory fake of the PayPal REST endpoints Clause uses. For automated tests only.
import assert from "node:assert/strict";

export const pp = { orders: {}, auths: {}, captures: {}, calls: [] };
let seq = 0;
const nid = (p) => `${p}${++seq}`.padEnd(17, "X");
export function fakePayPal(req, res) {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body && req.headers["content-type"]?.includes("json") ? JSON.parse(body) : {};
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const u = req.url;
    pp.calls.push(`${req.method} ${u.replace(/[A-Z0-9]{17}/g, ":id")}`);
    let m;
    if (u === "/v1/oauth2/token") return send(200, { access_token: "fake", expires_in: 3600 });
    if (u === "/v2/checkout/orders" && req.method === "POST") {
      const id = nid("ORD");
      const pu = j.purchase_units[0];
      const itemSum = pu.items.reduce((s, i) => s + Number(i.unit_amount.value), 0);
      assert.equal(itemSum.toFixed(2), pu.amount.value, "items must sum to amount");
      pp.orders[id] = { id, amount: pu.amount, approved: true };
      return send(201, { id, status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: `https://sandbox.example/approve?token=${id}` }] });
    }
    if ((m = u.match(/^\/v2\/checkout\/orders\/(\w+)\/authorize$/))) {
      const o = pp.orders[m[1]];
      if (!o?.approved) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED", description: "x" }] });
      const aid = nid("AUT");
      pp.auths[aid] = { id: aid, amount: Number(o.amount.value), captured: 0, status: "CREATED" };
      return send(201, { id: o.id, status: "COMPLETED", payer: { email_address: "buyer@example.com", name: { given_name: "Test", surname: "Buyer" }, payer_id: "P1" }, purchase_units: [{ payments: { authorizations: [{ id: aid, status: "CREATED", amount: o.amount, expiration_time: "2099-01-01T00:00:00Z" }] } }] });
    }
    if ((m = u.match(/^\/v2\/payments\/authorizations\/(\w+)\/capture$/))) {
      const a = pp.auths[m[1]];
      if (!a || ["CAPTURED", "VOIDED"].includes(a.status)) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED", description: "closed" }] });
      const amt = Number(j.amount.value);
      if (a.captured + amt > a.amount + 1e-9) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "MAX_CAPTURE_AMOUNT_EXCEEDED", description: "too much" }] });
      a.captured += amt;
      a.status = j.final_capture ? "CAPTURED" : "PARTIALLY_CAPTURED";
      const cid = nid("CAP");
      pp.captures[cid] = { id: cid, amount: amt, refunded: 0, final: j.final_capture };
      return send(201, { id: cid, status: "COMPLETED", amount: j.amount, final_capture: j.final_capture });
    }
    if ((m = u.match(/^\/v2\/payments\/authorizations\/(\w+)\/void$/))) {
      const a = pp.auths[m[1]];
      if (!a || a.status === "CAPTURED" || a.status === "VOIDED") return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "CANNOT_BE_VOIDED", description: "x" }] });
      a.status = "VOIDED";
      res.writeHead(204); return res.end();
    }
    if ((m = u.match(/^\/v2\/payments\/authorizations\/(\w+)$/))) {
      const a = pp.auths[m[1]];
      return send(200, { id: a.id, status: a.status, amount: { currency_code: "USD", value: a.amount.toFixed(2) }, expiration_time: "2099-01-01T00:00:00Z" });
    }
    if ((m = u.match(/^\/v2\/payments\/captures\/(\w+)\/refund$/))) {
      const c = pp.captures[m[1]];
      const amt = Number(j.amount.value);
      if (c.refunded + amt > c.amount + 1e-9) return send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "x" }] });
      c.refunded += amt;
      return send(201, { id: nid("REF"), status: "COMPLETED", amount: j.amount });
    }
    send(404, { name: "NOT_FOUND" });
  });
}


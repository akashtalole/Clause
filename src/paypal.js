// Thin PayPal REST client (sandbox) for the escrow lifecycle:
// Orders v2 (intent AUTHORIZE) -> Authorizations -> partial Captures / Void / Reauthorize -> Refunds.
import crypto from "node:crypto";

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

let cachedToken = null; // { value, expiresAt }

export class PayPalError extends Error {
  constructor(message, { status, name, details, debugId } = {}) {
    super(message);
    this.status = status;
    this.paypalName = name;
    this.details = details;
    this.debugId = debugId;
  }
}

export function isConfigured() {
  return Boolean(process.env.PAYPAL_SANDBOX_CLIENT_ID && process.env.PAYPAL_SANDBOX_CLIENT_SECRET);
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const id = process.env.PAYPAL_SANDBOX_CLIENT_ID;
  const secret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!id || !secret) throw new PayPalError("PayPal sandbox credentials are not configured (.env)");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError(`PayPal auth failed: ${data.error_description || res.status}`, { status: res.status });
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function call(method, path, body, { idempotencyKey } = {}) {
  const token = await getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  // Idempotency: retries of the same money movement never double-charge.
  if (method !== "GET") headers["PayPal-Request-Id"] = idempotencyKey || crypto.randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = data.details?.[0];
    const msg = detail ? `${detail.issue}: ${detail.description}` : data.message || `HTTP ${res.status}`;
    throw new PayPalError(`PayPal ${method} ${path.split("?")[0]} failed — ${msg}`, {
      status: res.status,
      name: data.name,
      details: data.details,
      debugId: data.debug_id || res.headers.get("paypal-debug-id"),
    });
  }
  return data;
}

const money = (currency, value) => ({ currency_code: currency, value: Number(value).toFixed(2) });

/**
 * One order, one buyer approval, funds HELD (not charged) via intent=AUTHORIZE.
 * Each milestone becomes a line item so the buyer sees exactly what they are funding.
 */
export async function createEscrowOrder(pact, { returnUrl, cancelUrl } = {}) {
  const cur = pact.currency;
  const items = pact.milestones.map((m, i) => ({
    name: `M${i + 1}: ${m.title}`.slice(0, 127),
    description: (m.description || "").slice(0, 127),
    quantity: "1",
    unit_amount: money(cur, m.amount),
    category: "DIGITAL_GOODS",
  }));
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [
      {
        reference_id: pact.id,
        custom_id: pact.id,
        invoice_id: `${pact.id}-${Date.now()}`,
        description: `Clause escrow: ${pact.title}`.slice(0, 127),
        soft_descriptor: "CLAUSE ESCROW",
        amount: { ...money(cur, pact.total), breakdown: { item_total: money(cur, pact.total) } },
        items,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: "Clause Escrow",
          shipping_preference: "NO_SHIPPING",
          user_action: "CONTINUE",
          ...(returnUrl ? { return_url: returnUrl, cancel_url: cancelUrl || returnUrl } : {}),
        },
      },
    },
  };
  const order = await call("POST", "/v2/checkout/orders", body, { idempotencyKey: `order-${pact.id}-${pact.fundingAttempt || 0}` });
  const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  return { orderId: order.id, status: order.status, approveUrl };
}

export async function getOrder(orderId) {
  return call("GET", `/v2/checkout/orders/${orderId}`);
}

/** After buyer approval: place the hold. Returns the authorization object. */
export async function authorizeOrder(orderId) {
  const order = await call("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, { idempotencyKey: `authorize-${orderId}` });
  const pu = order.purchase_units?.[0];
  const auth = pu?.payments?.authorizations?.[0];
  if (!auth) throw new PayPalError("Order authorized but no authorization returned");
  return {
    authorizationId: auth.id,
    status: auth.status,
    amount: auth.amount,
    expirationTime: auth.expiration_time,
    payer: order.payer ? { email: order.payer.email_address, name: [order.payer.name?.given_name, order.payer.name?.surname].filter(Boolean).join(" "), payerId: order.payer.payer_id } : null,
  };
}

export async function getAuthorization(authorizationId) {
  return call("GET", `/v2/payments/authorizations/${authorizationId}`);
}

/**
 * Release (part of) the held funds to the seller.
 * finalCapture=false keeps the remaining hold alive for later milestones.
 */
export async function captureAuthorization(authorizationId, { amount, currency, finalCapture, invoiceId, note, idempotencyKey }) {
  const cap = await call(
    "POST",
    `/v2/payments/authorizations/${authorizationId}/capture`,
    {
      amount: money(currency, amount),
      final_capture: Boolean(finalCapture),
      invoice_id: invoiceId,
      note_to_payer: note?.slice(0, 255),
      soft_descriptor: "CLAUSE ESCROW",
    },
    { idempotencyKey }
  );
  return { captureId: cap.id, status: cap.status, amount: cap.amount, finalCapture: cap.final_capture };
}

/** Release whatever is still held back to the buyer. */
export async function voidAuthorization(authorizationId) {
  await call("POST", `/v2/payments/authorizations/${authorizationId}/void`, null, { idempotencyKey: `void-${authorizationId}` });
  return { status: "VOIDED" };
}

/** Authorizations are honored for 3 days; reauthorize to extend for long-running pacts. */
export async function reauthorize(authorizationId, { amount, currency }) {
  const r = await call("POST", `/v2/payments/authorizations/${authorizationId}/reauthorize`, { amount: money(currency, amount) });
  return { authorizationId: r.id, status: r.status, expirationTime: r.expiration_time };
}

/** Claw back funds already released (e.g. after a successful buyer appeal). */
export async function refundCapture(captureId, { amount, currency, note, idempotencyKey }) {
  const r = await call(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: money(currency, amount), note_to_payer: note?.slice(0, 255) },
    { idempotencyKey }
  );
  return { refundId: r.id, status: r.status, amount: r.amount };
}

export async function ping() {
  await getAccessToken();
  return true;
}

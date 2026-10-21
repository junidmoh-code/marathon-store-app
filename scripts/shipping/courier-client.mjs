// ── Thin Courier Guy (Shiplogic-hosted) API client ───────────────────────────
// Everything here was read from TCG's own API documentation (portal →
// Integrations → API keys → "API documentation", which embeds
// shiplogic.com/tcg/api-docs). docs/COURIER-GUY.md records what was read.
//
//   base URL  https://api.portal.thecourierguy.co.za   (pinned — see BASE_URL)
//   auth      Authorization: Bearer <key>
//
// RETRIES: on 5xx ONLY, and only for calls that cannot create anything (rates,
// lookups, tracking). POST /shipments and POST /shipments/cancel are never
// retried: a 5xx is ambiguous — TCG may have booked the parcel before the
// response was lost — and a blind retry would book (and charge the prepaid
// balance for) a second waybill. Same reasoning as scripts/shopify/client.mjs.
// A 4xx is the caller's mistake and is never retried either.
//
// LOGGING: every call appends one line to logs/courier.log (git-ignored) —
// method, path, status, duration, attempt, and the request/response bodies
// truncated. The API key is redacted from every line, wherever it appears.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { courierApiKey } from "./env.mjs";

// The ONE host this program sends the key to. An .env edit cannot redirect it.
export const BASE_URL = "https://api.portal.thecourierguy.co.za";

// The two calls that change anything at TCG. bookShipment's live-flag guard is
// tested by counting calls to exactly these paths (bookShipment.test.mjs).
export const MUTATION_PATHS = Object.freeze(["/shipments", "/shipments/cancel"]);

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOG_FILE = join(resolve(HERE, "../.."), "logs", "courier.log");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const LOG_BODY_CHARS = 2_000;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export function redact(text, key) {
  let s = String(text ?? "");
  if (key) s = s.split(key).join("[REDACTED]");
  // Belt and braces: any Bearer token, whatever it is, never reaches the log.
  return s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}

export function fileLogger(file = LOG_FILE) {
  return (line) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > LOG_ROTATE_BYTES) renameSync(file, `${file}.1`);
      } catch { /* no log yet */ }
      appendFileSync(file, `${new Date().toISOString()}  ${line}\n`);
    } catch { /* logging must never fail a call */ }
  };
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export class CourierHttpError extends Error {
  constructor(method, path, status, body) {
    super(`Courier Guy ${method} ${path} → HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.name = "CourierHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {object} [opts]
 * @param {string}   [opts.apiKey]      defaults to COURIER_GUY_API_KEY
 * @param {Function} [opts.fetchImpl]   defaults to global fetch (tests inject)
 * @param {Function} [opts.log]         (line) => void, defaults to logs/courier.log
 * @param {Function} [opts.sleep]       backoff sleeper (tests inject a no-op)
 */
export function createCourierClient({
  apiKey,
  fetchImpl = globalThis.fetch,
  log = fileLogger(),
  sleep = sleepMs,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
} = {}) {
  const key = apiKey ?? courierApiKey();

  async function call(method, path, { query, body, retry5xx }) {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
    const url = `${BASE_URL}${path}${qs}`;
    const attempts = retry5xx ? maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res, text;
      try {
        res = await fetchImpl(url, {
          method,
          headers: {
            Authorization: `Bearer ${key}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        text = await res.text();
      } catch (err) {
        clearTimeout(timer);
        log(redact(`${method} ${path}${qs} ✗ ${err?.name === "AbortError" ? `timeout ${timeoutMs}ms` : err?.message} attempt=${attempt}`, key));
        // A timeout on a mutation is as ambiguous as a 5xx — never retried.
        // A network error before any response on a read is retried like a 5xx.
        if (attempt < attempts) { await sleep(2 ** attempt * 500); continue; }
        throw err;
      }
      clearTimeout(timer);
      log(redact(
        `${method} ${path}${qs} → ${res.status} ${Date.now() - started}ms attempt=${attempt}` +
          (body ? `  req=${JSON.stringify(body).slice(0, LOG_BODY_CHARS)}` : "") +
          `  res=${text.slice(0, LOG_BODY_CHARS)}`,
        key
      ));
      if (res.status >= 500 && attempt < attempts) {
        await sleep(2 ** attempt * 500);
        continue;
      }
      if (!res.ok) throw new CourierHttpError(method, path, res.status, redact(text, key));
      try { return text ? JSON.parse(text) : null; }
      catch { return text; }
    }
  }

  return {
    /** POST /rates — quotes only, books nothing. */
    getRates: (body) => call("POST", "/rates", { body, retry5xx: true }),
    /** GET /pickup-points — lockers / counters / points near a lat,lng. */
    getPickupPoints: (query) => call("GET", "/pickup-points", { query, retry5xx: true }),
    /** GET /shipments — list, or one by tracking_reference / id. */
    getShipments: (query) => call("GET", "/shipments", { query, retry5xx: true }),
    /** GET /tracking/shipments?tracking_reference= */
    trackShipment: (trackingReference) =>
      call("GET", "/tracking/shipments", { query: { tracking_reference: trackingReference }, retry5xx: true }),
    /** POST /shipments — BOOKS A WAYBILL AND CHARGES THE ACCOUNT. Never retried. */
    createShipment: (body) => call("POST", "/shipments", { body, retry5xx: false }),
    /** POST /shipments/cancel — reverses charges if not yet collected. Never retried. */
    cancelShipment: (trackingReference) =>
      call("POST", "/shipments/cancel", { body: { tracking_reference: trackingReference }, retry5xx: false }),
  };
}

// Bluetooth order hand-off — the wire format the tablet speaks to Till 1.
//
// Every sneaker order placed on the floor tablet is ALSO pushed to Till 1 at
// Marathon PE over Bluetooth LE, so the till can sell it by order number with
// no internet (marathon-pos-app docs/bt-order-handoff-investigation.md). The
// till runs a small .NET receiver (marathon-pos-app bt-receiver/) as a BLE
// peripheral; this file must produce byte-for-byte what it expects. The shared
// test vector (src/btHandoff/__tests__/test-vector.json, a copy of
// marathon-pos-app bt-receiver/test-vector.json) keeps the two honest.
//
// message = payload (UTF-8 JSON) || HMAC-SHA256(key, "MBT1" || payload)
// chunk   = 16-byte header || up to CHUNK_DATA bytes of the message
//   0 magic 0xB7 · 1 version 1 · 2..3 msgId u16 LE · 4..5 index u16 LE ·
//   6..7 count u16 LE · 8..11 total length u32 LE · 12..15 CRC-32 of the data

export const SERVICE_UUID = "4d42540a-0001-4c8e-9a51-7c1d2b3e5f00";
export const WRITE_UUID = "4d42540a-0002-4c8e-9a51-7c1d2b3e5f00";
export const ACK_UUID = "4d42540a-0003-4c8e-9a51-7c1d2b3e5f00";
export const NAME_UUID = "4d42540a-0004-4c8e-9a51-7c1d2b3e5f00";

const MAGIC = 0xb7;
const VERSION = 0x01;
export const HEADER_SIZE = 16;
export const CHUNK_DATA = 164; // 180-byte writes: fits any negotiated MTU a phone gets
const MAX_MESSAGE = 16 * 1024;
const MAC_LENGTH = 32;
const DOMAIN = new TextEncoder().encode("MBT1");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodeFrames(msgId, message, chunkData = CHUNK_DATA) {
  if (!(message instanceof Uint8Array) || message.length === 0 || message.length > MAX_MESSAGE) {
    throw new Error("message length out of range");
  }
  const count = Math.ceil(message.length / chunkData);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const data = message.subarray(i * chunkData, Math.min(message.length, (i + 1) * chunkData));
    const frame = new Uint8Array(HEADER_SIZE + data.length);
    const v = new DataView(frame.buffer);
    frame[0] = MAGIC;
    frame[1] = VERSION;
    v.setUint16(2, msgId & 0xffff, true);
    v.setUint16(4, i, true);
    v.setUint16(6, count, true);
    v.setUint32(8, message.length, true);
    v.setUint32(12, crc32(data), true);
    frame.set(data, HEADER_SIZE);
    frames.push(frame);
  }
  return frames;
}

async function hmacKey(keyBytes) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function seal(keyBytes, payloadBytes) {
  const data = new Uint8Array(DOMAIN.length + payloadBytes.length);
  data.set(DOMAIN, 0);
  data.set(payloadBytes, DOMAIN.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(keyBytes), data));
  const out = new Uint8Array(payloadBytes.length + MAC_LENGTH);
  out.set(payloadBytes, 0);
  out.set(mac, payloadBytes.length);
  return out;
}

// ---- the pairing code: 16 key bytes as 26 RFC 4648 base32 letters ----------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// → Uint8Array(16), or null for anything that is not exactly a pairing code.
export function parsePairingCode(code) {
  if (typeof code !== "string") return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of code.toUpperCase()) {
    if (ch === "-" || ch === " ") continue;
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === 16 ? Uint8Array.from(bytes) : null;
}

// ---- the payload ------------------------------------------------------------

// The thin copy of a just-written /orders record the till needs to FIND it:
// no price (the till prices from its own products), no names of things.
// Store-app orders are one line each, so items has exactly one entry.
export function orderPayload(order, sentAtMs = Date.now()) {
  return {
    v: 1,
    t: "order",
    sentAtMs,
    order: {
      orderId: String(order.id),
      orderNumber: String(order.id),
      createdAt: String(order.createdAt),
      destShop: String(order.destShop),
      customerName: String(order.customerName ?? ""),
      customerPhone: String(order.customerPhone ?? ""),
      items: [{ productId: String(order.productId), size: String(order.sentSize ?? order.size ?? ""), qty: 1 }],
    },
  };
}

// id + createdAt: the store-app reuses order numbers daily, so the number
// alone is not an identity. The till keys on the same pair.
export const orderKeyOf = (order) => `${order.id}|${order.createdAt}`;

export async function buildMessage(keyBytes, payload) {
  return seal(keyBytes, new TextEncoder().encode(JSON.stringify(payload)));
}

// The till's ack: {"m":msgId,"s":"ok"|"dup"|"mac"|"bad"|"crc","o":detail}
export function parseAck(bytes) {
  try {
    const a = JSON.parse(new TextDecoder().decode(bytes));
    return typeof a?.m === "number" && typeof a?.s === "string" ? a : null;
  } catch {
    return null;
  }
}

// Global barcode scanner listener — PORTED VERBATIM from marathon-pos-app
// (src/scanner/barcodeListener.js) so the store-app Transfer scan behaves BYTE-FOR-
// BYTE like the POS till sell-scan. Cross-app duplication is deliberate (same as
// utils/sizeKey.js): the two apps can't share code, so keep this identical — if the
// POS version changes, mirror it here.
//
// Marathon's USB barcode scanners present as HID keyboards — each scan is a rapid
// burst of keypresses ending in Enter. We detect those bursts at the WINDOW level
// and re-emit as a `barcode-scanned` CustomEvent, so a screen can react without a
// focused input (that's what makes continuous scan-scan-scan work). Scans are
// ignored while focus is in an input/textarea/select/contenteditable — typing a
// search term or a name must not be mistaken for a scan.

const MIN_LEN     = 4;
const TIMEOUT_MS  = 500;
const EVENT_NAME  = "barcode-scanned";

let _buffer  = "";
let _lastTs  = 0;
let _bound   = false;

function focusIsEditable() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

function onKeyDown(e) {
  if (focusIsEditable()) {
    _buffer = "";
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;

  const now = Date.now();
  if (now - _lastTs > TIMEOUT_MS) _buffer = "";
  _lastTs = now;

  if (e.key === "Enter") {
    if (_buffer.length >= MIN_LEN) {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, {
        detail: { value: _buffer, ts: now },
      }));
      e.preventDefault();
    }
    _buffer = "";
    return;
  }

  // Only collect printable single characters — ignore Tab/Shift/Arrow/etc.
  if (e.key.length === 1) _buffer += e.key;
}

export function installBarcodeListener() {
  if (_bound) return () => {};
  window.addEventListener("keydown", onKeyDown);
  _bound = true;
  return () => {
    window.removeEventListener("keydown", onKeyDown);
    _bound = false;
    _buffer = "";
    _lastTs = 0;
  };
}

// Subscribe to scans + auto-unsubscribe: subscribeBarcode(value => …).
export function subscribeBarcode(handler) {
  const wrapped = (e) => handler(e.detail.value, e.detail.ts);
  window.addEventListener(EVENT_NAME, wrapped);
  return () => window.removeEventListener(EVENT_NAME, wrapped);
}

export { EVENT_NAME as BARCODE_EVENT_NAME };

// ─── DEVICE GATES — ONE SWITCH, PAUSED (2026-10-13) ──────────────────────────
//
// The per-device staff code (#647), the device quarantine (#640/#648) and the
// section an enrolled device's code carries (#699) all gate on this one flag.
// It was paused on 13 Oct 2026 because the code screen was stopping MC from
// working. While it is false, EVERY device, whether enrolled, unenrolled or
// quarantined, behaves exactly as before #647 shipped:
//
//   · no code screen (deviceGateVerdict answers "app"), whatever
//     /users/{uid}/deviceCodeRequired says;
//   · no "Show this screen to Junid" overlay, and no "This phone has been
//     paused" refusal before a reject or a send (thisDevicePaused → false);
//   · an enrolled device's `section` claim narrows nothing (sections come
//     from the account alone, as before).
//
// Nothing is deleted. The codes, the enrolments (/users/{uid}/deviceGate),
// deviceCodeRequired, the quarantine flags (/mirror_switch/quarantine) and the
// Device Codes and Mirror Fleet screens all stay, so reviving is one edit.
// What keeps running regardless: the passive device stamps on every order and
// request action (deviceStamp.js, rejectCount.js). They never prompt or block.
//
// TO REVIVE: set DEVICE_GATES_ENABLED = true here AND in
// functions/lib/device-gates-switch.cjs (a test fails if they differ), then
// deploy hosting and functions:cardBatchCapture,cardBatchReadJob,cardBatchReadRetry.
// Runbook: docs/DEVICE-ENROLMENT.md.
//
// A code constant, not a database flag: no device can be left gated by a
// value it failed to read, and no one has to toggle anything by hand.

export const DEVICE_GATES_ENABLED = false;

// Tests only: the gated paths are still tested with the gates on.
let override = null;
export function setDeviceGatesForTest(on) {
  override = on == null ? null : !!on;
}

export function deviceGatesOn() {
  return override == null ? DEVICE_GATES_ENABLED : override;
}

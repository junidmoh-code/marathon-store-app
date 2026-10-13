// ─── DEVICE GATES — THE SERVER HALF OF ONE SWITCH, PAUSED (2026-10-13) ───────
//
// Mirror of src/device/deviceGatesSwitch.js (a test fails if the two differ).
// While false, an enrolled device's `section` claim narrows nothing on the
// server either: readSectionClaim (lib/section-access.cjs) answers null, so
// card capture is walled by the ACCOUNT's sections alone, as before #647.
//
// TO REVIVE: true here AND in src/device/deviceGatesSwitch.js, then deploy
// hosting and functions:cardBatchCapture,cardBatchReadJob,cardBatchReadRetry.

const DEVICE_GATES_ENABLED = false;

let override = null;
function setDeviceGatesForTest(on) {
  override = on == null ? null : !!on;
}

function deviceGatesOn() {
  return override == null ? DEVICE_GATES_ENABLED : override;
}

module.exports = { DEVICE_GATES_ENABLED, deviceGatesOn, setDeviceGatesForTest };

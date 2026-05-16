// Shared PIN/username transforms for staff auth. CJS mirror of src/utils/auth-utils.js.
// Both files MUST stay byte-identical at the function bodies — if they drift, the
// password seeded for a staff PIN won't match what Login.jsx sends to Firebase Auth.

function toAuthPassword(pin) {
  // Never echo the supplied PIN in this error — the message may be logged
  // or surfaced upstream and the PIN is credential material.
  if (!/^\d{4}$/.test(String(pin))) {
    throw new Error("PIN must be exactly 4 digits.");
  }
  return `pin-${pin}`;
}

function usernameToEmail(username) {
  return `${String(username).toLowerCase().trim()}@marathon.internal`;
}

module.exports = { toAuthPassword, usernameToEmail };

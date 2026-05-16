// Shared PIN/username transforms for staff auth. ES-module mirror of
// functions/lib/auth-utils.cjs. Both files MUST stay byte-identical at the
// function bodies — if they drift, the password seeded for a staff PIN won't
// match what Login.jsx sends to Firebase Auth.

export function toAuthPassword(pin) {
  if (!/^\d{4}$/.test(String(pin))) {
    throw new Error(`PIN must be exactly 4 digits, got: ${pin}`);
  }
  return `pin-${pin}`;
}

export function usernameToEmail(username) {
  return `${String(username).toLowerCase().trim()}@marathon.internal`;
}

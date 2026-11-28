// DEV ONLY — firebase/messaging stand-in: no push in the harness.
export function getMessaging() { return {}; }
export async function getToken() { return null; }
export function onMessage() { return () => {}; }
export async function isSupported() { return false; }
export async function deleteToken() { return true; }

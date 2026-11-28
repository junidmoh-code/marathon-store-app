// DEV ONLY — firebase/functions stand-in: every callable answers an empty result
// and is recorded on window.__fakeCalls. Nothing reaches a server.
export function getFunctions() { return { __fake: true }; }
export function httpsCallable(_f, name) {
  return async (data) => {
    if (typeof window !== "undefined") (window.__fakeCalls ||= []).push({ name, data });
    return { data: {} };
  };
}

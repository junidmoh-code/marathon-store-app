// ── A read-through, write-nothing database for dry runs ─────────────────────
// Reads go to the real database; every write is described to `log` instead
// and reported as having succeeded, so a dry run walks the same path a real
// tick would. A transaction runs its update function once against the value
// read now and logs the result. Writes are remembered in an overlay so a dry
// run reads back what it "wrote" (an order created in step 1 is kept in step 2).
export function recordingDb(db, log) {
  const overlay = new Map();
  const short = (v) => {
    const s = JSON.stringify(v);
    return s && s.length > 300 ? `${s.slice(0, 300)}…` : s;
  };
  const read = async (path) => (overlay.has(path) ? overlay.get(path) : (await db.ref(path).get()).val());
  const snap = (v) => ({ val: () => v, exists: () => v != null });
  const ref = (path) => {
    const real = db.ref(path);
    return {
      key: real.key,
      get: async () => snap(await read(path)),
      set: async (v) => { overlay.set(path, v ?? null); log(`set ${path} = ${short(v)}`); },
      update: async (v) => { log(`update ${path} ${short(v)}`); },
      push: () => ({ key: real.push().key }),
      transaction: async (fn) => {
        const cur = await read(path);
        const next = fn(cur);
        if (next === undefined) return { committed: false, snapshot: snap(cur) };
        overlay.set(path, next);
        log(`txn ${path} → ${short(next)}`);
        return { committed: true, snapshot: snap(next) };
      },
      orderByChild: (child) => ({
        equalTo: (value) => ({ get: async () => db.ref(path).orderByChild(child).equalTo(value).get() }),
      }),
    };
  };
  return { ref };
}

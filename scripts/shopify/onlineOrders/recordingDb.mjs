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
  // The nearest "written" ancestor answers for its children too, so a dry
  // run that created an order reads back that order's status.
  const read = async (path) => {
    const segs = path.split("/").filter(Boolean);
    for (let i = segs.length; i > 0; i--) {
      const anc = segs.slice(0, i).join("/");
      if (!overlay.has(anc)) continue;
      let v = overlay.get(anc);
      for (const k of segs.slice(i)) v = v == null ? null : (v[k] ?? null);
      return v;
    }
    return (await db.ref(path).get()).val();
  };
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

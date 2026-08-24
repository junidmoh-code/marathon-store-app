const sharp = require("sharp");
const fs = require("fs");
const D = require("./_design.cjs");
const SC = "/private/tmp/claude-501/-Users-junidmohammed-Documents-marathon-store-app--worktrees-social-install/99923c09-e301-4fec-bc1d-bad7b906833b/scratchpad";
const raw = JSON.parse(fs.readFileSync(SC + "/outfit.json", "utf8"));
const items = raw.map(r => ({ slot: r.slot, name: r.trueName, price: r.price }));
console.log("items:"); items.forEach(i => console.log("   ", i.slot.padEnd(10), i.name.trim(), "R"+i.price));
console.log("TOTAL computed in code: R" + items.reduce((s,i)=>s+i.price,0));
(async () => {
  const base = await sharp(SC + "/onmodel.jpg").resize(D.W, D.H, { fit: "cover", position: "attention" }).toBuffer();
  for (const [file, opts] of [
    ["EX1-leader-lines.jpg", { layout: "lines", theme: "dark", showTotal: true }],
    ["EX2-side-rail.jpg",    { layout: "rail",  theme: "dark", showTotal: true }],
  ]) {
    const svg = D.buildOverlay({ items, ...opts });
    await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toFile(SC + "/" + file);
    console.log("wrote", file, fs.statSync(SC + "/" + file).size, "bytes");
  }
})();

const fk = require("fontkit");
const f = fk.openSync(process.argv[2]);
const chars = [];
for (let c = 0x20; c <= 0x7e; c++) chars.push(c);
for (let c = 0xa0; c <= 0x17f; c++) chars.push(c);
for (const c of [0x2018, 0x2019, 0x201c, 0x201d, 0x2013, 0x2014, 0x2022, 0x2122, 0x2192, 0x20ac]) chars.push(c);
const out = { font: "Archivo.ttf", unitsPerEm: f.unitsPerEm, weights: {} };
for (const w of [400, 600, 700]) {
  const v = f.getVariation({ wght: w });
  const adv = {};
  let max = 0;
  for (const c of chars) {
    const g = v.glyphForCodePoint(c);
    if (!g || g.id === 0) continue;
    adv[String.fromCodePoint(c)] = Math.round(g.advanceWidth * 10) / 10;
    max = Math.max(max, g.advanceWidth);
  }
  out.weights[w] = { fallback: Math.ceil(max), advance: adv };
}
process.stdout.write(JSON.stringify(out) + "\n");

#!/usr/bin/env node
// DEV ONLY — synthetic product photos for the sky phone perf harness
// (dev/sky-harness.html?screen=phone&bulk=N). 80 JPEGs about the size of a
// real product original (~110 KB; the live mean is 108.8 KB), written to
// dev/photos.local/ (gitignored). Nothing real: a shoe-ish shape on noise.
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const OUT = "dev/photos.local";
mkdirSync(OUT, { recursive: true });
const W = 800, H = 1000;
for (let i = 0; i < 80; i++) {
  const hue = (i * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="hsl(${hue},25%,92%)"/>
    <path d="M90 640c80-12 140-80 190-160 28-44 80-56 116-24 52 44 104 80 184 96 100 20 150 40 170 90 8 24-8 44-30 44H120c-36 0-52-30-30-46z" fill="hsl(${hue},70%,45%)" stroke="#1b2a44" stroke-width="8"/>
    <text x="40" y="90" font-size="56" font-family="Arial" fill="#1b2a44">SAMPLE ${i + 1}</text></svg>`;
  const noise = Buffer.alloc(W * H * 3);
  for (let k = 0; k < noise.length; k++) noise[k] = (Math.random() * 110) | 0;
  const base = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp(base).composite([{ input: await sharp(noise, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), blend: "overlay" }])
    .jpeg({ quality: 88 }).toFile(`${OUT}/${i}.jpg`);
}
console.log(`wrote 80 photos to ${OUT}`);

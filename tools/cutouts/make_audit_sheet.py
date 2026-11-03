#!/usr/bin/env python3
"""The cut-out gate's review sheet: N random passes beside N random rejects,
each reject labelled with the rule that failed it (attempt 1 -> the retry).

    make_audit_sheet.py AUDIT_DIR OUT.png [--n 40] [--seed 7]

AUDIT_DIR is what cutout.py leaves in ~/.marathon-cutouts/audit: audit.jsonl
(one line per judged product, the last line per id wins) and <pid>-<n>.jpg
previews of each attempt.
"""
import argparse
import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

TILE = 200
COLS = 5
LABEL_H = 34
GAP = 40


def font(size):
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def load(audit_dir):
    latest = {}
    for line in (Path(audit_dir) / "audit.jsonl").read_text().splitlines():
        if line.strip():
            rec = json.loads(line)
            latest[rec["id"]] = rec
    return list(latest.values())


def tile(audit_dir, rec, kind, f):
    t = Image.new("RGB", (TILE, TILE + LABEL_H), (236, 240, 246))
    n = rec.get("passed_attempt") or 1
    p = Path(audit_dir) / ("%s-%d.jpg" % (rec["id"], n))
    if not p.exists() and kind == "reject":
        p = Path(audit_dir) / ("%s-2.jpg" % rec["id"])
    if p.exists():
        t.paste(Image.open(p).convert("RGB").resize((TILE, TILE)), (0, 0))
    else:
        ImageDraw.Draw(t).text((10, TILE // 2 - 10), "no shoe found", fill=(90, 90, 90), font=f)
    d = ImageDraw.Draw(t)
    if kind == "pass":
        label = "pass" + (" (retry)" if n == 2 else "")
        colour = (10, 107, 52)
    else:
        rules = [a["rule"] for a in rec.get("attempts", []) if a.get("rule")]
        label = " -> ".join(rules) or rec.get("rule", "")
        colour = (176, 0, 32)
    d.text((6, TILE + 2), label, fill=colour, font=f)
    d.text((6, TILE + 18), rec["id"], fill=(60, 60, 70), font=font(11))
    return t


def sheet(audit_dir, out, n=40, seed=7):
    recs = load(audit_dir)
    passes = [r for r in recs if r["quality"] == "shoe"]
    rejects = [r for r in recs if r["quality"] == "rejected"]
    rnd = random.Random(seed)
    ps = rnd.sample(passes, min(n, len(passes)))
    rs = rnd.sample(rejects, min(n, len(rejects)))
    rows = (max(len(ps), len(rs)) + COLS - 1) // COLS
    block_w = COLS * TILE
    head = 70
    W = 2 * block_w + GAP + 40
    H = head + rows * (TILE + LABEL_H) + 30
    img = Image.new("RGB", (W, H), (255, 255, 255))
    d = ImageDraw.Draw(img)
    big = font(24)
    total = len(passes) + len(rejects)
    d.text((20, 18), "PASS — %d random of %d (%.0f%%)" % (len(ps), len(passes), 100.0 * len(passes) / max(1, total)),
           fill=(10, 107, 52), font=big)
    d.text((20 + block_w + GAP, 18), "REJECTED — %d random of %d, failing rule" % (len(rs), len(rejects)),
           fill=(176, 0, 32), font=big)
    f = font(14)
    for k, (recs_, x0, kind) in enumerate([(ps, 20, "pass"), (rs, 20 + block_w + GAP, "reject")]):
        for i, rec in enumerate(recs_):
            img.paste(tile(audit_dir, rec, kind, f), (x0 + (i % COLS) * TILE, head + (i // COLS) * (TILE + LABEL_H)))
    img.save(out, optimize=True)
    return len(passes), len(rejects)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audit_dir")
    ap.add_argument("out")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    p, r = sheet(a.audit_dir, a.out, a.n, a.seed)
    print("pass %d rejected %d -> %s" % (p, r, a.out))


if __name__ == "__main__":
    main()

"""Fashion-CLIP readings of product photos, for the local stylist.

Reads JSON on stdin: {"items": [{"pid": "...", "url": "...", "slot": "tee"}],
"colours": [...], "styles": [...]} and writes JSON on stdout:
{"pid": {"vec": [512 floats], "colour": "navy", "colours": {...top 3},
"style": {"streetwear": p, ...}, "statement": p}}.

Open weights: patrickjohncyh/fashion-clip (Hugging Face), run on the Mac
mini's CPU/MPS in ~/.marathon-stylist/venv. Free, offline after the first
download. Every reading is cached in ~/.marathon-stylist/fclip.sqlite by pid
and photo URL, so a photo is read once; a changed photo is read again.
"""
import io
import json
import os
import sqlite3
import sys
import urllib.request

import torch
from PIL import Image
from transformers import CLIPModel, CLIPProcessor

MODEL = "patrickjohncyh/fashion-clip"
HOME = os.path.expanduser(os.environ.get("STYLIST_HOME", "~/.marathon-stylist"))
DB = os.path.join(HOME, "fclip.sqlite")
VERSION = "v1"
GARMENT = {"tee": "t-shirt", "jacket": "jacket", "bottoms": "pants", "sneakers": "sneakers", "hat": "cap", "bag": "bag"}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "marathon-stylist/1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        img = Image.open(io.BytesIO(r.read()))
    img = img.convert("RGBA")
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    return Image.alpha_composite(bg, img).convert("RGB")


def main():
    req = json.load(sys.stdin)
    items = req.get("items", [])
    colours = req["colours"]
    styles = req["styles"]
    os.makedirs(HOME, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("create table if not exists r (pid text, url text, ver text, data text, primary key (pid, url, ver))")
    out, todo = {}, []
    for it in items:
        row = con.execute("select data from r where pid=? and url=? and ver=?", (it["pid"], it["url"], VERSION)).fetchone()
        if row:
            out[it["pid"]] = json.loads(row[0])
        else:
            todo.append(it)
    if todo:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        model = CLIPModel.from_pretrained(MODEL).to(device).eval()
        proc = CLIPProcessor.from_pretrained(MODEL)

        def text_emb(texts):
            with torch.no_grad():
                t = proc(text=texts, return_tensors="pt", padding=True).to(device)
                e = model.get_text_features(**t)
            return e / e.norm(dim=-1, keepdim=True)

        cache = {}

        def prompts(slot):
            if slot not in cache:
                g = GARMENT.get(slot, "garment")
                cache[slot] = (
                    text_emb([f"a photo of a {c} {g}" for c in colours]),
                    text_emb([f"a {s} style {g}" for s in styles]),
                    text_emb([f"a plain minimal {g} in one colour", f"a loud {g} with a big graphic print, bold logo or busy pattern"]),
                )
            return cache[slot]

        failed = 0
        for i in range(0, len(todo), 16):
            batch, imgs = [], []
            for it in todo[i:i + 16]:
                try:
                    imgs.append(fetch(it["url"]))
                    batch.append(it)
                except Exception as e:  # a photo that will not download is simply not read
                    failed += 1
                    print(f"embed: {it['pid']} photo failed: {e}", file=sys.stderr)
            if not batch:
                continue
            with torch.no_grad():
                px = proc(images=imgs, return_tensors="pt").to(device)
                ie = model.get_image_features(**px)
            ie = ie / ie.norm(dim=-1, keepdim=True)
            scale = model.logit_scale.exp()
            for it, v in zip(batch, ie):
                ce, se, me = prompts(it.get("slot", ""))
                cp = (scale * v @ ce.T).softmax(-1).tolist()
                sp = (scale * v @ se.T).softmax(-1).tolist()
                mp = (scale * v @ me.T).softmax(-1).tolist()
                top = sorted(range(len(colours)), key=lambda k: -cp[k])[:3]
                rec = {
                    "vec": [round(x, 4) for x in v.cpu().tolist()],
                    "colour": colours[top[0]],
                    "colours": {colours[k]: round(cp[k], 3) for k in top},
                    "style": {styles[k]: round(sp[k], 3) for k in range(len(styles))},
                    "statement": round(mp[1], 3),
                }
                out[it["pid"]] = rec
                con.execute("insert or replace into r values (?,?,?,?)", (it["pid"], it["url"], VERSION, json.dumps(rec)))
            con.commit()
        print(f"embed: {len(todo) - failed} read now, {len(items) - len(todo)} cached, {failed} failed", file=sys.stderr)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()

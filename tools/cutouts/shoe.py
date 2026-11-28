"""Stage 1 of the cut-out: find the SNEAKER, and only the sneaker.

Junid's product photos are shot in the shop: the shoe stands on a white
display riser, its box is mounted on the striped wall above it, and some are a
pair held in a hand. A whole-object background remover (rembg) keeps all of
that. So the cut-out is two stages:

  1. CLIPSeg (CIDAS/clipseg-rd64-refined, transformers, local CPU) is asked
     for "a sneaker" / "a shoe". The largest confident region is the shoe; it
     is dilated slightly and everything else (box, lid, riser, shelf, hand,
     tissue) is masked out.
  2. rembg runs on that isolated crop for a clean edge, and its alpha is
     intersected with the dilated shoe mask so nothing outside the shoe can
     come back.

Then a deterministic quality gate (quality_gate) judges the finished mask —
fragments, solidity, size, shape, box remnants, holes — and a CLIP zero-shot
check judges the picture. A cut-out that fails is retried once tighter; if it
still fails the product keeps its ORIGINAL photo (cutout.py writes
photoCutoutQuality "rejected" and no URL). There is no whole-object fallback.

Pure functions take numpy arrays so they test without the model.
"""
import numpy as np

CLIPSEG_MODEL = "CIDAS/clipseg-rd64-refined"
PROMPTS = ("a sneaker", "a shoe")
# What the shop photos put AROUND the shoe. A pixel stays only where "shoe"
# outscores every one of these — the riser the shoe stands on scores high for
# "shoe" on its own (it is shoe-shaped and touches it), but higher still here.
NEGATIVE_PROMPTS = ("a white display stand", "a shoe box", "a shelf", "a hand")

# Can stage 1 find a shoe at all? (pre_gate)
MIN_CONFIDENCE = 0.60              # peak CLIPSeg probability inside the shoe region
SECOND_REGION_RATIO = 0.45         # a second region this large vs the first = two shoes
SECOND_REGION_MIN_FRACTION = 0.01  # ...and at least 1% of the image (ignore specks)
MASK_THRESHOLD = 0.50              # probability that counts as "shoe" for the mask
DILATE_FRACTION = 0.006            # dilation radius as a fraction of the longer side
CROP_MARGIN = 0.06                 # margin around the shoe box before rembg
CORE_THRESHOLD = 0.70              # CLIPSeg this sure = inside the shoe: forced opaque
CORE_ERODE_FRACTION = 0.012        # ...after eroding the core this far from its edge
# For the box-remnant rule, "the shoe mask in the CLIPSeg stage" is where
# CLIPSeg is nearly as sure as at the shoe's own peak. A riser's black label
# under the sole scores ~0.80 against the shoe's ~0.90 (SB Dunk p1781649925620);
# a fixed 0.70 would call it shoe.
SURE_OF_PEAK = 0.92
SURE_MARGIN_FRACTION = 0.025       # ...widened this far (of the longer side) at its edge


class ClipSeg:
    """CLIPSeg with one model load per run."""

    def __init__(self, model=CLIPSEG_MODEL):
        self.model_name = model
        self._model = None
        self._proc = None

    def _load(self):
        if self._model is None:
            import torch  # noqa: F401
            from transformers import CLIPSegForImageSegmentation, CLIPSegProcessor
            self._proc = CLIPSegProcessor.from_pretrained(self.model_name)
            self._model = CLIPSegForImageSegmentation.from_pretrained(self.model_name).eval()

    def maps(self, img, prompts):
        """Probability maps (len(prompts), H, W) float32 in [0,1] at the
        image's own size."""
        import torch
        from PIL import Image
        self._load()
        rgb = img.convert("RGB")
        inputs = self._proc(text=list(prompts), images=[rgb] * len(prompts), padding=True, return_tensors="pt")
        with torch.no_grad():
            try:
                logits = self._model(**inputs, interpolate_pos_encoding=True).logits
            except TypeError:  # older transformers: no such argument, 352 is native
                logits = self._model(**inputs).logits
        if logits.dim() == 2:   # a single prompt comes back (352, 352)
            logits = logits.unsqueeze(0)
        out = []
        for m in torch.sigmoid(logits).numpy():
            small = Image.fromarray((m * 255).astype(np.uint8))
            out.append(np.asarray(small.resize(rgb.size, Image.BILINEAR), dtype=np.float32) / 255.0)
        return np.stack(out)

    def __call__(self, img):
        """The shoe probability (H, W): max over the shoe prompts, zeroed
        wherever a surrounding object (stand, box, shelf, hand) scores higher."""
        m = self.maps(img, PROMPTS + NEGATIVE_PROMPTS)
        shoe_p = m[:len(PROMPTS)].max(axis=0)
        other = m[len(PROMPTS):].max(axis=0)
        return np.where(shoe_p >= other, shoe_p, 0.0).astype(np.float32)


def regions(prob, threshold=MASK_THRESHOLD):
    """Connected regions of prob >= threshold, largest first:
    [(mask(bool HxW), area_px, peak_prob, bbox(x0,y0,x1,y1))]."""
    from scipy import ndimage
    binary = prob >= threshold
    labels, n = ndimage.label(binary)
    out = []
    if n == 0:
        return out
    areas = ndimage.sum(binary, labels, index=np.arange(1, n + 1))
    peaks = ndimage.maximum(prob, labels, index=np.arange(1, n + 1))
    objs = ndimage.find_objects(labels)
    for i in np.argsort(areas)[::-1]:
        sl = objs[i]
        bbox = (sl[1].start, sl[0].start, sl[1].stop, sl[0].stop)
        out.append((labels == (i + 1), int(areas[i]), float(peaks[i]), bbox))
    return out


def pre_gate(regs, image_size):
    """Did CLIPSeg find a shoe at all? Returns (ok, reason, stats).
    Everything about the QUALITY of the result is quality_gate's job."""
    w, h = image_size
    total = float(w * h)
    if not regs:
        return False, "no-shoe", {}
    _, area, peak, (x0, y0, x1, y1) = regs[0]
    stats = {"clip_area": round(area / total, 4), "peak": round(peak, 3),
             "second": round(regs[1][1] / total, 4) if len(regs) > 1 else 0.0}
    if peak < MIN_CONFIDENCE:
        return False, "low-confidence", stats
    return True, "shoe", stats


def pick_shoes(regs, image_size):
    """The shoe region, plus a second one when the photo is a PAIR: at least
    45% the size of the first and at least 1% of the image."""
    total = float(image_size[0] * image_size[1])
    picked = [regs[0]]
    if len(regs) > 1 and regs[1][1] >= SECOND_REGION_RATIO * regs[0][1] and regs[1][1] >= SECOND_REGION_MIN_FRACTION * total:
        picked.append(regs[1])
    return picked


def dilate(mask, image_size, fraction=DILATE_FRACTION):
    from scipy import ndimage
    r = max(1, int(round(fraction * max(image_size))))
    return ndimage.binary_dilation(mask, iterations=r)


def crop_box(bbox, image_size, margin=CROP_MARGIN):
    w, h = image_size
    x0, y0, x1, y1 = bbox
    m = int(round(margin * max(x1 - x0, y1 - y0)))
    return max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)


def union_bbox(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


class Isolated:
    """One attempt at the shoe: the cut (RGBA crop, untrimmed) and, for the
    gate, the crop's RGB, the CLIPSeg shoe mask over the crop and the image size."""

    def __init__(self, rgba=None, reason="", stats=None, crop_rgb=None, clip_mask=None, image_size=None):
        self.rgba, self.reason, self.stats = rgba, reason, stats or {}
        self.crop_rgb, self.clip_mask, self.image_size = crop_rgb, clip_mask, image_size


def isolate_shoe(img, prob, remover, threshold=MASK_THRESHOLD, erode_px=0):
    """Stage 1 + 2 for one photo -> Isolated. rgba is None when no shoe was
    found. threshold / erode_px are the RETRY's knobs: a tighter CLIPSeg
    threshold and the keep-mask eroded erode_px pixels."""
    from PIL import Image
    from scipy import ndimage
    rgb = img.convert("RGB")
    regs = regions(prob, threshold)
    ok, reason, stats = pre_gate(regs, rgb.size)
    if not ok:
        return Isolated(None, reason, stats, image_size=rgb.size)
    picked = pick_shoes(regs, rgb.size)
    clip = picked[0][0] if len(picked) == 1 else (picked[0][0] | picked[1][0])
    keep = dilate(clip, rgb.size)
    if erode_px:
        keep = ndimage.binary_erosion(keep, iterations=int(erode_px))
    box = crop_box(union_bbox([r[3] for r in picked]), rgb.size)
    # rembg sees the REAL crop (a white fill made it keep wall mesh in the
    # band around the shoe); the shoe mask then hard-clips its alpha.
    crop = rgb.crop(box)
    cut = remover(crop).convert("RGBA")
    a = np.asarray(cut.getchannel("A"), dtype=np.float32)
    k = keep[box[1]:box[3], box[0]:box[2]].astype(np.float32)
    # rembg decides the EDGE; it does not get to thin the inside. On a dark
    # shoe against the dark mesh, or a silver upper, its alpha inside the
    # shoe drops to half and the room shows through. Where CLIPSeg is sure
    # (the core, eroded back from its own edge) the shoe is fully opaque.
    core = np.zeros_like(clip)
    for r in picked:
        core |= core_mask(prob, r[0], rgb.size, threshold=max(CORE_THRESHOLD, threshold + 0.1))
    core = core[box[1]:box[3], box[0]:box[2]] & (k > 0)
    alpha = np.maximum(a * k, core.astype(np.float32) * 255.0)
    out = np.asarray(cut).copy()
    out[..., :3] = np.asarray(crop)   # the photo's own colours, never rembg's premultiplied edge
    out[..., 3] = largest_piece(np.clip(alpha, 0, 255), keep_n=len(picked)).astype(np.uint8)
    # "The shoe mask in the CLIPSeg stage", for the box-remnant rule: where
    # CLIPSeg is CONFIDENT it is shoe (>= CORE_THRESHOLD, not eroded). A box
    # fragment that rode into the region at 0.50-0.70 is not in it; a black
    # sole is.
    peak = max(r[2] for r in picked)
    sure = (prob >= max(CORE_THRESHOLD, threshold, SURE_OF_PEAK * peak)) & clip
    if SURE_MARGIN_FRACTION:   # CLIPSeg's map is coarse: its edge stops short of a black sole's bottom edge
        sure = dilate(sure, rgb.size, SURE_MARGIN_FRACTION)
    return Isolated(Image.fromarray(out, "RGBA"), reason, stats, crop_rgb=np.asarray(crop),
                    clip_mask=sure[box[1]:box[3], box[0]:box[2]], image_size=rgb.size)


def largest_piece(alpha, keep_n=1):
    """Keep the largest solid piece of the cut-out (two for a pair) and its
    soft edge, and drop every detached fragment — a riser's label under the
    sole, the half of a second shoe at the frame edge."""
    from scipy import ndimage
    solid = alpha >= 128
    labels, n = ndimage.label(solid)
    if n <= keep_n:
        return alpha
    sizes = ndimage.sum(solid, labels, index=np.arange(1, n + 1))
    main = np.isin(labels, np.argsort(sizes)[::-1][:keep_n] + 1)
    near = ndimage.binary_dilation(main, iterations=3)
    return np.where(near, alpha, 0)


def core_mask(prob, region, image_size, threshold=CORE_THRESHOLD, erode=CORE_ERODE_FRACTION):
    """The confident inside of the chosen shoe region (bool HxW)."""
    from scipy import ndimage
    r = max(1, int(round(erode * max(image_size))))
    return ndimage.binary_erosion((prob >= threshold) & region, iterations=r)


# ------------------------------------------------------------ the quality gate
#
# Junid's rules, 2026-11-03. Deterministic, on the finished mask, before any
# upload. Each rule has a name that goes into the log and the audit sheet.

GATE = {
    "max_components": 2,          # > 2 pieces above 3% of the mask (2 allowed: a pair)
    "component_min_share": 0.03,
    "min_solidity": 0.80,         # largest piece's area / its convex hull area
    # Largest piece vs the PHOTO. Junid's number is 0.10; on these shop photos
    # (a riser shot, the shoe ~1/3 of the frame's width) a perfectly cut
    # sneaker is 6-10% of the photo — the median is 9.8% — so 0.10 rejected
    # ~58% of good footwear in calibration (3 Nov). 0.06 still rejects the
    # fragment cuts. --area 0.10 restores his number.
    "min_area_fraction": 0.06,
    "aspect_min": 0.9,            # bbox w/h of a side-profile shoe
    "aspect_max": 3.2,
    "remnant_rows": 0.20,         # bottom 20% of the mask's rows...
    "remnant_max": 0.15,          # ...<= 15% dark pixels CLIPSeg did not call shoe,
    "remnant_span": 0.45,         # ...when those rows span < 45% of the mask's width (a stem under the shoe, not a sole)
    "dark_luma": 60,              # "dark" = luma below this (0-255)
    "max_hole_share": 0.04,       # no enclosed hole above 4% of the mask
    "clip_margin": 0.15,          # P(clean) - P(damaged) at least this
}
# One step looser on solidity and aspect only (Junid: if more than 25% of
# footwear is rejected, loosen these two by one step, once).
GATE_LOOSE_STEP = {"min_solidity": 0.75, "aspect_min": 0.8, "aspect_max": 3.6}

GATE_ANALYSIS_SIDE = 800          # measure on the mask scaled to this longest side


def _hull_area(mask):
    """Convex hull area (px) of a bool mask, from its boundary pixels."""
    from scipy import ndimage
    from scipy.spatial import ConvexHull, QhullError
    edge = mask & ~ndimage.binary_erosion(mask)
    ys, xs = np.nonzero(edge)
    if len(xs) < 3:
        return float(mask.sum())
    pts = np.column_stack([xs, ys]).astype(np.float64)
    try:
        return float(ConvexHull(pts).volume) + 0.5 * len(pts) ** 0.5  # + half-pixel rim
    except QhullError:
        return float(mask.sum())


def mask_metrics(alpha, crop_rgb, clip_mask, image_size, params=None):
    """Every number the gate reads, from the finished alpha (crop coords)."""
    from PIL import Image
    from scipy import ndimage
    P = dict(GATE, **(params or {}))
    mask = np.asarray(alpha) >= 128
    h, w = mask.shape
    s = min(1.0, GATE_ANALYSIS_SIDE / float(max(h, w)))
    if s < 1.0:   # measure small: the same shares, a fraction of the work
        size = (max(1, int(w * s)), max(1, int(h * s)))
        mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).resize(size, Image.NEAREST)) >= 128
        clip_mask = np.asarray(Image.fromarray(clip_mask.astype(np.uint8) * 255).resize(size, Image.NEAREST)) >= 128
        crop_rgb = np.asarray(Image.fromarray(crop_rgb).resize(size, Image.BILINEAR))
    area = float(mask.sum())
    if area == 0:
        return {"empty": True}
    labels, n = ndimage.label(mask)
    sizes = ndimage.sum(mask, labels, index=np.arange(1, n + 1)) if n else np.array([0.0])
    big = int((sizes > P["component_min_share"] * area).sum())
    largest = labels == (int(np.argmax(sizes)) + 1)
    largest_area = float(largest.sum())
    solidity = largest_area / max(1.0, _hull_area(largest))
    ys, xs = np.nonzero(mask)
    bw, bh = xs.max() - xs.min() + 1, ys.max() - ys.min() + 1
    # Box remnant: in the bottom rows of the mask, dark pixels CLIPSeg never
    # called shoe — the black box / riser edge under a sole.
    y_cut = ys.max() + 1 - max(1, int(round(P["remnant_rows"] * bh)))
    band = mask.copy()
    band[:y_cut] = False
    luma = crop_rgb[..., 0] * 0.299 + crop_rgb[..., 1] * 0.587 + crop_rgb[..., 2] * 0.114
    remnant = float((band & (luma < P["dark_luma"]) & ~clip_mask).sum()) / max(1.0, float(band.sum()))
    # How wide are those bottom rows? A sole runs the shoe's length; a riser
    # label or box hanging under the shoe is a narrow stem. Black shoes on the
    # black mesh wall have dark soles CLIPSeg is unsure of — span tells them apart.
    bx = np.nonzero(band.any(axis=0))[0]
    span = (bx.max() - bx.min() + 1) / float(bw) if len(bx) else 1.0
    holes = ndimage.binary_fill_holes(mask) & ~mask
    hl, hn = ndimage.label(holes)
    hole = float(ndimage.sum(holes, hl, index=np.arange(1, hn + 1)).max()) / area if hn else 0.0
    img_area = float(image_size[0] * image_size[1]) * (s * s)
    return {"components": big, "solidity": round(solidity, 3),
            "area_fraction": round(largest_area / img_area, 4),
            "aspect": round(bw / float(bh), 3), "remnant": round(remnant, 3), "span": round(span, 3),
            "hole": round(hole, 4)}


def judge_metrics(m, params=None):
    """(ok, failing_rule) for mask_metrics(), rules in Junid's order."""
    P = dict(GATE, **(params or {}))
    if m.get("empty"):
        return False, "empty"
    if m["components"] > P["max_components"]:
        return False, "components"
    if m["solidity"] < P["min_solidity"]:
        return False, "solidity"
    if m["area_fraction"] < P["min_area_fraction"]:
        return False, "area"
    if not (P["aspect_min"] <= m["aspect"] <= P["aspect_max"]):
        return False, "aspect"
    if m["remnant"] > P["remnant_max"] and m.get("span", 0.0) < P["remnant_span"]:
        return False, "box-remnant"
    if m["hole"] > P["max_hole_share"]:
        return False, "hole"
    return True, ""


def quality_gate(iso, judge=None, params=None):
    """The whole gate for one Isolated: (ok, rule, metrics). judge is a
    ClipJudge (or any callable rgba -> margin); None skips the CLIP check."""
    P = dict(GATE, **(params or {}))
    if iso.rgba is None:
        return False, iso.reason, dict(iso.stats)
    m = mask_metrics(iso.rgba.getchannel("A"), iso.crop_rgb, iso.clip_mask, iso.image_size, params)
    m.update(iso.stats)
    ok, rule = judge_metrics(m, params)
    if not ok:
        return False, rule, m
    if judge is not None:
        m["clip"] = round(float(judge(iso.rgba)), 3)
        if m["clip"] < P["clip_margin"]:
            return False, "clip", m
    return True, "", m


CLIP_PROMPTS = ("a clean product photo of a single shoe on a plain background",
                "a damaged image with fragments and cut-off pieces")


def on_plain(rgba, bg=(255, 255, 255), side=None):
    """The cut-out composited on a plain background, square-padded."""
    from PIL import Image
    a = rgba.getchannel("A")
    bbox = a.getbbox() or (0, 0, rgba.width, rgba.height)
    obj = rgba.crop(bbox)
    n = int(max(obj.size) * 1.12)
    out = Image.new("RGB", (n, n), bg)
    out.paste(obj, ((n - obj.width) // 2, (n - obj.height) // 2), obj)
    return out.resize((side, side)) if side else out


class ClipJudge:
    """Zero-shot CLIP: P(clean single shoe) - P(damaged, fragments). Uses the
    CLIP inside CLIPSeg (same weights, already downloaded) — no second model."""

    def __init__(self, clipseg):
        self.seg = clipseg
        self._text = None

    def __call__(self, rgba):
        import torch
        self.seg._load()
        model, proc = self.seg._model.clip, self.seg._proc
        with torch.no_grad():
            if self._text is None:
                t = proc.tokenizer(list(CLIP_PROMPTS), padding=True, return_tensors="pt")
                f = model.get_text_features(**t)
                f = getattr(f, "pooler_output", f)
                self._text = f / f.norm(dim=-1, keepdim=True)
            px = proc.image_processor(images=[on_plain(rgba)], return_tensors="pt")["pixel_values"]
            try:
                f = model.get_image_features(pixel_values=px, interpolate_pos_encoding=True)
            except TypeError:
                f = model.get_image_features(pixel_values=px)
            f = getattr(f, "pooler_output", f)
            f = f / f.norm(dim=-1, keepdim=True)
            logits = model.logit_scale.exp() * f @ self._text.T
            p = logits.softmax(dim=-1)[0]
        return float(p[0] - p[1])

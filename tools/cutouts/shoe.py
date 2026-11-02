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

A quality gate decides whether stage 1 can be trusted for a photo; when it
cannot, the caller writes the whole-object rembg cut-out instead and marks it
photoCutoutQuality "fallback" (cutout.py).

Pure functions take numpy arrays so they test without the model.
"""
import numpy as np

CLIPSEG_MODEL = "CIDAS/clipseg-rd64-refined"
PROMPTS = ("a sneaker", "a shoe")
# What the shop photos put AROUND the shoe. A pixel stays only where "shoe"
# outscores every one of these — the riser the shoe stands on scores high for
# "shoe" on its own (it is shoe-shaped and touches it), but higher still here.
NEGATIVE_PROMPTS = ("a white display stand", "a shoe box", "a shelf", "a hand")

# The quality gate (Junid's spec, 2026-11-02). See gate() for how each is read.
MIN_SHOE_BBOX_FRACTION = 0.12      # the shoe's box must cover >= 12% of the image
MIN_CONFIDENCE = 0.60              # peak CLIPSeg probability inside the shoe region
SECOND_REGION_RATIO = 0.45         # a second region this large vs the first = two shoes
SECOND_REGION_MIN_FRACTION = 0.01  # ...and at least 1% of the image (ignore specks)
MASK_THRESHOLD = 0.50              # probability that counts as "shoe" for the mask
DILATE_FRACTION = 0.006            # dilation radius as a fraction of the longer side
CROP_MARGIN = 0.06                 # margin around the shoe box before rembg
CORE_THRESHOLD = 0.70              # CLIPSeg this sure = inside the shoe: forced opaque
CORE_ERODE_FRACTION = 0.012        # ...after eroding the core this far from its edge


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


def gate(regs, image_size):
    """Can stage 1 be trusted? Returns (ok, reason, stats).

    - "under 12% of the image": the shoe region's BOUNDING BOX against the image
      area. A sneaker is long and low — on these riser shots its pixels are ~6%
      of the frame even when found perfectly, so a pixel-count gate would throw
      away every good result; the box is what the spec's number describes (a
      shoe that fills a reasonable part of the photo).
    - "less than 60% confidence": the PEAK CLIPSeg probability in the region.
    - "more than one large shoe region": a second region at least 45% the size
      of the first (and >= 1% of the image) — a pair, or a shoe and a box logo.
    """
    w, h = image_size
    total = float(w * h)
    if not regs:
        return False, "no-shoe", {}
    mask, area, peak, (x0, y0, x1, y1) = regs[0]
    bbox_frac = (x1 - x0) * (y1 - y0) / total
    stats = {"area": round(area / total, 4), "bbox": round(bbox_frac, 4), "peak": round(peak, 3),
             "second": round(regs[1][1] / total, 4) if len(regs) > 1 else 0.0}
    if bbox_frac < MIN_SHOE_BBOX_FRACTION:
        return False, "small", stats
    if peak < MIN_CONFIDENCE:
        return False, "low-confidence", stats
    if len(regs) > 1 and regs[1][1] >= SECOND_REGION_RATIO * area and regs[1][1] >= SECOND_REGION_MIN_FRACTION * total:
        return False, "two-shoes", stats
    return True, "shoe", stats


def dilate(mask, image_size, fraction=DILATE_FRACTION):
    from scipy import ndimage
    r = max(1, int(round(fraction * max(image_size))))
    return ndimage.binary_dilation(mask, iterations=r)


def crop_box(bbox, image_size, margin=CROP_MARGIN):
    w, h = image_size
    x0, y0, x1, y1 = bbox
    m = int(round(margin * max(x1 - x0, y1 - y0)))
    return max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)


def isolate_shoe(img, prob, remover):
    """Stage 1 + 2 for one photo. Returns (rgba_or_None, reason, stats).
    rgba is the shoe alone (background transparent), not yet trimmed."""
    from PIL import Image
    rgb = img.convert("RGB")
    regs = regions(prob)
    ok, reason, stats = gate(regs, rgb.size)
    if not ok:
        return None, reason, stats
    keep = dilate(regs[0][0], rgb.size)
    box = crop_box(regs[0][3], rgb.size)
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
    core = core_mask(prob, regs[0][0], rgb.size)[box[1]:box[3], box[0]:box[2]]
    alpha = np.maximum(a * k, core.astype(np.float32) * 255.0)
    out = np.asarray(cut).copy()
    out[..., :3] = np.asarray(crop)   # the photo's own colours, never rembg's premultiplied edge
    out[..., 3] = largest_piece(np.clip(alpha, 0, 255)).astype(np.uint8)
    return Image.fromarray(out, "RGBA"), reason, stats


def largest_piece(alpha):
    """Keep the largest solid piece of the cut-out (and its soft edge) and
    drop every detached fragment — a riser's label under the sole, the half
    of a second shoe at the frame edge."""
    from scipy import ndimage
    solid = alpha >= 128
    labels, n = ndimage.label(solid)
    if n <= 1:
        return alpha
    sizes = ndimage.sum(solid, labels, index=np.arange(1, n + 1))
    main = labels == (int(np.argmax(sizes)) + 1)
    near = ndimage.binary_dilation(main, iterations=3)
    return np.where(near, alpha, 0)


def core_mask(prob, region, image_size, threshold=CORE_THRESHOLD, erode=CORE_ERODE_FRACTION):
    """The confident inside of the chosen shoe region (bool HxW)."""
    from scipy import ndimage
    r = max(1, int(round(erode * max(image_size))))
    return ndimage.binary_erosion((prob >= threshold) & region, iterations=r)

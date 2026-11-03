"""Tests for cutout.py — no network. Run from tools/cutouts:

    python -m pytest -q          or          python -m unittest -v test_cutout

The rembg integration test runs only when rembg is importable (first run
downloads the model to ~/.u2net)."""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import unquote

from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cutout  # noqa: E402

TESTDATA = HERE / "testdata"
SNEAKER = TESTDATA / "sneaker-studio.jpg"
OFFCENTRE = TESTDATA / "offcentre-textured.jpg"

# Object regions (x0, y0, x1, y1) the integration test checks for opacity.
SNEAKER_CORE = (150, 190, 330, 250)
OFFCENTRE_CORE = (300, 120, 390, 230)


def make_samples(force=False):
    """The two sample photos (deterministic). Committed; regenerated if missing."""
    import random
    TESTDATA.mkdir(exist_ok=True)
    if force or not SNEAKER.exists():
        w, h = 480, 360
        bg = Image.new("RGB", (w, h))
        d = ImageDraw.Draw(bg)
        for y in range(h):  # white -> light grey studio sweep
            g = int(250 - 22 * y / h)
            d.line([(0, y), (w, y)], fill=(g, g, g))
        shadow = Image.new("L", (w, h), 0)
        ImageDraw.Draw(shadow).ellipse((90, 268, 400, 300), fill=90)
        bg.paste((150, 150, 150), (0, 0), shadow.filter(ImageFilter.GaussianBlur(10)))
        d = ImageDraw.Draw(bg)
        # upper: a low-top sneaker silhouette, dark charcoal
        d.polygon([(100, 250), (120, 190), (190, 175), (250, 150), (300, 140),
                   (330, 170), (380, 215), (395, 250)], fill=(35, 35, 40))
        d.rounded_rectangle((92, 245, 402, 278), radius=12, fill=(235, 235, 230))  # sole
        d.line([(95, 262), (398, 262)], fill=(60, 60, 60), width=3)               # midsole line
        for i in range(5):                                                         # laces
            x = 205 + 18 * i
            d.line([(x, 168 - 4 * i), (x + 14, 190 - 4 * i)], fill=(240, 240, 240), width=4)
        d.ellipse((285, 200, 325, 225), fill=(200, 30, 40))                        # logo
        bg.save(str(SNEAKER), quality=90)
    if force or not OFFCENTRE.exists():
        rnd = random.Random(7)
        w, h = 480, 360
        bg = Image.new("RGB", (w, h), (214, 200, 178))
        px = bg.load()
        for y in range(h):  # slight fabric texture
            for x in range(w):
                n = rnd.randint(-10, 10) + (6 if (x // 3 + y // 3) % 2 else -6)
                r, g, b = px[x, y]
                px[x, y] = (r + n, g + n, b + n)
        bg = bg.filter(ImageFilter.GaussianBlur(0.6))
        d = ImageDraw.Draw(bg)
        d.rounded_rectangle((290, 90, 400, 300), radius=18, fill=(25, 60, 160))    # bottle body
        d.rectangle((320, 55, 370, 92), fill=(20, 20, 20))                          # cap
        d.rectangle((300, 160, 390, 205), fill=(245, 245, 245))                     # label
        bg.save(str(OFFCENTRE), quality=90)


def rgba_with_box(size, box, colour=(10, 10, 10, 255)):
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(img).rectangle(box, fill=colour)
    return img


class TrimPad(unittest.TestCase):
    def test_bbox_and_six_percent_padding(self):
        img = rgba_with_box((500, 400), (100, 50, 299, 149))  # object 200 x 100
        out = cutout.trim_and_pad(img)
        pad = round(0.06 * 200)  # 12, of the LONGER side
        self.assertEqual(out.size, (200 + 2 * pad, 100 + 2 * pad))
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.getchannel("A").getbbox(), (pad, pad, pad + 200, pad + 100))

    def test_tall_object_pads_by_height(self):
        out = cutout.trim_and_pad(rgba_with_box((300, 600), (10, 10, 59, 509)))  # 50 x 500
        self.assertEqual(out.size, (50 + 60, 500 + 60))

    def test_padding_is_transparent_and_object_opaque(self):
        out = cutout.trim_and_pad(rgba_with_box((300, 300), (40, 40, 139, 139)))
        a = out.getchannel("A")
        for xy in [(0, 0), (out.width - 1, 0), (0, out.height - 1), (out.width - 1, out.height - 1)]:
            self.assertEqual(a.getpixel(xy), 0)
        self.assertEqual(a.getpixel((out.width // 2, out.height // 2)), 255)

    def test_faint_alpha_noise_ignored_for_bbox(self):
        img = rgba_with_box((400, 400), (150, 150, 249, 249))
        img.putpixel((2, 2), (0, 0, 0, 5))  # below threshold: not part of the object
        out = cutout.trim_and_pad(img)
        self.assertEqual(out.size, (112, 112))

    def test_empty_alpha_raises(self):
        with self.assertRaises(cutout.EmptyCutout):
            cutout.trim_and_pad(Image.new("RGBA", (50, 50), (0, 0, 0, 0)))

    def test_rgb_input_converted(self):
        out = cutout.trim_and_pad(Image.new("RGB", (40, 20), (1, 2, 3)))
        self.assertEqual(out.mode, "RGBA")
        self.assertEqual(out.size, (40 + 2 * 2, 20 + 2 * 2))  # round(2.4) = 2

    def test_limit_size_and_png_keeps_alpha(self):
        big = cutout.limit_size(rgba_with_box((3000, 1500), (0, 0, 2999, 1499)), 1600)
        self.assertEqual(big.size, (1600, 800))
        same = rgba_with_box((100, 50), (0, 0, 10, 10))
        self.assertIs(cutout.limit_size(same, 1600), same)
        self.assertIs(cutout.limit_size(same, 0), same)
        back = Image.open(io.BytesIO(cutout.png_bytes(same)))
        self.assertEqual(back.format, "PNG")
        self.assertEqual(back.mode, "RGBA")


class Naming(unittest.TestCase):
    URL = "https://firebasestorage.googleapis.com/v0/b/x/o/products%2Fp1%2Fphoto.jpg?alt=media&token=t"

    def test_short_hash_stable_and_photo_specific(self):
        h = cutout.short_hash(self.URL)
        self.assertEqual(len(h), 10)
        self.assertEqual(h, cutout.short_hash(self.URL))
        self.assertNotEqual(h, cutout.short_hash(self.URL + "2"))

    def test_storage_path(self):
        self.assertEqual(cutout.cutout_storage_path("-Nabc", self.URL),
                         "products/-Nabc/cutout-%s.png" % cutout.short_hash(self.URL))

    def test_download_url(self):
        u = cutout.download_url("marathon-club.firebasestorage.app", "products/-Nabc/cutout-0123456789.png", "tok-1")
        self.assertEqual(u, "https://firebasestorage.googleapis.com/v0/b/marathon-club.firebasestorage.app/o/"
                            "products%2F-Nabc%2Fcutout-0123456789.png?alt=media&token=tok-1")
        self.assertEqual(unquote(u.split("/o/")[1].split("?")[0]), "products/-Nabc/cutout-0123456789.png")

    def test_database_url_matches_src_firebase_js(self):
        src = (HERE.parents[1] / "src" / "firebase.js").read_text()
        self.assertIn('databaseURL: "%s"' % cutout.DATABASE_URL, src)
        self.assertIn('storageBucket: "%s"' % cutout.BUCKET, src)

    def test_update_payload_has_exactly_three_keys(self):
        p = cutout.build_update("-Nabc", "https://cut", self.URL, "shoe")
        self.assertEqual(p, {"products/-Nabc/photoCutoutUrl": "https://cut",
                             "products/-Nabc/photoCutoutFor": self.URL,
                             "products/-Nabc/photoCutoutQuality": "shoe"})
        self.assertEqual(len(p), 3)
        with self.assertRaises(ValueError):
            cutout.build_update("-Nabc", "https://cut", self.URL, "great")


def row(pid, url="u", ts=None, cfor=None, curl=None, q="shoe"):
    return {"id": pid, "photoUrl": url, "photoUpdatedAt": ts, "photoCutoutFor": cfor, "photoCutoutUrl": curl,
            "photoCutoutQuality": q if curl else None}


def fw(r, cat="Footwear"):
    r["category"] = cat
    return r


V = cutout.GATE_VERSION
judged = lambda i, u: V   # the local state recorded this gate for every photo


class Selection(unittest.TestCase):
    def test_current_skipped_stale_redone_missing_photo_skipped(self):
        rows = [fw(row("a", "u1", cfor="u1", curl="c")),   # current
                fw(row("b", "u2", cfor="old", curl="c")),  # stale: photo changed
                fw(row("c", "u3", cfor="u3", curl=None)),  # for set but url gone, no "rejected"
                fw(row("d", None)),                        # no photo
                fw(row("e", ""))]
        todo, clear, counts = cutout.select_candidates(rows, lambda i, u: 0, judged)
        self.assertEqual(sorted(r["id"] for r in todo), ["b", "c"])
        self.assertEqual(clear, [])
        self.assertEqual((counts["current"], counts["no_photo"], counts["todo"]), (1, 2, 2))

    def test_rejection_without_url_is_current(self):
        r = fw(row("a", "u1", cfor="u1")); r["photoCutoutQuality"] = "rejected"
        self.assertEqual(cutout.select_candidates([r], lambda i, u: 0, judged)[0], [])
        # ...but a "rejected" that still carries a URL is not
        r["photoCutoutUrl"] = "c"
        self.assertEqual(len(cutout.select_candidates([r], lambda i, u: 0, judged)[0]), 1)

    def test_earlier_gates_are_re_audited(self):
        """v2 "shoe" / "fallback" / v1 none: all judged again by this gate."""
        rows = [fw(row("s", "u1", cfor="u1", curl="c", q="shoe")),
                fw(row("f", "u2", cfor="u2", curl="c", q="fallback")),
                fw(row("v1", "u3", cfor="u3", curl="c"))]
        rows[2]["photoCutoutQuality"] = None
        todo, _, _ = cutout.select_candidates(rows, lambda i, u: 0, lambda i, u: 2)
        self.assertEqual(sorted(r["id"] for r in todo), ["f", "s", "v1"])
        todo, _, _ = cutout.select_candidates(rows, lambda i, u: 0, judged)
        self.assertEqual(sorted(r["id"] for r in todo), ["f", "v1"])  # "fallback" is never current

    def test_only_footwear_is_cut_and_the_rest_is_cleared(self):
        rows = [fw(row("perfume", "u1", cfor="u1", curl="c", q="shoe"), "Perfume"),
                fw(row("tee", "u2", cfor="u2", curl="c", q="fallback"), "Clothing"),
                fw(row("bag", "u3"), "Accessories"),           # nothing to clear
                fw(row("nocat", "u4"), None),                   # no category: not footwear
                fw(row("boot", "u5"))]
        todo, clear, counts = cutout.select_candidates(rows, lambda i, u: 0, judged)
        self.assertEqual([r["id"] for r in todo], ["boot"])
        self.assertEqual(sorted(clear), ["perfume", "tee"])
        self.assertEqual(counts["not_footwear"], 2)

    def test_newest_first(self):
        rows = [fw(row(i, ts=t)) for i, t in [("-Na", None), ("-Nc", None), ("x", 100), ("y", 300), ("-Nb", None), ("z", "200")]]
        todo, _, _ = cutout.select_candidates(rows, lambda i, u: 0)
        self.assertEqual([r["id"] for r in todo], ["y", "z", "x", "-Nc", "-Nb", "-Na"])

    def test_failure_cap_per_photo(self):
        attempts = {("a", "u1"): 3, ("b", "u2"): 2, ("c", "new"): 0}
        rows = [fw(row("a", "u1")), fw(row("b", "u2")), fw(row("c", "new"))]
        todo, _, counts = cutout.select_candidates(rows, lambda i, u: attempts.get((i, u), 0))
        self.assertEqual(sorted(r["id"] for r in todo), ["b", "c"])
        self.assertEqual(counts["gave_up"], 1)

    def test_updates_are_exactly_three_fields(self):
        self.assertEqual(cutout.build_update("p", None, "u", "rejected"),
                         {"products/p/photoCutoutUrl": None, "products/p/photoCutoutFor": "u",
                          "products/p/photoCutoutQuality": "rejected"})
        with self.assertRaises(ValueError):
            cutout.build_update("p", "c", "u", "rejected")
        with self.assertRaises(ValueError):
            cutout.build_update("p", "c", "u", "fallback")
        self.assertEqual(set(cutout.build_clear(["p"]).values()), {None})
        self.assertEqual(len(cutout.build_clear(["p", "q"])), 6)


class StateFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = cutout.State(Path(self.tmp.name) / "s.sqlite")

    def tearDown(self):
        self.state.db.close()
        self.tmp.cleanup()

    def test_failures_count_up_and_reset_on_done(self):
        self.assertEqual(self.state.attempts("a", "u"), 0)
        self.assertEqual(self.state.mark_failed("a", "u", "boom"), 1)
        self.assertEqual(self.state.mark_failed("a", "u", "boom"), 2)
        self.assertEqual(self.state.attempts("a", "other"), 0)  # a new photo starts at 0
        self.state.mark_done("a", "u", "cut")
        self.assertEqual(self.state.attempts("a", "u"), 0)

    def test_status_counts(self):
        self.state.mark_gated("c", "u3", "shoe")
        self.state.record_seen([fw(row("a", "u1")), fw(row("b", "u2")), fw(row("c", "u3", cfor="u3", curl="x")), fw(row("d", None))])
        for _ in range(3):
            self.state.mark_failed("b", "u2", "x")
        self.state.mark_failed("a", "u1", "x")
        self.state.mark_done("e", "u5", "cut")
        s = self.state.status()
        self.assertEqual(s["done"], 1)
        self.assertEqual(s["failed_gave_up"], 1)
        self.assertEqual(s["failed_retrying"], 1)
        self.assertEqual(s["pending_known"], 1)  # only a (b gave up, c valid, d no photo, e done)

    def test_lock_is_single_flight(self):
        p = Path(self.tmp.name) / "x.lock"
        a, b = cutout.SingleFlight(p), cutout.SingleFlight(p)
        self.assertTrue(a.acquire())
        self.assertFalse(b.acquire())
        a.release()
        self.assertTrue(b.acquire())
        b.release()


class FakeBackend:
    def __init__(self, products, photos):
        self.products, self.photos = products, photos
        self.updates, self.uploads, self.reads = [], [], []

    def list_product_ids(self):
        return list(self.products)

    def read_field(self, pid, field):
        self.reads.append((pid, field))
        return self.products.get(pid, {}).get(field)

    def download(self, url):
        return self.photos[url]

    def upload_png(self, path, data):
        self.uploads.append((path, data))
        return cutout.download_url(cutout.BUCKET, path, "tok")

    def update(self, payload):
        self.updates.append(payload)
        for k, v in payload.items():   # apply like RTDB (None deletes; never creates a missing product)
            _, pid, field = k.split("/")
            if pid in self.products:
                if v is None:
                    self.products[pid].pop(field, None)
                else:
                    self.products[pid][field] = v


def fake_remover(img):
    """Stand-in for rembg: dark pixels are the object."""
    rgba = img.convert("RGBA")
    rgba.putalpha(img.convert("L").point(lambda v: 255 if v < 128 else 0))
    return rgba


def dark_segmenter(img):
    """Stand-in for CLIPSeg: dark pixels are the shoe, sure of it."""
    import numpy as np
    return (np.asarray(img.convert("L"), np.float32) < 128).astype(np.float32) * 0.95


def jpeg_of(draw, size=(200, 100)):
    img = Image.new("RGB", size, (255, 255, 255))
    draw(ImageDraw.Draw(img))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=95)
    return buf.getvalue()


def jpeg_with_box():
    """A shoe-shaped (2:1) dark block, 32% of the frame: passes every rule."""
    return jpeg_of(lambda d: d.rectangle((40, 20, 159, 79), fill=(0, 0, 0)))


def jpeg_with_ring():
    """A dark frame with a big hole in it: the gate refuses (hole), the retry too."""
    def draw(d):
        d.rectangle((30, 10, 169, 89), fill=(0, 0, 0))
        d.rectangle((80, 40, 119, 59), fill=(255, 255, 255))   # 40x20: solid enough, but a 7.7% hole
    return jpeg_of(draw)


class Pass(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = cutout.State(Path(self.tmp.name) / "s.sqlite")
        self.backend = FakeBackend({
            "-Na": {"category": "Footwear", "photoUrl": "U1", "photoUpdatedAt": 10, "name": "A"},
            "-Nb": {"category": "Footwear", "photoUrl": "U2"},                           # gets a ring: rejected
            "-Nc": {"category": "Footwear", "photoUrl": "BAD", "photoUpdatedAt": 20},    # undecodable
            "-Nd": {"category": "Footwear", "name": "no photo"},
            "-Np": {"category": "Perfume", "photoUrl": "U9", "photoCutoutFor": "U9",
                    "photoCutoutUrl": "C9", "photoCutoutQuality": "shoe"},              # cleared, never cut
        }, {"U1": jpeg_with_box(), "U2": jpeg_with_ring(), "BAD": b"not an image"})

    def tearDown(self):
        self.state.db.close()
        self.tmp.cleanup()

    def run_pass(self, **kw):
        kw.setdefault("segmenter", dark_segmenter)
        return cutout.run_pass(self.backend, fake_remover, self.state, sleep=lambda s: None, **kw)

    def test_pass_cuts_rejects_and_clears(self):
        tally = self.run_pass(audit_dir=self.tmp.name + "/audit")
        self.assertEqual(tally, {"shoe": 1, "rejected": 1, "failed": 1, "cleared": 1})
        a, b, p = (self.backend.products[k] for k in ("-Na", "-Nb", "-Np"))
        self.assertEqual((a["photoCutoutQuality"], a["photoCutoutFor"]), ("shoe", "U1"))
        self.assertTrue(a["photoCutoutUrl"].startswith("https://"))
        # a rejection keeps the ORIGINAL photo: no URL, judged for this photo
        self.assertEqual((b.get("photoCutoutUrl"), b["photoCutoutQuality"], b["photoCutoutFor"]), (None, "rejected", "U2"))
        # the perfume: all three fields gone, its photo untouched, nothing uploaded for it
        self.assertEqual(p, {"category": "Perfume", "photoUrl": "U9"})
        self.assertEqual([path for path, _ in self.backend.uploads], [cutout.cutout_storage_path("-Na", "U1")])
        png = Image.open(io.BytesIO(self.backend.uploads[0][1]))
        self.assertEqual(png.mode, "RGBA")
        # never read a field outside FIELDS, and never the whole product
        self.assertTrue(all(f in cutout.FIELDS for _, f in self.backend.reads))
        # the perfume's photo was never even read
        self.assertNotIn(("-Np", "photoUrl"), self.backend.reads)
        lines = (Path(self.tmp.name) / "audit" / "audit.jsonl").read_text().splitlines()
        self.assertEqual(sorted(json.loads(l)["quality"] for l in lines), ["rejected", "shoe"])
        rej = [json.loads(l) for l in lines if '"rejected"' in l][0]
        self.assertEqual(len(rej["attempts"]), 2)                     # tried twice
        self.assertEqual(rej["attempts"][0]["rule"], "hole")

    def test_rerun_is_idempotent(self):
        self.run_pass()
        n_up = len(self.backend.updates)
        self.assertEqual(self.run_pass(), {"failed": 1})          # only BAD again
        self.assertEqual(self.run_pass(), {"gave-up": 1})
        self.assertEqual(self.run_pass(), {})
        self.assertEqual(len(self.backend.updates), n_up)         # nothing re-written

    def test_v2_cutout_that_passes_keeps_its_url(self):
        self.backend.products["-Na"].update({"photoCutoutFor": "U1", "photoCutoutUrl": "OLD", "photoCutoutQuality": "shoe"})
        tally = self.run_pass(ids=["-Na"])
        self.assertEqual(tally, {"kept": 1})
        self.assertEqual(self.backend.uploads, [])
        self.assertEqual(self.backend.updates, [])
        self.assertEqual(self.state.gated_version("-Na", "U1"), cutout.GATE_VERSION)

    def test_v2_cutout_that_fails_is_cleared_to_the_original(self):
        self.backend.products["-Nb"].update({"photoCutoutFor": "U2", "photoCutoutUrl": "OLD", "photoCutoutQuality": "shoe"})
        self.assertEqual(self.run_pass(ids=["-Nb"]), {"rejected": 1})
        self.assertNotIn("photoCutoutUrl", self.backend.products["-Nb"])

    def test_product_removed_mid_pass_is_never_recreated(self):
        real_upload = self.backend.upload_png
        def upload_then_delete(path, data):
            url = real_upload(path, data)
            self.backend.products.pop("-Na", None)
            return url
        self.backend.upload_png = upload_then_delete
        self.assertEqual(self.run_pass(ids=["-Na"]), {"skipped": 1})
        self.assertEqual(self.backend.updates, [])

    def test_photo_replaced_mid_pass_is_not_stamped(self):
        real_upload = self.backend.upload_png
        def upload_then_reshoot(path, data):
            url = real_upload(path, data)
            self.backend.products["-Na"]["photoUrl"] = "U1-new"
            return url
        self.backend.upload_png = upload_then_reshoot
        self.assertEqual(self.run_pass(ids=["-Na"]), {"skipped": 1})
        self.assertEqual(self.backend.updates, [])

    def test_dry_run_writes_nothing(self):
        tally = self.run_pass(dry_run=True)
        self.assertEqual(tally, {"would-judge": 3, "cleared": 1})
        self.assertEqual(self.backend.updates, [])
        self.assertEqual(self.backend.uploads, [])
        self.assertEqual(self.state.status()["known_products"], 0)

    def test_limit_and_ids(self):
        self.assertEqual(self.run_pass(limit=1, ids=["-Na", "-Nc"]), {"failed": 1})  # -Nc is newest
        self.assertEqual(self.run_pass(ids=["-Na"]), {"shoe": 1})


try:
    import rembg  # noqa: F401
    HAVE_REMBG = True
except Exception:  # noqa: BLE001
    HAVE_REMBG = False


@unittest.skipUnless(HAVE_REMBG, "rembg not importable")
class RembgIntegration(unittest.TestCase):
    remover = None

    @classmethod
    def setUpClass(cls):
        make_samples()
        cls.remover = cutout.Remover(os.environ.get("CUTOUTS_MODEL", cutout.DEFAULT_MODEL))

    def check(self, path, core):
        img = cutout.load_photo(path.read_bytes())
        raw = self.remover(img)
        self.assertEqual(raw.mode, "RGBA")
        self.assertEqual(raw.size, img.size)
        a = raw.getchannel("A")
        w, h = a.size
        for x, y in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]:
            self.assertLess(a.getpixel((x, y)), 20, "corner %s,%s not transparent" % (x, y))
        x0, y0, x1, y1 = core
        core_alpha = list(a.crop(core).getdata())
        self.assertGreater(sum(core_alpha) / len(core_alpha), 230, "object not opaque")
        out = cutout.trim_and_pad(raw)
        self.assertEqual(out.mode, "RGBA")
        oa = out.getchannel("A")
        self.assertEqual(oa.getpixel((0, 0)), 0)
        self.assertEqual(oa.getpixel((out.width - 1, out.height - 1)), 0)
        bbox = oa.point(lambda v: 255 if v > cutout.ALPHA_THRESHOLD else 0).getbbox()
        pad = round(0.06 * max(bbox[2] - bbox[0], bbox[3] - bbox[1]))
        self.assertLessEqual(abs(bbox[0] - pad), 1)
        self.assertLessEqual(abs(bbox[1] - pad), 1)
        return raw, out

    def test_sneaker_on_studio_white(self):
        self.check(SNEAKER, SNEAKER_CORE)

    def test_offcentre_on_texture(self):
        raw, out = self.check(OFFCENTRE, OFFCENTRE_CORE)
        # the object sits right of centre: everything left of x=250 is background
        left = list(raw.getchannel("A").crop((0, 0, 250, raw.height)).getdata())
        self.assertLess(sum(left) / len(left), 10)


class ShoeStage(unittest.TestCase):
    """shoe.py without the model: the gate, regions, the largest-piece rule and
    the two-stage cut with a synthetic probability map."""

    def setUp(self):
        import numpy as np
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import shoe
        self.np, self.shoe = np, shoe

    def prob(self, boxes, size=(400, 300), p=0.9):
        np = self.np
        m = np.zeros((size[1], size[0]), np.float32)
        for (x0, y0, x1, y1) in boxes:
            m[y0:y1, x0:x1] = p
        return m

    def test_pre_gate(self):
        g = lambda boxes, p=0.9: self.shoe.pre_gate(self.shoe.regions(self.prob(boxes, p=p)), (400, 300))[1]
        self.assertEqual(g([(50, 100, 300, 250)]), "shoe")
        self.assertEqual(g([(50, 100, 300, 250)], p=0.55), "low-confidence")  # peak < 0.60
        self.assertEqual(g([]), "no-shoe")

    def test_a_pair_keeps_both_shoes(self):
        regs = self.shoe.regions(self.prob([(10, 50, 190, 250), (210, 50, 390, 250)]))
        self.assertEqual(len(self.shoe.pick_shoes(regs, (400, 300))), 2)
        regs = self.shoe.regions(self.prob([(10, 50, 190, 250), (300, 260, 330, 280)]))
        self.assertEqual(len(self.shoe.pick_shoes(regs, (400, 300))), 1)   # a speck is not a pair

    def test_largest_piece_drops_detached_fragments(self):
        np = self.np
        a = np.zeros((100, 100), np.float32)
        a[10:60, 10:90] = 255     # the shoe
        a[80:95, 40:60] = 255     # a riser label under it, detached
        out = self.shoe.largest_piece(a)
        self.assertEqual(out[30, 50], 255)
        self.assertEqual(out[88, 50], 0)
        self.assertEqual(self.shoe.largest_piece(a, keep_n=2)[88, 50], 255)

    def test_isolate_shoe_keeps_only_the_shoe(self):
        np = self.np
        img = Image.new("RGB", (400, 300), (200, 200, 200))
        ImageDraw.Draw(img).rectangle((60, 120, 300, 230), fill=(20, 20, 20))   # the shoe
        ImageDraw.Draw(img).rectangle((150, 10, 260, 60), fill=(220, 30, 30))   # the box above it
        prob = self.prob([(55, 115, 305, 235)])
        iso = self.shoe.isolate_shoe(img, prob, fake_remover)
        self.assertEqual(iso.reason, "shoe")
        a = np.asarray(iso.rgba.getchannel("A"))
        box = self.shoe.crop_box((55, 115, 305, 235), img.size)
        self.assertGreater(box[1], 60)        # the crop never reaches the box on the wall
        self.assertGreater(a.mean(), 100)
        self.assertEqual(iso.clip_mask.shape, a.shape)

    # ---- the deterministic gate, one rule at a time (Junid's numbers)

    def metrics(self, mask, rgb=None, clip=None, image=None):
        np = self.np
        mask = np.asarray(mask, bool)
        h, w = mask.shape
        rgb = np.full((h, w, 3), 200, np.uint8) if rgb is None else rgb
        clip = mask if clip is None else clip
        return self.shoe.mask_metrics(mask.astype(np.uint8) * 255, rgb, clip, image or (w, h))

    def shoe_mask(self, w=300, h=150):
        np = self.np
        m = np.zeros((h, w), bool)
        m[20:130, 20:280] = True              # 260x110: aspect 2.36, solid
        return m

    def test_a_clean_shoe_passes_every_rule(self):
        m = self.metrics(self.shoe_mask())
        self.assertEqual(self.shoe.judge_metrics(m), (True, ""))

    def test_components_more_than_two_pieces(self):
        mask = self.np.zeros((150, 300), bool)
        mask[20:130, 20:90] = mask[20:130, 110:180] = mask[20:130, 200:280] = True
        m = self.metrics(mask)
        self.assertEqual(m["components"], 3)
        self.assertEqual(self.shoe.judge_metrics(m)[1], "components")
        mask[20:130, 200:280] = False         # a pair is fine on this rule
        self.assertEqual(self.metrics(mask)["components"], 2)

    def test_solidity(self):
        mask = self.shoe_mask()
        mask[20:100, 60:240] = False          # a deep notch: an L / U shape
        m = self.metrics(mask)
        self.assertLess(m["solidity"], 0.80)
        self.assertEqual(self.shoe.judge_metrics(m)[1], "solidity")
        self.assertEqual(self.shoe.judge_metrics(m, {"min_solidity": 0.0})[1] != "solidity", True)

    def test_area_of_the_photo(self):
        m = self.metrics(self.shoe_mask(), image=(1200, 900))         # 2.6% of the photo
        self.assertEqual(self.shoe.judge_metrics(m)[1], "area")
        m = self.metrics(self.shoe_mask(), image=(450, 800))          # 7.9%
        self.assertTrue(self.shoe.judge_metrics(m)[0])                # passes at 0.06...
        self.assertEqual(self.shoe.judge_metrics(m, {"min_area_fraction": 0.10})[1], "area")  # ...not at Junid's 0.10

    def test_aspect(self):
        np = self.np
        tall = np.zeros((300, 150), bool); tall[20:280, 20:130] = True        # w/h 0.42
        self.assertEqual(self.shoe.judge_metrics(self.metrics(tall))[1], "aspect")
        flat = np.zeros((100, 400), bool); flat[40:70, 10:390] = True         # w/h 12.7
        self.assertEqual(self.shoe.judge_metrics(self.metrics(flat))[1], "aspect")
        self.assertTrue(self.shoe.judge_metrics(self.metrics(self.shoe_mask()))[0])

    def test_box_remnant_dark_rows_clipseg_did_not_call_shoe(self):
        np = self.np
        mask = self.shoe_mask()
        rgb = np.full((150, 300, 3), 200, np.uint8)
        rgb[108:130, 20:280] = 15             # the bottom 22 rows are a black box edge...
        clip = mask.copy(); clip[108:130] = False   # ...that CLIPSeg did not call shoe
        m = self.metrics(mask, rgb, clip)
        self.assertGreater(m["remnant"], 0.15)
        self.assertEqual(self.shoe.judge_metrics(m)[1], "box-remnant")
        # a black SOLE CLIPSeg did call shoe is fine
        self.assertEqual(self.metrics(mask, rgb, mask)["remnant"], 0.0)

    def test_hole(self):
        mask = self.shoe_mask()
        mask[50:100, 100:200] = False         # 5000 px hole in a 28600 px mask: 17%
        m = self.metrics(mask)
        self.assertGreater(m["hole"], 0.04)
        self.assertEqual(self.shoe.judge_metrics(m)[1], "hole")
        mask = self.shoe_mask(); mask[60:66, 140:146] = False   # an eyelet: fine
        self.assertTrue(self.shoe.judge_metrics(self.metrics(mask))[0])

    def test_clip_margin(self):
        img = Image.new("RGB", (300, 150), (230, 230, 230))
        ImageDraw.Draw(img).rectangle((20, 20, 279, 129), fill=(20, 20, 20))
        prob = self.np.zeros((150, 300), self.np.float32); prob[20:130, 20:280] = 0.95
        iso = self.shoe.isolate_shoe(img, prob, fake_remover)
        self.assertTrue(self.shoe.quality_gate(iso, judge=lambda rgba: 0.9)[0])
        ok, rule, m = self.shoe.quality_gate(iso, judge=lambda rgba: 0.10)
        self.assertEqual((ok, rule, m["clip"]), (False, "clip", 0.1))

    def test_make_cutout_retries_tighter_then_rejects_no_fallback(self):
        seg = []
        def tiny(img):
            seg.append(1)
            return self.prob([(10, 10, 40, 30)], size=img.size)
        res = cutout.make_cutout(jpeg_with_box(), fake_remover, tiny)
        self.assertEqual(res.quality, "rejected")
        self.assertIsNone(res.png)                    # never a whole-object cut-out
        self.assertEqual(len(res.attempts), 2)        # retried once, tighter
        self.assertEqual(len(seg), 1)                 # CLIPSeg ran once; the retry re-thresholds it
        res = cutout.make_cutout(jpeg_with_box(), fake_remover, dark_segmenter)
        self.assertEqual((res.quality, res.passed_attempt), ("shoe", 1))

    def test_make_cutout_second_attempt_can_pass(self):
        """A faint fragment (prob 0.55) under the shoe: in at 0.50, out at 0.65."""
        np = self.np
        def seg(img):
            p = dark_segmenter(img)
            p[80:100, 0:200] = 0.55               # a fragment band joined to the shoe, CLIPSeg unsure
            return p
        def draw(d):
            d.rectangle((40, 20, 159, 79), fill=(0, 0, 0))
            d.rectangle((0, 80, 199, 99), fill=(10, 10, 10))       # a dark box edge the full width
        res = cutout.make_cutout(jpeg_of(draw), fake_remover, seg)
        self.assertNotEqual(res.attempts[0][0], "")
        self.assertEqual((res.quality, res.passed_attempt), ("shoe", 2))


if __name__ == "__main__":
    unittest.main()

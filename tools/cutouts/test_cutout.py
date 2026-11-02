"""Tests for cutout.py — no network. Run from tools/cutouts:

    python -m pytest -q          or          python -m unittest -v test_cutout

The rembg integration test runs only when rembg is importable (first run
downloads the model to ~/.u2net)."""
import io
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

    def test_update_payload_has_exactly_two_keys(self):
        p = cutout.build_update("-Nabc", "https://cut", self.URL)
        self.assertEqual(p, {"products/-Nabc/photoCutoutUrl": "https://cut",
                             "products/-Nabc/photoCutoutFor": self.URL})
        self.assertEqual(len(p), 2)


def row(pid, url="u", ts=None, cfor=None, curl=None):
    return {"id": pid, "photoUrl": url, "photoUpdatedAt": ts, "photoCutoutFor": cfor, "photoCutoutUrl": curl}


class Selection(unittest.TestCase):
    def test_valid_skipped_stale_redone_missing_photo_skipped(self):
        rows = [row("a", "u1", cfor="u1", curl="c"),   # valid
                row("b", "u2", cfor="old", curl="c"),  # stale: photo changed
                row("c", "u3", cfor="u3", curl=None),  # for set but url gone
                row("d", None),                        # no photo
                row("e", "")]
        todo, counts = cutout.select_candidates(rows, lambda i, u: 0)
        self.assertEqual(sorted(r["id"] for r in todo), ["b", "c"])
        self.assertEqual(counts, {"no_photo": 2, "valid": 1, "gave_up": 0, "todo": 2})

    def test_newest_first(self):
        rows = [row("-Na"), row("-Nc"), row("x", ts=100), row("y", ts=300), row("-Nb"), row("z", ts="200")]
        todo, _ = cutout.select_candidates(rows, lambda i, u: 0)
        self.assertEqual([r["id"] for r in todo], ["y", "z", "x", "-Nc", "-Nb", "-Na"])

    def test_failure_cap_per_photo(self):
        attempts = {("a", "u1"): 3, ("b", "u2"): 2, ("c", "new"): 0}
        rows = [row("a", "u1"), row("b", "u2"), row("c", "new")]
        todo, counts = cutout.select_candidates(rows, lambda i, u: attempts.get((i, u), 0))
        self.assertEqual(sorted(r["id"] for r in todo), ["b", "c"])
        self.assertEqual(counts["gave_up"], 1)


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
        self.state.record_seen([row("a", "u1"), row("b", "u2"), row("c", "u3", cfor="u3", curl="x"), row("d", None)])
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


def fake_remover(img):
    """Stand-in for rembg: dark pixels are the object."""
    rgba = img.convert("RGBA")
    rgba.putalpha(img.convert("L").point(lambda v: 255 if v < 128 else 0))
    return rgba


def jpeg_with_box():
    img = Image.new("RGB", (200, 100), (255, 255, 255))
    ImageDraw.Draw(img).rectangle((50, 20, 99, 69), fill=(0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


class Pass(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = cutout.State(Path(self.tmp.name) / "s.sqlite")
        self.backend = FakeBackend({
            "-Na": {"photoUrl": "U1", "photoUpdatedAt": 10, "name": "A"},
            "-Nb": {"photoUrl": "U2", "photoCutoutFor": "U2", "photoCutoutUrl": "C2"},  # valid
            "-Nc": {"photoUrl": "BAD", "photoUpdatedAt": 20},                          # undecodable
            "-Nd": {"name": "no photo"},
        }, {"U1": jpeg_with_box(), "BAD": b"not an image"})

    def tearDown(self):
        self.state.db.close()
        self.tmp.cleanup()

    def run_pass(self, **kw):
        return cutout.run_pass(self.backend, fake_remover, self.state, sleep=lambda s: None, **kw)

    def test_pass_writes_two_fields_and_skips_valid(self):
        tally = self.run_pass()
        self.assertEqual(tally, {"done": 1, "failed": 1})
        self.assertEqual(len(self.backend.updates), 1)
        upd = self.backend.updates[0]
        self.assertEqual(set(upd), {"products/-Na/photoCutoutUrl", "products/-Na/photoCutoutFor"})
        self.assertEqual(upd["products/-Na/photoCutoutFor"], "U1")
        path, data = self.backend.uploads[0]
        self.assertEqual(path, cutout.cutout_storage_path("-Na", "U1"))
        png = Image.open(io.BytesIO(data))
        self.assertEqual(png.mode, "RGBA")
        self.assertEqual(png.size, (56, 56))  # 50x50 object + round(3.0) each side
        # never read a field outside the four, and never the whole product
        self.assertTrue(all(f in cutout.FIELDS for _, f in self.backend.reads))

    def test_rerun_is_idempotent_and_failure_cap_holds(self):
        self.run_pass()
        written = self.backend.updates[0]  # what RTDB would now hold for -Na
        self.backend.products["-Na"].update({
            "photoCutoutUrl": written["products/-Na/photoCutoutUrl"],
            "photoCutoutFor": written["products/-Na/photoCutoutFor"]})
        self.assertEqual(self.run_pass(), {"failed": 1})
        self.assertEqual(self.run_pass(), {"gave-up": 1})
        self.assertEqual(self.run_pass(), {})  # 3 attempts on BAD: left alone until the photo changes
        self.backend.products["-Nc"]["photoUrl"] = "U1"
        self.assertEqual(self.run_pass(), {"done": 1})

    def test_dry_run_writes_nothing(self):
        tally = self.run_pass(dry_run=True)
        self.assertEqual(tally, {"would-cut": 2})
        self.assertEqual(self.backend.updates, [])
        self.assertEqual(self.backend.uploads, [])
        self.assertEqual(self.state.status()["known_products"], 0)

    def test_limit_and_ids(self):
        self.assertEqual(self.run_pass(limit=1), {"failed": 1})  # -Nc is newest (photoUpdatedAt 20)
        self.assertEqual(self.run_pass(ids=["-Na"]), {"done": 1})


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
        out = Image.open(io.BytesIO(cutout.make_cutout(path.read_bytes(), self.remover)))
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


if __name__ == "__main__":
    unittest.main()

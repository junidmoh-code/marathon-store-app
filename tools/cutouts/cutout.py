#!/usr/bin/env python3
"""Product cut-outs: the SNEAKER ALONE, as a PNG for the glass podium.

FOOTWEAR ONLY (category "Footwear": sneakers, boots, slides, soccer boots).
Every other product has its cut-out fields cleared and shows its original photo.

For every footwear product with a photoUrl that has not been judged by this
gate version, download the full-res photo and cut it in two stages (shoe.py):

  1. CLIPSeg, prompted "a sneaker" / "a shoe", finds the shoe (or a pair) and
     masks out everything around it — box, riser, shelf, hand.
  2. rembg cleans the edge on that isolated crop.

Then the QUALITY GATE (shoe.quality_gate): fragments, solidity, size, shape,
box remnants, holes, and a CLIP zero-shot check. A failure is retried once
with a tighter CLIPSeg threshold and a 10 px mask erosion; a second failure
writes photoCutoutQuality "rejected" with NO URL, so the card shows the
original photo. There is no whole-object fallback any more. Every rejection is
logged with its pid and failing rule.

A pass is trimmed to its alpha bounding box plus 6% transparent padding,
uploaded to Storage at products/{id}/cutout-<hash>.png, and three fields are
written ADDITIVELY:

    /products/{id}/photoCutoutUrl      the PNG's public URL (absent when rejected)
    /products/{id}/photoCutoutFor      the photoUrl it was judged on
    /products/{id}/photoCutoutQuality  "shoe" | "rejected"

A judgement is current only while photoCutoutFor == the current photoUrl and
the local state records this GATE_VERSION for that photo — so the first run of
a new gate re-audits every earlier cut-out (keeping the URL of one that passes)
and a re-shot product is judged again.

Never reads /products whole (shallow key list + per-field leaf reads), never
set()s a product, never touches photoUrl or any other field.

Usage:
    cutout.py --run-now [--limit N] [--ids a,b] [--loose]
    cutout.py --dry-run [--limit N] [--ids a,b]
    cutout.py --status
"""
import argparse
import fcntl
import hashlib
import io
import json
import logging
import logging.handlers
import os
import sqlite3
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

# ---------------------------------------------------------------- constants

PROJECT_ID = "marathon-club"
# From src/firebase.js — the RTDB lives in europe-west1, NOT the default
# https://marathon-club-default-rtdb.firebaseio.com host.
DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app"
BUCKET = "marathon-club.firebasestorage.app"
CACHE_CONTROL = "public, max-age=31536000, immutable"
PAD_FRACTION = 0.06
ALPHA_THRESHOLD = 8          # alpha <= this counts as background for the bbox
MAX_ATTEMPTS = 3             # per (id, photoUrl); then give up until the photo changes
DEFAULT_INTERVAL_S = 1.5
DEFAULT_MODEL = "isnet-general-use"
DEFAULT_MAX_SIDE = 1600      # longest side of the uploaded PNG; 0 = keep full size
FIELDS = ("photoUrl", "category", "photoUpdatedAt", "photoCutoutFor", "photoCutoutUrl", "photoCutoutQuality")
QUALITIES = ("shoe", "rejected")
FOOTWEAR = "Footwear"          # the product's category field (refill-engine isFootwear)
GATE_VERSION = 4               # bump to re-audit every cut-out under a new gate
RETRY_THRESHOLD = 0.65         # the retry: a tighter CLIPSeg threshold...
RETRY_ERODE_PX = 10            # ...and the keep-mask eroded 10 px
# The retry may trim FRAGMENTS, not the shoe. A normal retry keeps 85-95% of
# the first cut (the 10 px erosion); one under 80% has cut into the shoe
# itself — AJ1 Cream Brown Red lost its sole, AF1 SF its gum sole — and its
# smoother outline then passes solidity. Rejected as "retry-shrunk".
RETRY_MIN_KEEP = 0.80
GATE_DEFAULT_PARAMS = {}       # shoe.GATE as it stands (see the calibration note in README)

REPO_ROOT = Path(__file__).resolve().parents[2]
HOME_DIR = Path(os.environ.get("CUTOUTS_HOME", str(Path.home() / ".marathon-cutouts")))

log = logging.getLogger("cutouts")


class EmptyCutout(Exception):
    """rembg left nothing opaque — no object found."""


# ---------------------------------------------------------- pure: naming

def short_hash(photo_url):
    """10 hex chars of sha1(photoUrl): a new photo gives a new object path."""
    return hashlib.sha1(photo_url.encode("utf-8")).hexdigest()[:10]


def cutout_storage_path(product_id, photo_url):
    return "products/%s/cutout-%s.png" % (product_id, short_hash(photo_url))


def download_url(bucket, storage_path, token):
    """The Firebase public download URL form (token-gated, no auth header)."""
    return "https://firebasestorage.googleapis.com/v0/b/%s/o/%s?alt=media&token=%s" % (
        bucket, quote(storage_path, safe=""), token)


def build_update(product_id, cutout_url, photo_url, quality):
    """Root-relative multi-path update: EXACTLY these three child paths.
    "rejected" carries no URL (None deletes the key)."""
    if quality not in QUALITIES:
        raise ValueError("quality must be one of %r" % (QUALITIES,))
    if (quality == "shoe") != bool(cutout_url):
        raise ValueError("a shoe has a URL; a rejection has none")
    return {
        "products/%s/photoCutoutUrl" % product_id: cutout_url or None,
        "products/%s/photoCutoutFor" % product_id: photo_url,
        "products/%s/photoCutoutQuality" % product_id: quality,
    }


def build_clear(product_ids):
    """Delete all three cut-out fields (None = delete; a no-op on a product
    that no longer exists, so it can never recreate one)."""
    out = {}
    for pid in product_ids:
        for f in ("photoCutoutUrl", "photoCutoutFor", "photoCutoutQuality"):
            out["products/%s/%s" % (pid, f)] = None
    return out


def is_footwear(fields):
    return fields.get("category") == FOOTWEAR


# ---------------------------------------------------------- pure: images

def trim_and_pad(img, pad_fraction=PAD_FRACTION, threshold=ALPHA_THRESHOLD):
    """Crop an RGBA image to its alpha bbox, then pad every side with
    round(pad_fraction * longer bbox side) transparent pixels."""
    from PIL import Image
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    alpha = img.getchannel("A")
    bbox = alpha.point(lambda a: 255 if a > threshold else 0).getbbox()
    if not bbox:
        raise EmptyCutout("no opaque pixels")
    obj = img.crop(bbox)
    bw, bh = obj.size
    pad = int(round(pad_fraction * max(bw, bh)))
    out = Image.new("RGBA", (bw + 2 * pad, bh + 2 * pad), (0, 0, 0, 0))
    out.paste(obj, (pad, pad))
    return out


def limit_size(img, max_side):
    if not max_side or max(img.size) <= max_side:
        return img
    from PIL import Image
    scale = float(max_side) / max(img.size)
    size = (max(1, int(round(img.size[0] * scale))), max(1, int(round(img.size[1] * scale))))
    return img.resize(size, Image.LANCZOS)


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def load_photo(data):
    from PIL import Image, ImageOps
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


class Remover:
    """rembg with one session reused for the whole run."""

    def __init__(self, model=DEFAULT_MODEL):
        self.model = model
        self._session = None

    def __call__(self, img):
        from rembg import new_session, remove
        if self._session is None:
            self._session = new_session(self.model)
        out = remove(img, session=self._session)
        return out.convert("RGBA")


class CutResult:
    def __init__(self, quality, png=None, rule="", metrics=None, attempts=None):
        self.quality, self.png, self.rule = quality, png, rule
        self.metrics = metrics or {}
        self.attempts = attempts or []   # [(rule_or_"", metrics, preview_rgba_or_None)]
        self.passed_attempt = None


def make_cutout(photo_bytes, remover, segmenter, judge=None, max_side=DEFAULT_MAX_SIDE, gate_params=None):
    """-> CutResult. Attempt 1 at the normal threshold; if the gate refuses,
    attempt 2 tighter (RETRY_THRESHOLD, RETRY_ERODE_PX); if that fails too the
    product is "rejected" and keeps its original photo."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import shoe
    img = load_photo(photo_bytes)
    prob = segmenter(img)
    res = CutResult("rejected")
    for n, (th, er) in enumerate([(shoe.MASK_THRESHOLD, 0), (RETRY_THRESHOLD, RETRY_ERODE_PX)], 1):
        iso = shoe.isolate_shoe(img, prob, remover, threshold=th, erode_px=er)
        ok, rule, m = shoe.quality_gate(iso, judge, gate_params)
        first = res.attempts[0][1] if res.attempts else {}
        if ok and n == 2 and first.get("area_fraction") and \
                m.get("area_fraction", 0) < RETRY_MIN_KEEP * first["area_fraction"]:
            ok, rule = False, "retry-shrunk"
        res.attempts.append((rule, m, iso.rgba))
        if ok:
            try:
                cut = trim_and_pad(iso.rgba)
            except EmptyCutout:
                res.attempts[-1] = ("empty", m, iso.rgba)
                continue
            res.quality, res.png, res.rule, res.metrics = "shoe", png_bytes(limit_size(cut, max_side)), "", m
            res.passed_attempt = n
            return res
        if iso.rgba is None:   # no shoe found: a tighter retry finds less
            break
    res.rule, res.metrics = res.attempts[-1][0], res.attempts[-1][1]
    return res


# ---------------------------------------------------------- pure: selection

def is_current(fields, gated_version=None):
    """Judged by THIS gate for THIS photo: a shoe with its URL, or a rejection
    without one. gated_version is what the local state recorded for the photo."""
    url = fields.get("photoUrl")
    if not url or fields.get("photoCutoutFor") != url or gated_version != GATE_VERSION:
        return False
    q = fields.get("photoCutoutQuality")
    if q == "shoe":
        return bool(fields.get("photoCutoutUrl"))
    return q == "rejected" and not fields.get("photoCutoutUrl")


def has_cutout_fields(fields):
    return any(fields.get(f) for f in ("photoCutoutUrl", "photoCutoutFor", "photoCutoutQuality"))


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def order_newest_first(rows):
    """photoUpdatedAt desc for rows that have it, then the rest by key desc."""
    stamped = [r for r in rows if _num(r.get("photoUpdatedAt")) is not None]
    rest = [r for r in rows if _num(r.get("photoUpdatedAt")) is None]
    stamped.sort(key=lambda r: (_num(r["photoUpdatedAt"]), r["id"]), reverse=True)
    rest.sort(key=lambda r: r["id"], reverse=True)
    return stamped + rest


def select_candidates(rows, attempts_for, gated_for=lambda i, u: None, max_attempts=MAX_ATTEMPTS):
    """rows: dicts with id + FIELDS. attempts_for(id, photoUrl) -> int;
    gated_for(id, photoUrl) -> the gate version recorded for that photo.
    Returns (todo, clear, counts): todo = footwear to judge, newest first;
    clear = ids of non-footwear products that still carry cut-out fields."""
    counts = {"no_photo": 0, "not_footwear": 0, "clear": 0, "current": 0, "gave_up": 0, "todo": 0}
    todo, clear = [], []
    for r in rows:
        url = r.get("photoUrl")
        if not is_footwear(r):
            if has_cutout_fields(r):
                clear.append(r["id"])
            else:
                counts["not_footwear"] += 1
        elif not isinstance(url, str) or not url:
            counts["no_photo"] += 1
        elif is_current(r, gated_for(r["id"], url)):
            counts["current"] += 1
        elif attempts_for(r["id"], url) >= max_attempts:
            counts["gave_up"] += 1
        else:
            todo.append(r)
    todo = order_newest_first(todo)
    counts["todo"], counts["clear"] = len(todo), len(clear)
    return todo, clear, counts


# ---------------------------------------------------------- state (sqlite)

class State:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path))
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS done (
                id TEXT PRIMARY KEY, photo_url TEXT NOT NULL,
                cutout_url TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS failures (
                id TEXT NOT NULL, photo_url TEXT NOT NULL,
                attempts INTEGER NOT NULL, last_error TEXT, at INTEGER NOT NULL,
                PRIMARY KEY (id, photo_url));
            CREATE TABLE IF NOT EXISTS known (
                id TEXT PRIMARY KEY, photo_url TEXT, valid INTEGER NOT NULL,
                seen_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS gated (
                id TEXT NOT NULL, photo_url TEXT NOT NULL, version INTEGER NOT NULL,
                quality TEXT NOT NULL, rule TEXT, at INTEGER NOT NULL,
                PRIMARY KEY (id, photo_url));
        """)
        self.db.commit()

    def attempts(self, pid, photo_url):
        row = self.db.execute("SELECT attempts FROM failures WHERE id=? AND photo_url=?",
                              (pid, photo_url)).fetchone()
        return row[0] if row else 0

    def gated_version(self, pid, photo_url):
        row = self.db.execute("SELECT version FROM gated WHERE id=? AND photo_url=?",
                              (pid, photo_url)).fetchone()
        return row[0] if row else None

    def mark_gated(self, pid, photo_url, quality, rule=""):
        self.db.execute("INSERT OR REPLACE INTO gated VALUES (?,?,?,?,?,?)",
                        (pid, photo_url, GATE_VERSION, quality, rule, int(time.time() * 1000)))
        self.db.commit()

    def mark_done(self, pid, photo_url, cutout_url):
        now = int(time.time() * 1000)
        self.db.execute("INSERT OR REPLACE INTO done VALUES (?,?,?,?)",
                        (pid, photo_url, cutout_url, now))
        self.db.execute("DELETE FROM failures WHERE id=?", (pid,))
        self.db.execute("INSERT OR REPLACE INTO known VALUES (?,?,1,?)", (pid, photo_url, now))
        self.db.commit()

    def mark_failed(self, pid, photo_url, error):
        now = int(time.time() * 1000)
        self.db.execute("""
            INSERT INTO failures VALUES (?,?,1,?,?)
            ON CONFLICT(id, photo_url) DO UPDATE SET
              attempts = attempts + 1, last_error = excluded.last_error, at = excluded.at
        """, (pid, photo_url, str(error)[:500], now))
        self.db.commit()
        return self.attempts(pid, photo_url)

    def record_seen(self, rows):
        now = int(time.time() * 1000)
        self.db.executemany("INSERT OR REPLACE INTO known VALUES (?,?,?,?)", [
            (r["id"], r.get("photoUrl") if isinstance(r.get("photoUrl"), str) and is_footwear(r) else None,
             1 if is_current(r, self.gated_version(r["id"], r.get("photoUrl") or "")) else 0, now) for r in rows])
        self.db.commit()

    def status(self, max_attempts=MAX_ATTEMPTS):
        q = lambda sql, *a: self.db.execute(sql, a).fetchone()[0]
        return {
            "done": q("SELECT COUNT(*) FROM done"),
            "failed_gave_up": q("SELECT COUNT(*) FROM failures WHERE attempts >= ?", max_attempts),
            "failed_retrying": q("SELECT COUNT(*) FROM failures WHERE attempts < ?", max_attempts),
            # seen with a photo, not valid at last look, not given up on that photo
            "pending_known": q("""
                SELECT COUNT(*) FROM known k WHERE k.photo_url IS NOT NULL AND k.valid = 0
                AND NOT EXISTS (SELECT 1 FROM failures f WHERE f.id = k.id
                    AND f.photo_url = k.photo_url AND f.attempts >= ?)""", max_attempts),
            "known_products": q("SELECT COUNT(*) FROM known"),
            "gate_v%d_shoe" % GATE_VERSION: q("SELECT COUNT(*) FROM gated WHERE version=? AND quality='shoe'", GATE_VERSION),
            "gate_v%d_rejected" % GATE_VERSION: q("SELECT COUNT(*) FROM gated WHERE version=? AND quality='rejected'", GATE_VERSION),
        }


# ---------------------------------------------------------- lock

class SingleFlight:
    """flock on a file: a nightly run and a run-now never overlap."""

    def __init__(self, path):
        self.path = Path(path)
        self.fh = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fh = open(str(self.path), "a+")
        try:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.fh.close()
            self.fh = None
            return False
        self.fh.seek(0)
        self.fh.truncate()
        self.fh.write("%d\n" % os.getpid())
        self.fh.flush()
        return True

    def release(self):
        if self.fh:
            fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            self.fh.close()
            self.fh = None


# ---------------------------------------------------------- backend (network)

class FirebaseBackend:
    """Everything that touches the network. Tests swap in a fake."""

    def __init__(self):
        import firebase_admin
        from firebase_admin import credentials, db, storage
        if not firebase_admin._apps:
            firebase_admin.initialize_app(credentials.ApplicationDefault(), {
                "projectId": PROJECT_ID, "databaseURL": DATABASE_URL, "storageBucket": BUCKET})
        self._db = db
        self._bucket = storage.bucket()
        import requests
        self._http = requests.Session()

    def list_product_ids(self):
        # shallow=true: keys only, never the product bodies.
        keys = self._db.reference("products").get(shallow=True) or {}
        return list(keys.keys())

    def read_field(self, pid, field):
        return self._db.reference("products/%s/%s" % (pid, field)).get()

    def download(self, url):
        r = self._http.get(url, timeout=60)
        r.raise_for_status()
        return r.content

    def upload_png(self, storage_path, data):
        token = str(uuid.uuid4())
        blob = self._bucket.blob(storage_path)
        blob.cache_control = CACHE_CONTROL
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.upload_from_string(data, content_type="image/png")
        return download_url(BUCKET, storage_path, token)

    def update(self, payload):
        self._db.reference("/").update(payload)


def read_rows(backend, ids, workers=8):
    """Per-product leaf reads, cheapest first. Non-footwear: only enough to
    know whether there are cut-out fields to clear (every write sets
    photoCutoutFor, so it alone says so; photoCutoutUrl is checked too)."""
    def one(pid):
        row = {"id": pid}
        row["category"] = backend.read_field(pid, "category")
        if row["category"] != FOOTWEAR:
            row["photoCutoutFor"] = backend.read_field(pid, "photoCutoutFor")
            if not row["photoCutoutFor"]:
                row["photoCutoutUrl"] = backend.read_field(pid, "photoCutoutUrl")
            return row
        row["photoUrl"] = backend.read_field(pid, "photoUrl")
        if not row["photoUrl"]:
            return row
        row["photoUpdatedAt"] = backend.read_field(pid, "photoUpdatedAt")
        row["photoCutoutFor"] = backend.read_field(pid, "photoCutoutFor")
        if row["photoCutoutFor"] == row["photoUrl"]:
            row["photoCutoutUrl"] = backend.read_field(pid, "photoCutoutUrl")
            row["photoCutoutQuality"] = backend.read_field(pid, "photoCutoutQuality")
        return row
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, ids))


# ---------------------------------------------------------- the pass

def save_audit(audit_dir, pid, res, kept):
    """A small preview of every attempt + one JSON line, for the review sheet."""
    if not audit_dir:
        return
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import shoe
    d = Path(audit_dir)
    d.mkdir(parents=True, exist_ok=True)
    for n, (_, _, rgba) in enumerate(res.attempts, 1):
        if rgba is not None and rgba.getchannel("A").getbbox():
            shoe.on_plain(rgba, (205, 212, 222)).resize((300, 300)).save(str(d / ("%s-%d.jpg" % (pid, n))), quality=82)
    with open(str(d / "audit.jsonl"), "a") as fh:
        fh.write(json.dumps({"id": pid, "quality": res.quality, "rule": res.rule, "kept": kept,
                             "passed_attempt": res.passed_attempt,
                             "attempts": [{"rule": r, "metrics": m} for r, m, _ in res.attempts]}) + "\n")


def process_one(backend, remover, state, row, max_side=DEFAULT_MAX_SIDE, dry_run=False, segmenter=None,
                judge=None, gate_params=None, audit_dir=None):
    """Returns (outcome, detail). Never raises."""
    pid, photo_url = row["id"], row["photoUrl"]
    path = cutout_storage_path(pid, photo_url)
    if dry_run:
        return "would-judge", path
    try:
        res = make_cutout(backend.download(photo_url), remover, segmenter, judge, max_side, gate_params)
        for n, (rule, m, _) in enumerate(res.attempts, 1):
            if rule:
                log.info("REJECT %s attempt=%d rule=%s %s", pid, n, rule, json.dumps(m, sort_keys=True))
        # The existing v2 cut-out passes this gate as it stands (attempt 1 is
        # the same cut): keep its URL rather than re-upload the same picture.
        kept = (res.quality == "shoe" and res.passed_attempt == 1 and row.get("photoCutoutQuality") == "shoe"
                and row.get("photoCutoutFor") == photo_url and bool(row.get("photoCutoutUrl")))
        url = row["photoCutoutUrl"] if kept else (backend.upload_png(path, res.png) if res.quality == "shoe" else None)
        # Re-read the photo just before writing: the product may have been
        # deleted (a root-level update would recreate it as a stub) or
        # re-shot during the download/segment/upload window.
        if backend.read_field(pid, "photoUrl") != photo_url:
            state.mark_failed(pid, photo_url, "photo changed or product removed before write")
            return "skipped", "photoUrl changed or product removed mid-pass"
        if not kept:
            backend.update(build_update(pid, url, photo_url, res.quality))
        state.mark_gated(pid, photo_url, res.quality, res.rule)
        state.mark_done(pid, photo_url, url or "")
        save_audit(audit_dir, pid, res, kept)
        if res.quality == "rejected":
            log.info("REJECTED %s rule=%s", pid, res.rule)
            return "rejected", "rule=%s" % res.rule
        return ("kept" if kept else "shoe"), ("attempt %d %s" % (res.passed_attempt, path if not kept else "existing URL"))
    except Exception as e:  # noqa: BLE001 — one bad photo must not stop the pass
        n = state.mark_failed(pid, photo_url, "%s: %s" % (type(e).__name__, e))
        return ("gave-up" if n >= MAX_ATTEMPTS else "failed"), "attempt %d: %s: %s" % (
            n, type(e).__name__, e)


def clear_non_footwear(backend, ids, batch=200, dry_run=False):
    """Non-footwear products lose their cut-out fields (they show the original photo)."""
    for i in range(0, len(ids), batch):
        chunk = ids[i:i + batch]
        if not dry_run:
            backend.update(build_clear(chunk))
        for pid in chunk:
            log.info("CLEARED %s not footwear", pid)
    return len(ids)


def run_pass(backend, remover, state, ids=None, limit=None, dry_run=False,
             interval=DEFAULT_INTERVAL_S, max_side=DEFAULT_MAX_SIDE, sleep=time.sleep,
             segmenter=None, judge=None, gate_params=None, audit_dir=None):
    t0 = time.time()
    if ids is None:
        ids = backend.list_product_ids()
    rows = read_rows(backend, ids)
    if not dry_run:
        state.record_seen(rows)
    todo, clear, counts = select_candidates(rows, state.attempts, state.gated_version)
    log.info("- scan products=%d footwear_todo=%d current=%d not_footwear=%d clear=%d no_photo=%d gave_up=%d %dms",
             len(rows), counts["todo"], counts["current"], counts["not_footwear"], counts["clear"],
             counts["no_photo"], counts["gave_up"], (time.time() - t0) * 1000)
    tally = {}
    if clear:
        tally["cleared"] = clear_non_footwear(backend, clear, dry_run=dry_run)
    if limit is not None:
        todo = todo[:limit]
    for i, row in enumerate(todo):
        if i and not dry_run:
            sleep(interval)
        t = time.time()
        outcome, detail = process_one(backend, remover, state, row, max_side, dry_run, segmenter,
                                      judge, gate_params, audit_dir)
        tally[outcome] = tally.get(outcome, 0) + 1
        log.info("%s %s %dms %s", row["id"], outcome, (time.time() - t) * 1000, detail)
    log.info("- pass %s %dms", json.dumps(tally, sort_keys=True), (time.time() - t0) * 1000)
    return tally


# ---------------------------------------------------------- CLI

def setup_logging(log_file, echo=False):
    log.setLevel(logging.INFO)
    log.handlers[:] = []
    fmt = logging.Formatter("%(asctime)s %(message)s", "%Y-%m-%dT%H:%M:%S%z")
    Path(log_file).parent.mkdir(parents=True, exist_ok=True)
    fh = logging.handlers.RotatingFileHandler(str(log_file), maxBytes=5 * 1024 * 1024, backupCount=5)
    fh.setFormatter(fmt)
    log.addHandler(fh)
    # Echo to the terminal only. Under launchd/nohup stdout is a file (the
    # installer's nohup points it at this same log), and echoing would double
    # every line.
    if echo or sys.stdout.isatty():
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        log.addHandler(sh)


def main(argv=None):
    p = argparse.ArgumentParser(description="Background-removed product cut-outs.")
    p.add_argument("--run-now", action="store_true", help="process now")
    p.add_argument("--dry-run", action="store_true", help="read only; print what would be cut")
    p.add_argument("--status", action="store_true", help="counts from the local state file")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--ids", default=None, help="comma-separated product ids")
    p.add_argument("--interval", type=float, default=float(os.environ.get("CUTOUTS_INTERVAL", DEFAULT_INTERVAL_S)),
                   help="seconds between products (on top of processing time)")
    p.add_argument("--model", default=os.environ.get("CUTOUTS_MODEL", DEFAULT_MODEL))
    p.add_argument("--max-side", type=int, default=DEFAULT_MAX_SIDE)
    p.add_argument("--loose", action="store_true",
                   help="solidity + aspect one step looser (shoe.GATE_LOOSE_STEP)")
    p.add_argument("--area", type=float, default=None,
                   help="override the area rule (largest piece / photo); Junid's spec number is 0.10")
    p.add_argument("--audit-dir", default=str(HOME_DIR / "audit"),
                   help="previews + audit.jsonl for the review sheet ('' = none)")
    p.add_argument("--state", default=str(HOME_DIR / "state.sqlite"))
    p.add_argument("--log-file", default=str(REPO_ROOT / "logs" / "cutouts.log"))
    a = p.parse_args(argv)

    state = State(a.state)
    if a.status:
        print(json.dumps(state.status(), indent=2))
        return 0
    if not (a.run_now or a.dry_run):
        p.print_help()
        return 2

    setup_logging(a.log_file, echo=a.dry_run)
    lock = SingleFlight(Path(a.state).parent / "cutouts.lock")
    if not lock.acquire():
        log.info("- skipped another run holds %s", lock.path)
        return 0
    try:
        ids = [s.strip() for s in a.ids.split(",") if s.strip()] if a.ids else None
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import shoe
        segmenter = judge = None
        if not a.dry_run:
            segmenter = shoe.ClipSeg()
            judge = shoe.ClipJudge(segmenter)
        params = dict(GATE_DEFAULT_PARAMS, **(shoe.GATE_LOOSE_STEP if a.loose else {}))
        if a.area is not None:
            params["min_area_fraction"] = a.area
        run_pass(FirebaseBackend(), Remover(a.model), state, ids=ids, limit=a.limit,
                 dry_run=a.dry_run, interval=a.interval, max_side=a.max_side,
                 segmenter=segmenter, judge=judge, gate_params=params, audit_dir=a.audit_dir or None)
    finally:
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())

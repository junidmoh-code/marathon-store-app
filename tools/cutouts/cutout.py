#!/usr/bin/env python3
"""Product cut-outs: a background-removed PNG per product for the glass podium.

For every product with a photoUrl and no valid cut-out, download the full-res
photo, remove the background with rembg (local, CPU), trim to the alpha
bounding box plus 6% transparent padding, upload it to Storage at
products/{id}/cutout-<hash>.png and write ADDITIVELY two fields:

    /products/{id}/photoCutoutUrl  the public download URL of the PNG
    /products/{id}/photoCutoutFor  the photoUrl it was cut from

A cut-out is valid only while photoCutoutFor == the current photoUrl, so the
app ignores a stale one the moment the photo changes, and the next run redoes it.

Never reads /products whole (shallow key list + per-field leaf reads), never
set()s a product, never touches photoUrl or any other field.

Usage:
    cutout.py --run-now [--limit N] [--ids a,b]
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
FIELDS = ("photoUrl", "photoUpdatedAt", "photoCutoutFor", "photoCutoutUrl")

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


def build_update(product_id, cutout_url, photo_url):
    """Root-relative multi-path update: EXACTLY these two child paths."""
    return {
        "products/%s/photoCutoutUrl" % product_id: cutout_url,
        "products/%s/photoCutoutFor" % product_id: photo_url,
    }


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


def make_cutout(photo_bytes, remover, max_side=DEFAULT_MAX_SIDE):
    img = load_photo(photo_bytes)
    cut = trim_and_pad(remover(img))
    return png_bytes(limit_size(cut, max_side))


# ---------------------------------------------------------- pure: selection

def is_valid_cutout(fields):
    url = fields.get("photoUrl")
    return bool(url and fields.get("photoCutoutUrl") and fields.get("photoCutoutFor") == url)


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


def select_candidates(rows, attempts_for, max_attempts=MAX_ATTEMPTS):
    """rows: dicts with id + FIELDS. attempts_for(id, photoUrl) -> int.
    Returns (todo, counts) — todo is newest first."""
    counts = {"no_photo": 0, "valid": 0, "gave_up": 0, "todo": 0}
    todo = []
    for r in rows:
        url = r.get("photoUrl")
        if not isinstance(url, str) or not url:
            counts["no_photo"] += 1
        elif is_valid_cutout(r):
            counts["valid"] += 1
        elif attempts_for(r["id"], url) >= max_attempts:
            counts["gave_up"] += 1
        else:
            todo.append(r)
    todo = order_newest_first(todo)
    counts["todo"] = len(todo)
    return todo, counts


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
        """)
        self.db.commit()

    def attempts(self, pid, photo_url):
        row = self.db.execute("SELECT attempts FROM failures WHERE id=? AND photo_url=?",
                              (pid, photo_url)).fetchone()
        return row[0] if row else 0

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
            (r["id"], r.get("photoUrl") if isinstance(r.get("photoUrl"), str) else None,
             1 if is_valid_cutout(r) else 0, now) for r in rows])
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
    """Per-product leaf reads, cheapest first: photoCutoutUrl is only read
    when photoCutoutFor already matches photoUrl."""
    def one(pid):
        row = {"id": pid}
        row["photoUrl"] = backend.read_field(pid, "photoUrl")
        if not row["photoUrl"]:
            return row
        row["photoUpdatedAt"] = backend.read_field(pid, "photoUpdatedAt")
        row["photoCutoutFor"] = backend.read_field(pid, "photoCutoutFor")
        if row["photoCutoutFor"] == row["photoUrl"]:
            row["photoCutoutUrl"] = backend.read_field(pid, "photoCutoutUrl")
        return row
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, ids))


# ---------------------------------------------------------- the pass

def process_one(backend, remover, state, row, max_side=DEFAULT_MAX_SIDE, dry_run=False):
    """Returns (outcome, detail). Never raises."""
    pid, photo_url = row["id"], row["photoUrl"]
    path = cutout_storage_path(pid, photo_url)
    if dry_run:
        return "would-cut", path
    try:
        cut = make_cutout(backend.download(photo_url), remover, max_side)
        url = backend.upload_png(path, cut)
        backend.update(build_update(pid, url, photo_url))
        state.mark_done(pid, photo_url, url)
        return "done", "%s %dKB" % (path, len(cut) // 1024)
    except Exception as e:  # noqa: BLE001 — one bad photo must not stop the pass
        n = state.mark_failed(pid, photo_url, "%s: %s" % (type(e).__name__, e))
        return ("gave-up" if n >= MAX_ATTEMPTS else "failed"), "attempt %d: %s: %s" % (
            n, type(e).__name__, e)


def run_pass(backend, remover, state, ids=None, limit=None, dry_run=False,
             interval=DEFAULT_INTERVAL_S, max_side=DEFAULT_MAX_SIDE, sleep=time.sleep):
    t0 = time.time()
    if ids is None:
        ids = backend.list_product_ids()
    rows = read_rows(backend, ids)
    if not dry_run:
        state.record_seen(rows)
    todo, counts = select_candidates(rows, state.attempts)
    log.info("- scan products=%d valid=%d no_photo=%d gave_up=%d todo=%d %dms",
             len(rows), counts["valid"], counts["no_photo"], counts["gave_up"],
             counts["todo"], (time.time() - t0) * 1000)
    if limit is not None:
        todo = todo[:limit]
    tally = {}
    for i, row in enumerate(todo):
        if i and not dry_run:
            sleep(interval)
        t = time.time()
        outcome, detail = process_one(backend, remover, state, row, max_side, dry_run)
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
        run_pass(FirebaseBackend(), Remover(a.model), state, ids=ids, limit=a.limit,
                 dry_run=a.dry_run, interval=a.interval, max_side=a.max_side)
    finally:
        lock.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())

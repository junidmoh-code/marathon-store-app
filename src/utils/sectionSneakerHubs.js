// ─── A SECTION 1 SHOP'S SNEAKER HUBS — ASKED OF THE NETWORK REGISTRY ─────────
//
// The order screen's sneaker lane (the ✕ on a size, the cart allocation, the
// hub an order line is booked against) was built for Marathon PE and Trophy:
// two hubs, Hub 1 and Hub 2, named in the screen. That path is untouched —
// this module answers NOTHING for a Section 2 shop, so the screen falls
// through to the pair it has always used.
//
// For every other shop (Pine, Concrete) it answers the same three questions
// from the registry:
//
//   • WHICH HUBS may supply this shop's sneakers?  The gated sneaker hubs
//     (availabilityCore.gatedSneakerHubs — the hubs IN SERVICE) that are in the
//     shop's own section AND serve it. Hub 3 for Pine; Hub 3 and the Concrete
//     Stockroom for Concrete. Never a hub across the wall, and never a hub
//     whose `serves` list leaves the shop out (the Stockroom is Concrete's
//     alone — the section wall by itself would have let Pine draw on it).
//   • OUT OF SERVICE = NOT GATED. A hub switched off on the Network card
//     (Solve off, or Auto-refill off) is not in the list, so its shop's sneaker
//     tiles carry no ✕ and the order goes to the back-stock hub by hand.
//   • WHICH HUB IS THE LINE BOOKED AGAINST?  The one the cart allocation chose
//     — but only when it is one of the hubs above. Anything else (no
//     allocation, an ungated shoe, a hub that is not this shop's) is the
//     registry's back-stock hub for the product.
//
// Pure: no firebase, no clock, no React.
import { locationOf, sectionOf, backStockFor, backStockHubsOf } from "./networkRegistry";
import { effectiveCategoryKey } from "./productTaxonomy";
import { gatedSneakerHubs, isFootwearProduct } from "../components/stock/availabilityCore";
import { decodedCellKey } from "./sizeKey";

// The order screen subscribes to each hub's cells with one hook apiece, and a
// hook count cannot follow the registry. Two is every hub Section 1 has. A
// third hub in a section would be left out of the gate (its sizes are then
// never offered as an alternate) until this number and the screen's hooks grow
// together.
export const SECTION_SNEAKER_HUB_SLOTS = 2;

const servesShop = (hubLoc, shopId) => !hubLoc.serves || !hubLoc.serves.length || hubLoc.serves.includes(shopId);

// [] for Marathon PE / Trophy (they keep the screen's own pair), for a shop
// the registry does not know, and for a shop none of whose hubs is in service.
export function sectionSneakerHubs(network, shop) {
  const s = locationOf(network, shop);
  if (!s || s.type !== "store" || s.section === 2) return [];
  const out = [];
  for (const id of gatedSneakerHubs(network)) {
    const h = locationOf(network, id);
    if (!h || h.type !== "hub" || h.section !== s.section || !servesShop(h, s.id)) continue;
    out.push(h.id);
  }
  return out.slice(0, SECTION_SNEAKER_HUB_SLOTS);
}

// The hub a NEW sneaker line for this shop is booked against.
//   Marathon PE / Trophy: `legacyCompute()` — the allocation-or-tag answer the
//   screen has always used, not re-derived here.
//   Everyone else: the allocation's hub when it is one of the shop's own gated
//   hubs, else the registry's back-stock hub (null when the shop has none).
export function sneakerPlacementHub(network, shop, product, allocatedHub, legacyCompute) {
  if (sectionOf(network, shop) === 2) return legacyCompute();
  if (allocatedHub && sectionSneakerHubs(network, shop).includes(allocatedHub)) return allocatedHub;
  return backStockFor(network, shop, product ? effectiveCategoryKey(product) : null, product ? product.id : undefined);
}

// ─── WHAT A PINE OR CONCRETE SHOP HOLDS ITSELF (Junid, 9 Nov 2026) ───────────
// Sneakers sit at Hub 3. Everything else sits on the shop's own shelf, and the
// till deducts it there (POS saleRouting: footwear to a hub, the rest to the
// shop), so that shelf is what the order screen reads for it.
// The shop's own location id; null for Marathon PE / Trophy, an unknown shop, and
// a shop whose hub is switched out of service on the Network card (the division
// then has no gate at all, as before the count).
export function shopShelfFor(network, shop) {
  const s = locationOf(network, shop);
  return s && s.type === "store" && sectionSneakerHubs(network, shop).length ? s.id : null;
}

export function readsShopShelf(network, shop, product) {
  return !!product && shopShelfFor(network, shop) !== null && !isFootwearProduct(product);
}

// ─── CLOTHING: WHICH HUB'S CELL GREYS A SIZE OUT ─────────────────────────────
// A clothing size is greyed out when the hub that would send it holds none.
// For Marathon PE / Trophy that hub is the screen's serving hub (Hub 2), full
// stop — `servingHub` comes straight back. For any other shop it is the
// PRODUCT's back-stock hub: Concrete's T-shirts read the Concrete Stockroom
// once that category (or that one product) is flipped there, not Hub 3.
export function clothingHubFor(network, shop, product, servingHub) {
  if (sectionOf(network, shop) === 2 || !locationOf(network, shop)) return servingHub;
  if (!product) return servingHub;
  return backStockFor(network, shop, effectiveCategoryKey(product), product.id) || servingHub;
}

// The ONE other hub (beside `servingHub`) whose cells the clothing grey-out
// may need: the first of the shop's back-stock hubs that is not the serving
// hub. null for Marathon PE / Trophy and for a shop with a single hub — the
// screen then opens no second subscription.
export function extraClothingHub(network, shop, servingHub) {
  if (sectionOf(network, shop) === 2 || !locationOf(network, shop)) return null;
  return backStockHubsOf(network, shop).find((h) => h !== servingHub) || null;
}

// ─── WHERE A SHOP-HELD LINE IS BOOKED (Junid, 9 Nov 2026) ────────────────────
// An item a Pine or Concrete shop holds books against that shop. It goes to the
// hub only when the shop is out and the hub holds it, so the warehouse is never
// asked for something it does not have.
//
// What the screen offers is therefore the shelf and the hub together; which of
// the two a line lands on is decided per unit, shelf first, as the cart is read.
const cellUnits = (cells, pid, size) => Math.max(Number(cells?.[pid]?.[decodedCellKey(size)]?.qty) || 0, 0);

// The shelf's cells with the hubs' units added: what the size chips, the add
// clamps and the Unavailable state read for a shop-held item. A hub still
// loading leaves the view unsettled, so nothing is called out on half the answer.
export function shopHeldView(shelfState, hubStates = []) {
  const shelf = shelfState?.cells || {};
  const cells = {};
  for (const [pid, sizes] of Object.entries(shelf)) cells[pid] = { ...sizes };
  for (const h of hubStates) {
    for (const [pid, sizes] of Object.entries(h?.cells || {})) {
      if (!sizes || typeof sizes !== "object") continue;
      for (const [size, cell] of Object.entries(sizes)) {
        const add = Math.max(Number(cell?.qty) || 0, 0);
        if (!cell || !add) continue;
        const row = cells[pid] || (cells[pid] = {});
        row[size] = { ...row[size], qty: Math.max(Number(row[size]?.qty) || 0, 0) + add };
      }
    }
  }
  return {
    cells,
    settled: shelfState?.settled === true && hubStates.every((h) => h?.settled === true),
    error: !!shelfState?.error || hubStates.some((h) => !!h?.error),
  };
}

// One line's location, in cart order: the shop while it has units left, else the
// first hub with units left. With neither, the shelf: the submit guard re-reads
// that cell and refuses, rather than the order going to a hub that holds none.
export function shopHeldBookings(lines, { shelf, shelfCells, hubs = [], isShopHeld }) {
  const out = new Map();
  if (!shelf) return out;
  const taken = new Map();
  const left = (loc, cells, pid, size) => cellUnits(cells, pid, size) - (taken.get(`${loc}|${pid}|${decodedCellKey(size)}`) || 0);
  const take = (loc, pid, size) => {
    const k = `${loc}|${pid}|${decodedCellKey(size)}`;
    taken.set(k, (taken.get(k) || 0) + 1);
  };
  for (const line of lines || []) {
    if (!isShopHeld(line)) continue;
    const pid = line.product.id;
    const hub = left(shelf, shelfCells, pid, line.size) > 0 ? null : hubs.find((h) => left(h.id, h.cells, pid, line.size) > 0);
    const at = hub ? hub.id : shelf;
    take(at, pid, line.size);
    out.set(line, at);
  }
  return out;
}

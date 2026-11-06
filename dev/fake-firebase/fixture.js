// DEV ONLY — the synthetic database the sky app harness reads
// (dev/fake-firebase/database.js). Invented products, posts and publishing
// nodes: no real names, prices, photos or Storage URLs (this repo is public).
// Photos are inline SVG; a few products have none, so the empty-thumbnail
// placeholder is exercised.

const T0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const COLORS = [["#f4f6fa", "#1b2a44"], ["#111827", "#f5f5f5"], ["#c8102e", "#ffffff"], ["#0b5bd3", "#ffffff"], ["#e8d9b5", "#5b4636"],
  ["#2f6f4f", "#f4f1e8"], ["#f2c94c", "#1d1d1d"], ["#7a8794", "#f0f3f6"]];
const shoe = (i) => {
  const [a, b] = COLORS[i % COLORS.length];
  return "data:image/svg+xml;utf8," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480"><rect width="480" height="480" fill="#f3f5f8"/>` +
    `<path d="M60 300c40-6 70-40 95-80 14-22 40-28 58-12 26 22 52 40 92 48 50 10 92 18 112 44 10 14 6 34-12 38H72c-18 0-26-30-12-38z" fill="${a}" stroke="#1b2a44" stroke-width="5"/>` +
    `<path d="M60 330h378" stroke="${b}" stroke-width="14"/><circle cx="210" cy="232" r="7" fill="${b}"/><circle cx="236" cy="246" r="7" fill="${b}"/></svg>`);
};

const NAMES = ["Air Runner 90 Low", "Court Classic Leather", "Trail Peak GTX", "Street Glide Mid", "Retro Jogger 574", "Canvas Lo Pro", "Velocity Knit Racer",
  "Heritage Suede Low", "Cloud Step Slide", "Forum Mid Strap", "Pulse Trainer II", "Skate Vulc Classic", "Ridge Hiker Mid", "Tempo Road Runner",
  "Baseline Tennis Low", "Metro Slip-On", "Summit Fleece Hoodie", "Club Track Jacket", "Essential Crew Tee", "Training Short 7in", "Logo Cap", "Crew Socks 3-Pack",
  "Daypack 20L", "Wool Beanie"];
const BRANDS = ["Nike", "Adidas", "New Balance", "Puma", "Converse", "Vans", "Asics", "Reebok"];
const TYPES = (i) => (i < 16 ? { category: "Footwear", subcategory: "Sneakers", categoryKey: "sneakers", productType: "Sneakers", sizes: ["5", "6", "7", "8", "9", "10", "11"] }
  : i < 20 ? { category: "Clothing", subcategory: "Tops", categoryKey: "tops", productType: "Clothing", sizes: ["S", "M", "L", "XL"] }
  : { category: "Accessories", subcategory: "Headwear", categoryKey: "headwear", productType: "Accessories", sizes: ["One Size"] });

const products = {};
NAMES.forEach((name, i) => {
  const id = `p${(1790000000000 + i * 7919).toString()}`;
  const noPhoto = i === 5 || i === 21;
  products[id] = {
    id, name: `${BRANDS[i % BRANDS.length]} ${name}`, brand: BRANDS[i % BRANDS.length], ...TYPES(i),
    retailPrice: i % 6 === 3 ? null : 899 + (i % 7) * 150, stockPrice: 420 + (i % 5) * 60,
    styleCode: i % 4 === 2 ? "" : `MC${(4100 + i * 13).toString()}-${(100 + i).toString()}`,
    photoUrl: noPhoto ? null : shoe(i), photo: noPhoto ? "👟" : "", hasShoeBoxOption: i < 16,
    createdAt: T0 - i * 86400000, hubs: ["hub1"],
  };
});
const ids = Object.keys(products);

const shopify_publish = {};
ids.forEach((id, i) => {
  if (i % 5 === 4) return;                    // a few products have no node yet (awaiting)
  const live = i % 3 === 0;
  shopify_publish[id] = {
    state: live ? "live" : i % 7 === 1 ? "blocked" : "awaiting", desiredState: live ? "on" : null,
    condition: live ? "new" : null, cleanName: live ? products[id].name : null, updatedAt: T0 + i * 3600000,
  };
});

const STATUS = ["draft", "draft", "draft", "approved", "approved", "posted", "posted", "discarded", "sample", "draft"];
const CAPTIONS = ["Fresh pairs just landed — come try them on this weekend.", "Weekend run club? Lace up in something light.",
  "Clean whites for every outfit.", "Back in stock: the trail pair everyone asked about.", "Three colourways, one favourite. Which is yours?"];
const social_posts = {};
STATUS.forEach((status, i) => {
  const id = `-post${i.toString().padStart(3, "0")}`;
  social_posts[id] = {
    id, status, kind: i % 3 === 0 ? "reel" : "post", caption: CAPTIONS[i % CAPTIONS.length],
    media: i % 4 === 3 ? [] : [{ type: "image", url: shoe(i), thumbUrl: shoe(i), productId: ids[i] }], platforms: ["instagram", "facebook"],
    createdAt: T0 + i * 7200000, scheduledAt: status === "approved" ? T0 + 86400000 * (i + 1) : null,
    productIds: [ids[i]],
  };
});

export const FIXTURE = {
  ".info": { serverTimeOffset: 0, connected: true },
  products,
  shopify_publish,
  shopify_review_hidden: {},
  social_posts,
  social_style_refs: {},
  social_policy: { captionMax: 2200 },
  social_publisher: { heartbeatAt: T0 },
  users: { "harness-owner": { name: "Junid", email: "gunidmoh@gmail.com", permissions: {}, stockRole: "admin" } },
  orders: {},
  settings: {},
  config: {},
  mirror_switch: { enabled: false },
};

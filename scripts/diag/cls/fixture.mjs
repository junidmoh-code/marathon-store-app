// A small made-up snapshot for the harness (no real data): twenty clothing
// products that Central holds and no Marathon shop carries, so Marathon's
// Clothing list has twenty cards. Names run from one word to far more than
// two lines, and one carries a number to search for.
const cell = (qty) => ({ qty, v: 1, mv: "m1", state: "live" });
const NAMES = [
  "Tee",
  "Essentials Tee Olive",
  "Sweatshirt 25919 yomo stylish cream white",
  "Varsity Jacket",
  "Pant M19678 MF studios right Grey with a very long name that runs on and on past two lines of the card",
  "Box Hoodie",
  "Cargo Pant Black",
  "Track Top Navy",
  "Polo Shirt White",
  "Crew Sweat Grey Marl",
  "Puffer Jacket Stone",
  "Denim Jacket Washed Blue",
  "Shorts Mesh Red",
  "Fleece Pant Charcoal",
  "Long Sleeve Tee Sand",
  "Windbreaker Teal",
  "Knit Jumper Cream",
  "Overshirt Khaki",
  "Graphic Tee Black",
  "Zip Hoodie Forest",
];

export const FIXTURE_NAMES = NAMES;

export function buildFixture() {
  const products = {};
  const central = {};
  NAMES.forEach((name, i) => {
    const id = `p${1795200000000 - i * 1000000}`;   // newest upload first = list order
    products[id] = { name, brand: i % 2 ? "Nike" : "Stussy", productType: "clothing", categoryKey: "t-shirts", subcategory: "T-Shirts", sizes: ["S", "M", "L"] };
    central[id] = { S: cell(9), M: cell(9), L: cell(9) };
  });
  return {
    products,
    stock: { central },
    targets: {},
    recentRequests: {},
    network: { locations: { "marathon-pine": { live: true }, concrete: { live: true }, hub3: { live: true } } },
    config: {
      ruleBasedTargets: true,
      routes: { hub1: "central", hub2: "central", "marathon-pe": "hub2", trophy: "hub2" },
      maxUnitsPerIntent: 20,
      defaultRunByStore: { hub2: { L: 3, M: 3, S: 2 }, "marathon-pe": { L: 2, M: 2, S: 2 }, trophy: { L: 2, M: 2, S: 2 } },
      centralFedClothing: { concrete: 4 },
      concreteDivision: { shopOnly: { oneSize: 5, perSize: 2 } },
    },
    seats: {},
    held: {},
  };
}

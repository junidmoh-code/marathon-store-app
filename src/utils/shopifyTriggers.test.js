// ─── Brand-trigger engine v2 — the compliance contract, pinned ────────────────
// These tests ARE the gateway-compliance guarantee: every assertion here maps
// to a clause of the owner spec (2026-08-13). If one fails, a brand trigger
// can reach the payment gateway — do not weaken an assertion to make a
// refactor pass; fix the engine.
import { describe, it, expect } from "vitest";
import { TRIGGERS, triggersInText, isTriggerFree, cleanTitleFor } from "./shopifyTriggers.js";

const sneaker = { category: "Footwear", subcategory: "Sneakers" };

describe("detection — three trigger categories", () => {
  it("catches parent brands, incl. live misspellings", () => {
    for (const name of ["Nike hoodie", "Adidas tracksuit", "Lacoster bag", "Guccie belt",
                        "Kelvin Klein boxers", "Timbalend boots", "Christian Louboutin heels"]) {
      expect(triggersInText(name).length, name).toBeGreaterThan(0);
    }
  });
  it("catches sub-labels and collabs — the line-mark keep is REVERSED", () => {
    for (const name of ["NOCTA cap", "Essentials hoodie", "Fear of God tee", "Yeezy slide",
                        "Off-White belt", "Travis Scott dunk", "Supreme box tee",
                        "Air Jordan 1", "Jordan backpack white"]) {
      expect(triggersInText(name).length, name).toBeGreaterThan(0);
    }
  });
  it("catches model and silhouette names", () => {
    for (const name of ["Air Force 1 white", "Air Max Plus", "Dunk Low panda", "SB Dunk",
                        "Cortez leather", "Blazer mid", "Pegasus 41", "Vomero 5", "Samba OG",
                        "Gazelle indoor", "Superstar shell", "Campus 00s", "Forum low",
                        "Stan Smith", "Ultraboost light", "NMD R1", "Cloudsurfer trainer",
                        "Cloudmonster 2", "Copa pure", "Predator elite", "Mercurial vapor",
                        "Suede classic", "RS-X reinvention", "9060 grey", "550 white",
                        "990 v6", "2002R protection", "327 navy", "574 core",
                        "Chuck Taylor hi", "Old Skool", "Classic Leather", "Club C 85"]) {
      expect(triggersInText(name).length, name).toBeGreaterThan(0);
    }
  });
  it("matches case-, space- and hyphen-insensitively, inside concatenated tokens", () => {
    for (const name of ["airforce", "Air-Force", "AIRFORCE1", "NikeAirMax", "Jordan1",
                        "nikeairmax 270", "off white", "OFF-WHITE", "Sambarose", "walk'n'dior",
                        "Zoomx runner", "Vapormax flyknit"]) {
      expect(triggersInText(name).length, name).toBeGreaterThan(0);
    }
  });
  it("folds diacritics before matching — accented spellings cannot slip past", () => {
    for (const name of ["Nìke hoodie", "Adídas tracksuit", "Gucçi belt", "Lacosté polo"]) {
      expect(triggersInText(name).length, name).toBeGreaterThan(0);
    }
  });
  it("detection is stricter than removal: triggers spanning word joins still flag", () => {
    expect(triggersInText("cloud monster shoe").length).toBeGreaterThan(0);
    expect(triggersInText("LGuard Breaker Black")).toContain("guard breaker");
  });
  it("word-mode terms never fire inside innocent words", () => {
    for (const text of ["black shirt",          // ck
                        "Samba Kith Classics".replace("Samba ", "").replace("Kith ", ""), // classics ≠ asics
                        "aloha white",          // alo
                        "embossed leather bag", // boss
                        "fair isle jumper",     // air
                        "caravans print tee",   // vans
                        "profile knit",         // fila is word-mode
                        "luggage tag"]) {       // ugg
      expect(triggersInText(text), text).toEqual([]);
    }
  });
  it("deliberate boundaries: supplier marks, 'polo' alone and bare countries are not triggers", () => {
    for (const text of ["YOMO stylish tracksuit", "Shouzhan shirt",
                        "Polo golf shirt", "Slip on sneaker white",
                        // A COUNTRY IS A PLACE, NOT A MARK. The national
                        // federation's crest is the mark; the word is not the
                        // crest, and stripping it would mangle honest
                        // descriptions. Owner may overrule — see the note in
                        // shopifyTriggers.js.
                        "England home jersey white red", "Brazil away shirt yellow",
                        "Portugal training top"]) {
      expect(triggersInText(text), text).toEqual([]);
    }
    // …but Palace alone IS the skate label, and leading-On IS On Running.
    expect(triggersInText("Palace tri-ferg tee")).toContain("palace");
    expect(triggersInText("On Cloudvista 2")).toContain("cloud");
  });

  // ── THE BOUNDARY THAT WAS REVERSED, 2026-08-22 ────────────────────────────
  // Teams and clubs used to be excluded on the reasoning that they are "the
  // product, not the maker". The owner reversed that after "Seattle Mariners"
  // was found live. Pinned here so the reversal is visible and cannot be
  // silently undone by someone reading the old note.
  it("teams, clubs and leagues ARE triggers now (reverses the old 'teams stay' rule)", () => {
    for (const [text, label] of [
      ["Seattle Mariners cap navy", "seattle mariners"],
      ["Atlanta Braves fitted cap cream", "atlanta braves"],
      ["Red Sox fitted cap", "red sox"],
      ["Arsenal home jersey", "arsenal"],
      ["Barcelona tracksuit", "barcelona"],
      ["Manchester United Home Long Sleeve Jersey", "manchester united"],
      ["Paris Saint Germain Woven Tracksuit", "paris saint germain"],
    ]) {
      expect(triggersInText(text), text).toContain(label);
    }
    // Crystal Palace is still the club, not the skate label.
    expect(triggersInText("Crystal Palace jersey")).not.toContain("palace");
  });
});

describe("cleanTitleFor — rebuild", () => {
  it("trigger-free names ship unchanged", () => {
    const r = cleanTitleFor({ name: "YOMO stylish tracksuit black", ...sneaker });
    expect(r).toMatchObject({ title: "YOMO stylish tracksuit black", source: "original", needsAI: false });
  });
  it("rebuilds a generic descriptive title from the record's own vocabulary", () => {
    const r = cleanTitleFor({ name: "Nike Air Force 1 Low black with blue laces", ...sneaker });
    expect(r.title).toBe("Low-top sneaker black with blue laces");
    expect(r.source).toBe("lexicon");
  });
  it("keeps the residue when it still names the product", () => {
    expect(cleanTitleFor({ name: "Adidas Tracksuit Maroon", category: "Clothing", subcategory: "Tracksuits & Sets" }).title)
      .toBe("Tracksuit Maroon");
    expect(cleanTitleFor({ name: "Lacoste T-Shirt Black", category: "Clothing", subcategory: "T-Shirts" }).title)
      .toBe("T Shirt Black");
  });
  it("drops orphan model numbers once their mark is gone", () => {
    const r = cleanTitleFor({ name: "Air Jordan 3 Retro Pink Crackle", ...sneaker });
    expect(r.title).toBe("Sneaker Retro Pink Crackle");
  });
  it("kills boundary-spanning spellings whole", () => {
    const r = cleanTitleFor({ name: "Lacoste LGuard Breaker Black White", ...sneaker });
    expect(r.needsAI).toBe(false);
    expect(isTriggerFree(r.title)).toBe(true);
    expect(r.title.toLowerCase()).not.toContain("guard");
  });
  it("a name that is nothing but brand becomes its silhouette noun", () => {
    expect(cleanTitleFor({ name: "Louis Vuitton", category: "Accessories", subcategory: "Bags" }).title).toBe("Bag");
  });
  it("guards: never empty, digit-leading, under 3 chars, or uncategorised-noun-less", () => {
    expect(cleanTitleFor({ name: "", ...sneaker })).toMatchObject({ needsAI: true, reason: "empty name" });
    expect(cleanTitleFor({ name: "9078", category: "Clothing", subcategory: "Jeans & Denim" }))
      .toMatchObject({ needsAI: true, reason: "digit-leading name" });
    expect(cleanTitleFor({ name: "H", category: "Clothing", subcategory: "T-Shirts" }))
      .toMatchObject({ needsAI: true, reason: "name under 3 chars" });
    expect(cleanTitleFor({ name: "Nike", category: null, subcategory: null }).needsAI).toBe(true);
  });
  it("NEVER ships the original name for a triggered product (v1 contract is gone)", () => {
    const r = cleanTitleFor({ name: "Nike Air Max 97", category: null, subcategory: null });
    expect(r.needsAI).toBe(true);
    expect(r.title).toBeNull();
  });
  it("no trigger survives any rebuilt title (full nasty sweep)", () => {
    const nasty = [
      "Nike Air Force 1 '07 white", "AIRFORCE1 black", "Nike-Air-Max-Plus TN", "Jordan1 white",
      "Adidas Handball Spezial", "New Balance 9060 creem", "Louis Vuitton Time Out White",
      "Kalr Lagerfeld men's karpri konik black", "EA7 Emporio Armani Tracksuit White",
      "Nike x Corteiz NRG Tracksuit Grey", "eNike Air More Uptempo '96 'Triple White'.",
      "Birkenstock Arizona Taupe Suede", "D&G light blue 100ML", "Creed absolute aventus",
      "On Cloudvista 2 Off White", "Nike Zoomx Invincible Run Flyknit Black",
    ];
    for (const name of nasty) {
      const r = cleanTitleFor({ name, category: "Footwear", subcategory: "Sneakers" });
      if (!r.needsAI) expect(isTriggerFree(r.title), `${name} → ${r.title}`).toBe(true);
    }
  });
});

describe("lexicon hygiene", () => {
  it("every trigger has a non-empty squash and at least one variant", () => {
    for (const t of TRIGGERS) {
      expect(t.variants.length).toBeGreaterThan(0);
      for (const v of t.variants) expect(v.sq.length, t.label).toBeGreaterThan(0);
    }
  });
  it("short squash-mode triggers do not exist (they would shred innocent words)", () => {
    for (const t of TRIGGERS) {
      if (t.mode !== "word") {
        for (const v of t.variants) expect(v.sq.length, `${t.label} must be word-mode`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

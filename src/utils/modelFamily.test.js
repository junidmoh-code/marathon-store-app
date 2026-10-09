import { describe, it, expect } from "vitest";
import { modelFamilyOf, familyLabel, styleBase, fallbackFamily, cutFromName, FAMILY_RULES } from "./modelFamily";
import { encodeAltProfile, decodeAltProfile, deriveAltProfile, coloursFromName, emptyAltProfile } from "./altProfile";

const fam = (name, brand = "Nike", extra = {}) => modelFamilyOf({ name, brand, ...extra }).fam;

describe("one model, every spelling the catalogue uses", () => {
  // Real names from the live catalogue, 2026-10-09.
  it.each([
    "Air force white", "Nike Air force1 white", "Nike Air Force 1 White", "Nike Air force1 ", "Nike air force1 x nocta red",
    "Air force blue ", "Nike airforce 1 Green", "Nike airforce black", "Airforce Nike Louis Vuitton black end white ",
    "Nike Air Force 1 Low Ducks of a Feather University of Oregon Duck or Egg", "Nike Air Force 1 '07 White Chlorophyll",
    "Supreme x Nike air force 1 purple", "Nike AF1 Shadow",
  ])("%s → Air Force 1", (name) => {
    expect(fam(name)).toBe("nike-air-force-1");
  });
  it("a Court Vision named 'Airforce' is a Court Vision", () => {
    expect(fam("Nike Airforce Court Vision Alta Low White Grey (Women's)")).toBe("nike-court-vision");
  });
  it.each([
    ["Air Jordan 4 Retro White Levi's", "jordan-4"], ["Air Jordan 1 Low Panda", "jordan-1"], ["Jordan 11 Retro Bred", "jordan-11"],
    ["Nike SB Dunk Low Supreme", "nike-dunk"], ["Nike Air Max Plus TN Black", "nike-air-max-plus"], ["Nike Air Max 90 White", "nike-air-max-90"],
    ["Adidas Samba OG White", "adidas-samba"], ["Adidas Sambarose", "adidas-samba"], ["New Balance 9060 Grey", "nb-9060"],
    ["On Cloudsurfer Black", "on-cloudsurfer"], ["Lacoste L-Guard Breaker", "lacoste-l-guard"], ["Nike Zoom Vomero 5 Triple White", "nike-vomero"],
  ])("%s → %s", (name, id) => {
    expect(fam(name, "")).toBe(id);
  });
  it("every rule id is unique and labelled", () => {
    const ids = FAMILY_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of FAMILY_RULES) expect(familyLabel(r.id)).toBeTruthy();
  });
});

describe("the other sources, in order", () => {
  it("the vision namer's model when the name says nothing", () => {
    expect(modelFamilyOf({ name: "Nike Green", brand: "Nike", identityModel: "Air Force 1 Mid SP" })).toMatchObject({ fam: "nike-air-force-1", src: "identity" });
  });
  it("the box label's model name next", () => {
    expect(modelFamilyOf({ name: "Lacoste black green", brand: "Lacoste", labelModelName: "CARNABY EVOLIGHT-WT 1191" })).toMatchObject({ fam: "lacoste-carnaby", src: "label" });
  });
  it("a style-code sibling, then the fallback", () => {
    expect(modelFamilyOf({ name: "Nike Green Duck", brand: "Nike", siblingFamily: "nike-air-force-1" })).toMatchObject({ fam: "nike-air-force-1", src: "stylecode" });
    expect(modelFamilyOf({ name: "Loro Piana Open Walk Brown", brand: "Loro Piana" })).toMatchObject({ fam: "loro-piana-open", src: "fallback" });
  });
  it("the fallback skips colours and filler, joins a lettered prefix, and refuses without a brand", () => {
    expect(fallbackFamily("Diesel S-Ukiyo V2 Black", "Diesel")).toBe("diesel-sukiyo");
    expect(fallbackFamily("Boss Low Full Black", "Boss")).toBe("");
    expect(fallbackFamily("Something", "")).toBe("");
  });
  it("a hostile sibling id is refused", () => {
    expect(modelFamilyOf({ name: "x", brand: "", siblingFamily: "__proto__" }).fam).toBe("");
  });
  it("style-code base is Nike-shaped only", () => {
    expect(styleBase("FV7613100")).toBe("FV7613");
    expect(styleBase("IE3437")).toBe("");
    expect(styleBase(null)).toBe("");
  });
  it("cut words set low/mid/high and adjust a trainer's silhouette", () => {
    expect(cutFromName("Air Jordan 1 Low")).toBe("low");
    expect(modelFamilyOf({ name: "Air Jordan 1 Low" }).sil).toBe("low-top");
    expect(modelFamilyOf({ name: "Nike Air Force 1 Mid" }).sil).toBe("mid");
    expect(modelFamilyOf({ name: "Nike Air Max 90" }).sil).toBe("runner");
  });
});

describe("the profile string", () => {
  const full = {
    ...emptyAltProfile(), fam: "nike-air-force-1", famSrc: "name", cut: "low", sil: "low-top", col: "white", col2: "green",
    mat: "leather", pat: "multi", sole: "cup", soleCol: "white", fin: "plain", clo: "laced", toe: "round", tags: ["retro", "basketball"], en: true,
  };
  it("round-trips", () => {
    expect(decodeAltProfile(encodeAltProfile(full))).toEqual(full);
  });
  it("is short — it rides on the node every device streams", () => {
    expect(encodeAltProfile(full).length).toBeLessThan(110);
  });
  it("illegal values are dropped, never coerced", () => {
    const p = decodeAltProfile(encodeAltProfile({ ...full, col: "UNKNOWN", sil: "__proto__", tags: ["Nike", "retro"], fam: "Bad Id" }));
    expect(p.col).toBe("");
    expect(p.sil).toBe("");
    expect(p.tags).toEqual(["retro"]);
    expect(p.fam).toBe("");
  });
  it("a hand-edited string with an illegal slot keeps the rest", () => {
    const s = encodeAltProfile(full).replace("|white|green|", "|purple-ish|green|");
    expect(decodeAltProfile(s)).toMatchObject({ col: "", col2: "green", fam: "nike-air-force-1" });
  });
  it("another version or shape reads as absent", () => {
    expect(decodeAltProfile("2" + encodeAltProfile(full).slice(1))).toBe(null);
    expect(decodeAltProfile("1|a|b")).toBe(null);
    expect(decodeAltProfile(null)).toBe(null);
    expect(decodeAltProfile(["1"])).toBe(null);
  });
  it("empty tags encode as an empty slot, never an array (RTDB deletes empty arrays)", () => {
    const s = encodeAltProfile({ ...full, tags: [] });
    expect(typeof s).toBe("string");
    expect(decodeAltProfile(s).tags).toEqual([]);
  });
  it("the name fallback reads colours it can name and nothing else", () => {
    expect(coloursFromName("Nike Air Force 1 Low Ducks of a Feather Duck or Egg")).toEqual([]);
    expect(coloursFromName("Nike airforce 1 cream white end red")).toEqual(["cream", "white"]);
    expect(deriveAltProfile({ name: "Air force blue", categoryKey: "sneakers" }).col).toBe("blue");
  });
});

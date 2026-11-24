// The address safety gate's matcher (Junid, 24 Nov 2026) — offline, against the vendored Post Office / GeoNames tables.
import { describe, it, expect } from "vitest";
import { checkAddress, checkLockerArea, norm, postalCode, typoOf, codeSays, addressFingerprint } from "./addressCheck.mjs";

// #2316 exactly as the order holds it (key 19024021749909).
const ORDER_2316 = { address1: "BB 1112 Zibhebhu Avenue", address2: "Umlazi", city: "Umlazi BB, eThekwini", province: "KwaZulu-Natal", zip: "1475", country: "South Africa" };
// The locker it was booked to, as Courier Guy lists it (CG306, Vosloorus) and one in Umlazi itself.
const CG306 = { id: "CG306", name: "Pick n Pay Sam Sekoti", lat: -26.3525, lng: 28.2134, tcgAddress: { street_address: "Sam Sekoati Avenue", local_area: "Vosloorus Ext 9", city: "Vosloorus", zone: "Gauteng", code: "1475" } };
const UMLAZI_LOCKER = { id: "RVM02045", name: "BP Sam Service Station", lat: -29.9801875, lng: 30.8919375, tcgAddress: { street_address: "00 Mkhiwane St, Umlazi Q, Umlazi, 4066", local_area: "Umlazi Q", city: "Umlazi", zone: "KwaZulu-Natal", code: "4066" } };

describe("checkAddress: postal code ↔ suburb/town", () => {
  it("#2316 is HELD: Umlazi with Vosloorus's 1475, both named", () => {
    const c = checkAddress(ORDER_2316);
    expect(c).toMatchObject({ ok: false, kind: "mismatch", code: "1475", addressPlace: "Umlazi", zipSays: { place: "Vosloorus", province: "Gauteng", text: "1475 (Vosloorus, Gauteng)" } });
    expect(c.why).toMatch(/the address says Umlazi but postal code 1475 \(Vosloorus, Gauteng\) is \d+ km away/);
    expect(c.addressCodes).toContain("4031");
  });

  it("the same address with Umlazi's own codes passes (4031, 4066), uMlazi spelt any way", () => {
    for (const zip of ["4031", "4066"]) expect(checkAddress({ ...ORDER_2316, zip })).toMatchObject({ ok: true, code: zip });
    expect(checkAddress({ ...ORDER_2316, address2: "uMlazi", city: "eThekwini", zip: "4031" }).ok).toBe(true);
  });

  it("correct addresses pass: listed suburbs, metro names, townships under the big town", () => {
    const good = [
      { address1: "5 Esplanade Road", address2: "Century City", city: "Cape Town", province: "Western Cape", zip: "7441" },
      { address1: "11766a Mtipa Street", address2: "Orlando West", city: "Soweto", province: "Gauteng", zip: "1804" },
      { address1: "39 Chelsea Drive", city: "Durban", province: "KwaZulu-Natal", zip: "4001" },
      { address1: "24 Ralston Road", address2: "Fernglen", city: "Gqeberha", province: "Eastern Cape", zip: "6045" },
      { address1: "228 Moorcross Drive", city: "Chatsworth", province: "KwaZulu-Natal", zip: "4092" },
      { address1: "848 Khozi Street Naledi Ext 2", city: "Johannesburg", province: "Gauteng", zip: "1861" }, // the street line's suburb, a big town nearby
      { street_address: "5 Esplanade Road", local_area: "Century City", city: "Cape Town", zone: "WC", code: "7441" }, // Courier Guy's shape
    ];
    for (const a of good) expect([a, checkAddress(a).ok]).toEqual([a, true]);
  });

  it("a wrong PROVINCE alone never holds (Shopify's list is mis-picked all the time): noted only", () => {
    const c = checkAddress({ address1: "27 Blankblaar", city: "Rooiberg", province: "Gauteng", zip: "0500" });
    expect(c).toMatchObject({ ok: true, provinceNote: expect.stringMatching(/typed Gauteng; postal code 0500 reads as Limpopo/) });
  });

  it("other real mismatches from the last 600 orders are held", () => {
    expect(checkAddress({ address1: "149 Afrikaner street", city: "Hopetown", province: "Northern Cape", zip: "4066" })).toMatchObject({ ok: false, kind: "mismatch" });
    expect(checkAddress({ address1: "26 new street", address2: "Office", city: "Johannesburg", province: "Gauteng", zip: "6139" })).toMatchObject({ ok: false, kind: "mismatch" });
  });

  it("every field must agree: a listed suburb never outvotes a far town (architect review, #985)", () => {
    expect(checkAddress({ address1: "1 Main Rd", address2: "Umlazi", city: "Johannesburg", province: "KwaZulu-Natal", zip: "4031" }).ok).toBe(false);
    expect(checkAddress({ address1: "1 Main Rd", address2: "Century City", city: "Johannesburg", province: "Western Cape", zip: "7441" }).ok).toBe(false);
    // …but a building or street name in the suburb line does not hold a right town and code.
    expect(checkAddress({ address1: "5 Osklands Golf Estate", address2: "Athlone street", city: "Boksburg", province: "Gauteng", zip: "1459" }).ok).toBe(true);
  });

  it("ambiguity is a mismatch: an unknown code, a non-code, or no place we can match", () => {
    expect(checkAddress({ address1: "273 Maltzan Street", city: "Pretoria", province: "Gauteng", zip: "0111" })).toMatchObject({ ok: false, kind: "unknown_code" });
    expect(checkAddress({ address1: "1 Road", city: "Durban", zip: "40011" })).toMatchObject({ ok: false, kind: "bad_code" });
    expect(checkAddress({ address1: "1 Road", city: "", zip: "" })).toMatchObject({ ok: false, kind: "bad_code" });
    expect(checkAddress({ address1: "2150 Motswiri Street", city: "Qwertyville", province: "Gauteng", zip: "1818" })).toMatchObject({ ok: false, kind: "unmatched" });
  });

  it("a misspelt name of the code's OWN place agrees with it, never a misspelling of somewhere else", () => {
    expect(typoOf("Pietermaritsburg", ["pietermaritzburg"])).toEqual(["pietermaritzburg"]);
    expect(typoOf("Umlazzi", ["vosloorus"])).toEqual([]);
    expect(checkAddress({ address1: "94 Melsetter", city: "Pietermaritsburg", province: "KwaZulu-Natal", zip: "3201" }).ok).toBe(true);
  });

  it("helpers: norm, postalCode, codeSays, the fingerprint", () => {
    expect(norm("  uMlázi BB, eThekwini ")).toBe("umlazi bb ethekwini");
    expect(postalCode("475")).toBe("0475");
    expect(postalCode("4031 ")).toBe("4031");
    expect(postalCode("ABCD")).toBe("");
    expect(codeSays("4031").place).toBe("Umlazi");
    expect(addressFingerprint(ORDER_2316)).not.toBe(addressFingerprint({ ...ORDER_2316, zip: "4031" }));
  });
});

describe("checkLockerArea: the locker must be in the customer's area", () => {
  const umlazi = checkAddress({ ...ORDER_2316, zip: "4031" });
  it("a locker in another town (Vosloorus, for an Umlazi customer) is held", () => {
    const lk = checkLockerArea(CG306, umlazi);
    expect(lk.ok).toBe(false);
    expect(lk.km).toBeGreaterThan(300);
    expect(lk.why).toMatch(/Pick n Pay Sam Sekoti is \d+ km from the customer's area/);
  });
  it("a locker in the customer's own area passes", () => {
    expect(checkLockerArea(UMLAZI_LOCKER, umlazi).ok).toBe(true);
    // No code match and no name match: judged by the distance alone.
    expect(checkLockerArea({ ...UMLAZI_LOCKER, tcgAddress: undefined }, umlazi)).toMatchObject({ ok: true, by: "distance" });
  });
  it("a namesake locker with a point is judged by distance, never by its name (architect review, #985)", () => {
    expect(checkLockerArea({ ...CG306, tcgAddress: { ...CG306.tcgAddress, local_area: "Umlazi", city: "Umlazi" } }, umlazi).ok).toBe(false);
  });
  it("a locker placed from the customer's own point (Shopify/street) within the limit passes; one placed by POSTAL CODE is judged by the area", () => {
    expect(checkLockerArea({ ...CG306, placedBy: "shopify", km: 2.1 }, umlazi)).toMatchObject({ ok: true, by: "placed" });
    expect(checkLockerArea({ ...CG306, placedBy: "postcode", km: 1.3 }, umlazi).ok).toBe(false);
  });
  it("a locker with no point and no code cannot be shown to be near: held", () => {
    expect(checkLockerArea({ id: "X1", name: "Somewhere" }, umlazi)).toMatchObject({ ok: false, km: null });
  });
});

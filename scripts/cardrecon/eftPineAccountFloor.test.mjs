// ─── PINE'S FNB ACCOUNT: CONFIRMS ONLY PAYMENTS DATED 2026-11-10 OR LATER ─────
// Junid, 10 Nov 2026. Marathon Pine's FNB account (the allowed account whose
// number starts 63) was settled by hand until auto-confirm went on for Pine.
// A payment into it dated before 2026-11-10 was already handled, so it must
// REFUSE; from 2026-11-10 it confirms under every normal rule. Marathon's FNB
// account (starts 62), Concrete's Standard Bank account and the global
// 2026-10-20 cutoff are untouched. Each case runs the poller's own chain:
// reader → destination → timing → datedVerdict → pool record.
//
// ACCOUNT NUMBERS HERE ARE STAND-INS (this repo is public).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { selectReader } from "./eftBanks.mjs";
import {
  authenticationVerdict, destinationVerdict, enforcesImmediateOnly, immediacyVerdict,
  parsePaymentDateCutoff, parseAccountPolicies, eftPoolRecord,
  ACCOUNT_EFFECTIVE_FROM, resolveAccountFloors, accountFloorVerdict, datedVerdict, paymentDateVerdict,
} from "./eftCore.mjs";

const MARATHON_FNB = "62900004321";
const PINE_FNB = "63000005678";
const CONCRETE_SB = "10100008534";
const ENV = `${MARATHON_FNB}, ${PINE_FNB}, ${CONCRETE_SB}:standardbank:immediate`;
const POLICIES = parseAccountPolicies(ENV);
const FLOORS = resolveAccountFloors(POLICIES);
const CUTOFF = parsePaymentDateCutoff(undefined); // the global 2026-10-20, unchanged
const sast = (s) => Date.parse(`${s}+02:00`);

const auth = (domain, from) => authenticationVerdict({
  fromAddress: from,
  headerLines: [
    { key: "authentication-results", line: `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@${domain} header.s=s1 header.b=x;\r\n       spf=pass smtp.mailfrom=${domain};\r\n       dmarc=pass (p=REJECT) header.from=${domain}` },
    { key: "from", line: `From: <${from}>` },
  ],
});

const CAPITEC_FROM = "noreply@capitecbank.co.za";
const capitec = ({ type = "Immediate Payment", bank = "First National Bank", account = PINE_FNB, date = "10/11/2026 09:30" } = {}) => [
  "Payment Notification", "Capitec Bank",
  "Please take note that A Customer made a payment to your account.",
  "Notification number 600001",
  `Payment date ${date}`,
  "Beneficiary name MARATHON",
  `Bank name ${bank}`,
  `Account number ${account}`,
  "Branch 250655",
  `Payment type ${type}`,
  "Amount R450.00",
  "Payment reference CUSTREF",
];
const toPine = (o) => capitec({ account: PINE_FNB, ...o });
const toMarathon = (o) => capitec({ account: MARATHON_FNB, ...o });
const toConcrete = (o) => capitec({ bank: "Standard Bank", account: CONCRETE_SB, type: "Regular Payment", ...o });

/** The poller's chain (email-poller.mjs), floors resolved as config() does. */
function decide(lines, { receivedAt, floors = FLOORS.floors, policies = POLICIES } = {}) {
  const reader = selectReader({ fromDomain: "capitecbank.co.za", lines });
  const parsed = reader.parse(lines);
  expect(parsed.ok, parsed.reason).toBe(true);
  const at = receivedAt ?? parsed.bankTs;
  const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: policies, configured: true });
  const timing = immediacyVerdict({ parsed, reader: reader.id, receivedAt: at, immediateOnly: account?.ok === true && enforcesImmediateOnly(account) });
  const dated = datedVerdict({ parsed, cutoff: CUTOFF, account, floors });
  return eftPoolRecord({
    message: { messageId: "<m@x>", from: CAPITEC_FROM, subject: "Payment", receivedAt: at },
    verdict: auth("capitecbank.co.za", CAPITEC_FROM), parsed, account, timing, dated, reader: reader.id, rawText: lines.join("\n"), at,
  });
}

describe("the floor is Pine's FNB account only, found by its 63 prefix", () => {
  it("one floor, 2026-11-10, on FNB …(Pine's last four) — no full number kept", () => {
    expect(ACCOUNT_EFFECTIVE_FROM).toEqual([{ bank: "fnb", prefix: "63", from: "2026-11-10", label: "Marathon Pine's FNB account" }]);
    expect(FLOORS.problems).toEqual([]);
    expect(FLOORS.floors).toEqual([{ bank: "fnb", tail: "5678", from: "2026-11-10", startMs: sast("2026-11-10T00:00:00"), label: "Marathon Pine's FNB account" }]);
    expect(JSON.stringify(FLOORS)).not.toContain(PINE_FNB);
  });

  it("Marathon's 62 account and Concrete's Standard Bank account get no floor", () => {
    expect(FLOORS.floors.some((f) => f.tail === "4321" || f.tail === "8534")).toBe(false);
  });

  it("a 63-prefixed account at another bank is not Pine's FNB account", () => {
    const r = resolveAccountFloors(parseAccountPolicies(`${MARATHON_FNB}, 63000001111:standardbank`));
    expect(r.floors).toEqual([]);
    expect(r.problems[0]).toMatch(/no allowed FNB account starts 63/);
  });

  it("a Pine entry given as last four only cannot be identified — said, never guessed", () => {
    const r = resolveAccountFloors(parseAccountPolicies(`${MARATHON_FNB}, 5678`));
    expect(r.floors).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });
});

describe("into Pine's FNB account (63…)", () => {
  it("dated 2026-11-09 → REFUSED by the floor, as refused-stale-date, with nothing spendable", () => {
    const r = decide(toPine({ date: "09/11/2026 15:10" }));
    expect(r.outcome).toBe("refused-stale-date");
    expect(r.cutoff).toBe("2026-11-10");
    expect(r.status).toBeUndefined();
    expect(r.reason).toContain("the bank dates this payment 2026-11-09");
    expect(r.reason).toContain("Marathon Pine's FNB account only confirms payments dated 2026-11-10 or later");
    expect(r.reason).not.toContain(PINE_FNB);
  });

  it("the last minute of 9 Nov SAST refuses; the first instant of 10 Nov confirms", () => {
    expect(decide(toPine({ date: "09/11/2026 23:59" })).outcome).toBe("refused-stale-date");
    const r = decide(toPine({ date: "10/11/2026 00:00" }));
    expect(r.outcome).toBe("recorded");
    expect(r.status).toBe("unmatched");
  });

  it("earlier days into Pine refuse too (2 Nov, 25 Oct) — the floor, not the global cutoff, decides", () => {
    for (const date of ["02/11/2026 10:00", "25/10/2026 10:00"]) {
      const r = decide(toPine({ date }));
      expect(r.outcome, date).toBe("refused-stale-date");
      expect(r.cutoff, date).toBe("2026-11-10");
    }
  });

  it("dated 2026-11-10 → CONFIRMS normally (recorded, unmatched, amount and reference kept)", () => {
    const r = decide(toPine({ date: "10/11/2026 09:30" }));
    expect(r.outcome).toBe("recorded");
    expect(r.status).toBe("unmatched");
    expect(r.amountCents).toBe(45000);
    expect(r.reference).toBe("CUSTREF");
    expect(r.accountTail).toBe("5678");
  });

  it("the normal rules still apply from the 10th: a payment dated beyond the next business day is still refused", () => {
    expect(decide(toPine({ date: "13/11/2026 09:30" }), { receivedAt: sast("2026-11-10T12:00:00") }).outcome).toBe("refused-not-immediate");
  });

  it("an OLD proof forwarded today is judged on the bank's date, not the email's arrival", () => {
    expect(decide(toPine({ date: "07/11/2026 11:00" }), { receivedAt: sast("2026-11-10T12:00:00") }).outcome).not.toBe("recorded");
  });

  it("dated 19 Oct the global cutoff still refuses first (its own 2026-10-20 cutoff is what the record names)", () => {
    const r = decide(toPine({ date: "19/10/2026 09:30" }));
    expect(r.outcome).toBe("refused-stale-date");
    expect(r.cutoff).toBe("2026-10-20");
  });
});

describe("every other account is unchanged", () => {
  it("Marathon's 62 account: dated 2026-11-09 still CONFIRMS", () => {
    const r = decide(toMarathon({ date: "09/11/2026 15:10" }));
    expect(r.outcome).toBe("recorded");
    expect(r.accountTail).toBe("4321");
  });

  it("Marathon's 62 account: the global 2026-10-20 cutoff still refuses 19 Oct and admits 20 Oct", () => {
    const stale = decide(toMarathon({ date: "19/10/2026 09:30" }));
    expect(stale.outcome).toBe("refused-stale-date");
    expect(stale.cutoff).toBe("2026-10-20");
    expect(decide(toMarathon({ date: "20/10/2026 09:30" })).outcome).toBe("recorded");
  });

  it("Concrete's Standard Bank account: dated 2026-11-09 (non-immediate) still CONFIRMS; 19 Oct still refuses", () => {
    const r = decide(toConcrete({ date: "09/11/2026 15:10" }));
    expect(r.outcome).toBe("recorded");
    expect(r.accountTail).toBe("8534");
    expect(r.immediate).toBe(false);
    expect(decide(toConcrete({ type: "Immediate Payment", date: "19/10/2026 09:30" })).outcome).toBe("refused-stale-date");
  });

  it("with no floors at all the chain is exactly the global cutoff for every account (datedVerdict ≡ paymentDateVerdict)", () => {
    for (const [lines, day] of [[toMarathon({ date: "09/11/2026 10:00" }), "9 Nov"], [toConcrete({ date: "09/11/2026 10:00" }), "9 Nov SB"], [toMarathon({ date: "19/10/2026 10:00" }), "19 Oct"]]) {
      const reader = selectReader({ fromDomain: "capitecbank.co.za", lines });
      const parsed = reader.parse(lines);
      const account = destinationVerdict({ accountMask: parsed.accountMask, destBankName: parsed.destBankName, allowedAccounts: POLICIES, configured: true });
      expect(datedVerdict({ parsed, cutoff: CUTOFF, account, floors: FLOORS.floors }), day).toEqual(paymentDateVerdict({ parsed, cutoff: CUTOFF }));
    }
  });

  it("a refused destination is not the floor's business (the account check refuses it)", () => {
    expect(accountFloorVerdict({ parsed: { bankTs: 1 }, account: { ok: false, reason: "x" }, floors: FLOORS.floors })).toEqual({ ok: true });
  });

  it("an unreadable bank date into Pine refuses rather than assumes", () => {
    const out = accountFloorVerdict({ parsed: { bankTs: null }, account: { ok: true, bank: "fnb", tail: "5678" }, floors: FLOORS.floors });
    expect(out.ok).toBe(false);
    expect(out.cutoff).toBe("2026-11-10");
  });
});

describe("the poller wires it in", () => {
  const src = readFileSync(new URL("./email-poller.mjs", import.meta.url), "utf8");
  it("resolves the floors from EFT_ALLOWED_ACCOUNTS and judges every payment with datedVerdict", () => {
    expect(src).toMatch(/eftAccountFloors: resolveAccountFloors\(parseAccountPolicies\(env\.EFT_ALLOWED_ACCOUNTS\)\)/);
    expect(src).toMatch(/datedVerdict\(\{ parsed: group\.parse, cutoff: cfg\.eftPaymentDateCutoff, account, floors: cfg\.eftAccountFloors\.floors \}\)/);
    expect(src).not.toMatch(/paymentDateVerdict\(\{ parsed: group\.parse/);
  });
});

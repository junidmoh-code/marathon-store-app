// The poller's mail round for "Unread – needs manual entry" notices: what is
// sent, to whom, what is reported back, and that one failed send never costs
// the others or goes unreported.
import { describe, it, expect } from "vitest";
import { planNoticeRound, noticeMail, deliverNotices } from "./noticeCore.mjs";

const reply = (notices, to = "junidmoh@gmail.com") => ({ ok: true, to, notices });
const N = (key, subject = "Card recon: Marathon Till 2 — Wed 7 Oct 2026 slip unread, needs manual entry") =>
  ({ key, subject, text: "Marathon Till 2 (terminal 0000HP1X) has no recorded batch." });
const quiet = { log: () => {}, error: () => {} };

describe("planNoticeRound", () => {
  it("takes the server's recipient and well-formed notices only", () => {
    const p = planNoticeRound(reply([N("pe~0000HP1X~2026-10-07"), { key: "../x", subject: "s", text: "t" }, { key: "k" }]));
    expect(p.to).toBe("junidmoh@gmail.com");
    expect(p.notices.map((n) => n.key)).toEqual(["pe~0000HP1X~2026-10-07"]);
  });

  it("sends nothing without a valid recipient, or without a server answer", () => {
    expect(planNoticeRound(reply([N("a")], "not an address")).notices).toEqual([]);
    expect(planNoticeRound(reply([N("a")], "x@y.com\nBcc: z@q.com")).notices).toEqual([]);
    expect(planNoticeRound(null).refusal).toMatch(/did not hand over/);
  });

  it("a subject is one line — no header can ride in on it", () => {
    const p = planNoticeRound(reply([N("a", "Card recon\r\nBcc: someone@else.com")]));
    expect(p.notices[0].subject).toBe("Card recon Bcc: someone@else.com");
    expect(p.notices[0].subject).not.toMatch(/[\r\n]/);
  });

  it("caps a round at ten", () => {
    expect(planNoticeRound(reply(Array.from({ length: 14 }, (_, i) => N(`k${i}`)))).notices).toHaveLength(10);
  });
});

describe("deliverNotices", () => {
  it("sends each notice from the shop mailbox to Junid, then reports every outcome back", async () => {
    const calls = [];
    const sent = [];
    const call = async (data) => { calls.push(data); return data.action === "notices" ? reply([N("a"), N("b")]) : { ok: true }; };
    const send = async (mail) => { sent.push(mail); if (mail.subject.includes("FAIL")) throw new Error("x"); };
    const r = await deliverNotices({ call, send, from: "marathon6631@gmail.com", log: quiet });
    expect(r).toEqual({ sent: 2, failed: 0, refusal: null });
    expect(sent.map((m) => [m.from, m.to])).toEqual([["marathon6631@gmail.com", "junidmoh@gmail.com"], ["marathon6631@gmail.com", "junidmoh@gmail.com"]]);
    expect(calls.at(-1)).toEqual({ action: "noticeSent", results: [{ key: "a", ok: true }, { key: "b", ok: true }] });
  });

  it("one failed send is reported as failed and the rest still go", async () => {
    const calls = [];
    const call = async (data) => { calls.push(data); return data.action === "notices" ? reply([N("a", "FAIL one"), N("b")]) : { ok: true }; };
    const send = async (mail) => { if (mail.subject.includes("FAIL")) throw Object.assign(new Error("Invalid login"), { response: "535-5.7.8 Username and Password not accepted" }); };
    const r = await deliverNotices({ call, send, from: "m@x.com", log: quiet });
    expect(r).toEqual({ sent: 1, failed: 1, refusal: null });
    expect(calls.at(-1).results).toEqual([
      { key: "a", ok: false, error: "535-5.7.8 Username and Password not accepted" },
      { key: "b", ok: true },
    ]);
  });

  it("nothing queued: no mail, and no second call", async () => {
    const calls = [];
    const call = async (data) => { calls.push(data); return reply([]); };
    const r = await deliverNotices({ call, send: async () => { throw new Error("must not send"); }, from: "m@x.com", log: quiet });
    expect(r.sent).toBe(0);
    expect(calls).toEqual([{ action: "notices" }]);
  });

  it("the mail is plain text with the notice's own words and nothing added", () => {
    const m = noticeMail({ from: "m@x.com", to: "j@x.com", notice: N("a") });
    expect(Object.keys(m).sort()).toEqual(["from", "subject", "text", "to"]);
  });
});

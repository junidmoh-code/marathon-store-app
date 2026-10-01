# Device enrolment — runbook

Every device on MC's shared login needs a personal 4-digit code (PR #647).
Design: `functions/lib/device-enrolment.cjs` (top of file) and `src/device/enrolment.js`.

## Switches and data

| What | Where |
|---|---|
| A login needs a code per device | `/users/{uid}/deviceCodeRequired = true` (set for MC: `oBvHU5gjelRbnyFW2KnNLP9Rofy2`) |
| A device's live enrolment | `/users/{uid}/deviceGate/{deviceId} = eid` (deleted by a revoke) |
| People, devices, codes, attempts, email queue | `/device_enrolment/*` — no client read; the admin screen goes through `deviceEnrolmentAdmin` |
| Admin screen | store app → **Device Codes** tile (`#admin/devices`) — Junid, or MC's device if MC's code was made with "Can make and revoke codes" |

**Off switch:** remove `/users/{mcUid}/deviceCodeRequired`. Every device on MC's login works as before at once, with or without the rules below.

## One-time setup (done at deploy, 2026-09-25)

1. The functions' service account can sign custom tokens: `roles/iam.serviceAccountTokenCreator` on `306270814317-compute@developer.gserviceaccount.com`, granted on itself.
2. Deploy `functions:enrolDevice,functions:deviceEnrolmentAdmin,functions:deviceEnrolmentEmail` and `hosting:marathon-club`.
3. `node scripts/device-enrolment/install-enrolment-alarm.mjs` (on the mini, with `ACCESS_TOKEN`) — the email policy.
4. `/users/{mcUid}/deviceCodeRequired = true`.
5. **Junid pastes the rules** (the one manual step):
   `node scripts/device-enrolment/print-device-enrolment-rules.mjs live-rules.json out.json`, then paste `out.json` in Firebase console → Realtime Database → Rules.
   Until it is pasted, the code screen works but is not enforced on the server. Last-seen and reject counts also stay blank until then.

## The rules, proven

`node scripts/device-enrolment/prove-device-enrolment-rules.mjs live-rules.json` — output against the live rules of 2026-09-25:

```
── TODAY, on the live rules: any phone with MC's PIN can write (these SHOULD succeed) ──
  ✓ TODAY: MC on a password session writes an order
  ✓ TODAY: MC on a password session writes a stock movement

candidate loaded (101 write and 99 read rules carry the device condition)

── an UNENROLLED phone on MC's login is refused everywhere ──
  ✓ password session: order write
  ✓ password session: order status patch
  ✓ password session: stock movement
  ✓ password session: stock cell
  ✓ password session: refill request refusal
  ✓ password session: transfer
  ✓ password session: multi-path root update
  ✓ password session: device telemetry

── …and cannot READ anything but the code screen needs ──
  ✓ password session: read orders
  ✓ password session: read a product
  ✓ password session: read stock
  ✓ password session: read refill requests
  ✓ password session: read its own /users record (the code screen needs it)
  ✓ password session: read /mirror_switch (quarantine, mirror switch)

── an ENROLLED phone on MC's login works as before ──
  ✓ enrolled: read orders
  ✓ enrolled: read a product
  ✓ enrolled: order write
  ✓ enrolled: stock movement
  ✓ enrolled: stock cell
  ✓ enrolled: refill request
  ✓ enrolled: multi-path root update
  ✓ enrolled: own device telemetry
  ✓ enrolled: last seen (server clock)
  ✓ enrolled: last seen (a client time within 5 minutes)
  ✓ enrolled: reject count 0 → 1
  ✓ enrolled: reject count 1 → 2 (server increment)

── a device record cannot be forged or tampered with ──
  ✓ last seen from yesterday
  ✓ reject count jumps by 2
  ✓ reject count reset
  ✓ another device's last seen
  ✓ a device record's status
  ✓ reading the enrolment records
  ✓ reading the codes
  ✓ an enrolled device adds itself a gate entry
  ✓ an enrolled device switches the code off
  ✓ password session: last seen

── revoked, stale or mismatched enrolments are refused ──
  ✓ a device with no gate entry (revoked)
  ✓ an old enrolment id on a re-enrolled device
  ✓ the SAME session, the moment it is revoked (no reload)
  ✓ …and its last-seen write
  ✓ …and its reads

── every other login is untouched ──
  ✓ Mike (own login) writes an order
  ✓ Mike writes a stock movement
  ✓ a POS till writes an order
  ✓ Mike reads orders
  ✓ a POS till reads a product
  ✓ the owner writes /users
  ✓ the owner writes an order
  ✓ anonymous is still refused an order write

── switched off, MC's login behaves exactly as today ──
  ✓ password session writes again once the flag is removed
  ✓ …and reads again

53 passed, 0 failed
PROVEN — the candidate rules may be pasted.
```

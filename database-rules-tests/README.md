# RTDB security-rules tests

Emulator battery for `database.rules.json`. Currently covers the **sale-forgery
lock** on `/pos/sales` and `/pos/paymentEvents`.

## Run
```
cd database-rules-tests
npm install
PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm test   # needs a JRE (Homebrew openjdk)
```
Uses a throwaway `demo-forgery` project on an isolated emulator port (9010), so it
never touches production or any other running emulator.

## What it proves
- An authenticated token **without** a `/users/{uid}` record (a self-signup
  attacker) CANNOT create sales, write payment events, or mutate existing sales.
- Real provisioned **staff** (have a `/users` record) still can — trading keeps working.
- Field validation rejects bad `type` / `method` / non-numeric `total`/`amount`
  even for staff.
- Real-world shapes (layby, negative-total refund, storeCredit/eft/on-account
  events) still validate.

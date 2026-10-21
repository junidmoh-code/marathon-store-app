# Website orders — the customer agent

When a website-order line's escalation chain runs out (docs/ONLINE-ORDERS.md
§ Escalation — the line is `unavailable`), the customer agent on the Mac mini
asks the customer what they would like instead. **The code decides every
action; the model (Claude Sonnet, `claude-sonnet-5-5`) only writes a greeting
and a sign-off, and classifies a free-text reply the code could not read.**

- Code: `scripts/online/customer-agent.mjs` (CLI, real wiring),
  `scripts/online/agent/core.mjs` (pure: parsing, guards, message facts),
  `agent/run.mjs` (one tick), `agent/alternatives.mjs`, `agent/money.mjs`.
- Runs: launchd `com.marathon.customeragent` (KeepAlive, every 5 min), log
  `logs/customer-agent.log`.

## What happens

1. **First message** (email, and WhatsApp when the gateway is connected and the
   order has a phone): the item is not available, an apology, up to **4
   alternatives** — same Shopify product type, ACTIVE and published, the
   customer's size available for sale, nearest price first — each with its
   `https://marathonclub.co.za/products/{handle}` link and checked against the
   app's own free stock at one place the line could be routed to. Reply with the
   number, or `credit`, or `refund`. Names are the storefront listing names (no
   brand is added by the model; messages may be forwarded).
2. **Replies are parsed by code**: a bare number 1–4 (or "option 2"), the
   word `credit`, the word `refund`. Anything else → ONE model classification
   into {pick N, credit, refund, unclear}, validated by code (an N out of range
   is unclear).
   - **pick N** → the line is swapped: new pid/size routed where the offer found
     it (back on the pick / display path; after a pack, in a follow-up order),
     old hold released. A cheaper item: the difference goes back as **store
     credit**. A dearer item is **refused** (we never charge more) and the
     choices are offered again.
   - **credit** → store credit for the line's paid value.
   - **refund** → a Shopify refund of that line through the order's own gateway
     (Payfast via Shopify), never more than Shopify suggests or the line's
     value; the customer is told it is being processed.
   - **unclear** → asked again.
3. **No reply in 48 hours** → store credit for the line's value automatically,
   and the customer is told; a `refund` reply within **14 days** after that goes
   to Junid to swap the credit for a refund by hand (the code never issues both).
4. **Guards in code** (each pinned by a test that fails without it —
   `agent/agent.test.mjs`):
   - one conversation per line (a swapped item that fails again goes to Junid);
   - at most **3** outbound messages per line — a slot is reserved in a
     transaction BEFORE each send; at the cap Junid is emailed instead;
   - ONE money slot per line, claimed in a transaction BEFORE any Shopify call:
     credit **or** refund, never both, never twice, never more than paid;
   - a Shopify money mutation is never retried (a 5xx may have applied) —
     Junid is told to check;
   - every reply is claimed once, so a re-run never acts on it twice.
5. **Logged**: every action on `/online_orders/{id}/lines/{n}/resolution/log`
   and in `logs/customer-agent.log`; a day's events under
   `online_orders_meta/customerAgent/days/{SA date}`. **Junid** gets an email
   immediately on every credit or refund, and a daily summary (first tick
   after 18:00 SAST).

## Channels — what exists

- **Email out**: Shopify's Admin API has no way to send a free-form email to a
  customer (and the app has no draft-order scope), so the agent sends from the
  **shop mailbox** (the address the card-recon poller uses), reply-to the same
  address, subject `Your order {code} — [{code} item {lineId}]`.
- **Email in**: replies are read from that mailbox over IMAP, matched by the
  customer's address and the subject tag, **read-only** (the agent never sets
  `\Seen`, so the card-recon and EFT pollers see the mailbox exactly as before).
- **WhatsApp out**: the gateway on the mini (`marathon-broadcast-service`, pm2
  `marathon-wa`, `127.0.0.1:8080`). The agent asks `GET /api/status` each
  message and sends (`POST /api/message`) only when it says connected. Token:
  `BROADCAST_SERVICE_TOKEN` in `~/.config/marathon/customer-agent.env`.
- **WhatsApp in: NONE.** The gateway exposes no inbound route (it stores no
  received messages), so **replies are email-only**; each WhatsApp message says
  to reply to the email.

## Money and Shopify scopes

| Action | Scope | Without it |
|---|---|---|
| Store credit | `write_store_credit_account_transactions` | Junid is emailed the exact order, line and amount to credit by hand |
| Refund | `write_orders` | Junid is emailed the exact order, line and amount to refund by hand |

The scopes are read from the token on every run (`currentAppInstallation`), so
the API path switches on by itself once Junid approves them (new app version
with the scopes, released, then **Update** at the store's managed-install URL —
see docs/ONLINE-ORDERS.md and orders-smoke.mjs).

## Running it

```
node scripts/online/customer-agent.mjs                 # dry run: sends and writes nothing
node scripts/online/customer-agent.mjs --commit        # the real tick (launchd)
node scripts/online/customer-agent.mjs --synthetic --pid=<pid> --size=<size>
     # in-memory unavailable line on a real product; real alternatives, real
     # model, real email ONLY to CUSTOMER_AGENT_TEST_EMAIL; a simulated reply.
     # Writes nothing to the database; contacts no customer.
```

Install (mini): copy `scripts/online/com.marathon.customeragent.plist` to
`~/Library/LaunchAgents/`, `launchctl bootstrap gui/501 <plist>`.
Stop: `launchctl bootout gui/501/com.marathon.customeragent`.

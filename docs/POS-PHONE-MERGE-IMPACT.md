# POS impact — customer phone normalization & merge (PR #364)

marathon-pos-app is a SEPARATE repo and was NOT changed by this work. This
document is the hand-off: every place the POS reads or writes a customer
phone, and the three changes it must ship to follow the store app. Until the
POS ships them, the residual risks at the bottom apply.

## How the POS holds customer identity today

`customerId === /customers key === phone digits`. The POS:

- subscribes to the WHOLE `/customers` node (`src/customers/useCustomers.js`)
  and filters client-side (`src/customers/searchCustomers.js` — substring on
  digits with canonical folding via `src/customers/phone.js` `canonicalPhone`).
- probes key variants on create/lookup (`src/customers/customerWrites.js`
  `createOrInitCustomer` → `phoneKeyVariants`: typed → local 0-form → 27-form).
- re-keys a record on phone edit (`src/customers/editCustomer.js` — a full
  identity migration, refused when money is linked).
- writes the phone-as-key into money nodes: `laybys/{saleId}.customerPhone`
  and `laybyPulls/{pullId}.customerPhone` carry `draft.customerId` verbatim
  (`src/sale/engineBuild.js`, `src/layby/laybyFulfillment.js`).
- reads it back for display/search in: CustomerScreen, CustomerPickerModal,
  CustomerDetailsModal, NewCustomerModal, EditCustomerModal, laybySearch,
  LaybyDetailView, SaleHistoryScreen, sales-stats, saleToReceipt/receiptHtml,
  laybyLabel; functions: laybyExpiryReminder, arrearsReminder,
  laybyReminderLogic `normalizeSaPhone`, customerCodes.

## The three changes the POS must ship

1. **Tombstone awareness at the two chokepoints.**
   - `searchCustomers.js`: skip records with `mergedInto` (or render them
     as pointers). Today a merged-away record still appears in every picker
     and can be attached to a sale.
   - `customerWrites.js` `createOrInitCustomer`: when a probed variant hits a
     record with `mergedInto`, FOLLOW the pointer (bounded hops, cycle guard —
     mirror the store app's `resolveCustomerKey`). Today the probe returns the
     tombstone, patches `storeCredit: 0` onto it and burns a C-number.

2. **Probe the bare-9 key dialect.** `src/customers/phone.js`
   `phoneKeyVariants` stops at [typed, local, 27-form]; live data has bare-9
   keys ("813995333"). The store app added the fourth variant in PR #364 —
   mirror it, or a bare-9 customer typed with a leading 0 duplicates.

3. **Fix the Edit-modal false phoneChanged.** `EditCustomerModal.jsx` computes
   `phoneChanged = phoneToKey(phone) !== customer.id`. Any record whose phone
   FIELD is `+27…` while its KEY is `0…` opens the modal with a spuriously
   dirty phone; pressing Save silently RE-KEYS the record to the 27-form —
   recreating the exact split this project removes. Compare
   `canonicalPhone(phone) !== canonicalPhone(customer.phone || customer.id)`.

Worth fixing while in there (pre-existing, unrelated to the merge):
`customerWrites.js` `readLaybyHoldings` returns `[]` unless the value is an
Array, but live holdings are an object map — the customer-row layby badge
always shows 0.

## Residual risks until the POS ships the above

- A cashier can still pick a tombstone in search and attach a new sale to it.
  Money is NOT lost (the store app re-resolves order-flow customers, and the
  merge runner can be re-run to sweep new accruals), but history fragments
  again until swept.
- The merge runner already re-points `pos/sales.customerId` for merged sales,
  so layby instalments and the credit-queue sweep write to the survivor. The
  runner also refuses to run unless `pos/storeCreditQueue` is empty and holds
  a run lock — run it in quiet hours with tills closed.
- Nothing in the POS crashes on the new fields (`mergedInto`, `mergedAt`,
  `mergedBatchId`): records are spread generically. `updatePosCustomerFields`
  would throw if asked to write them — the merge runner never goes through it.

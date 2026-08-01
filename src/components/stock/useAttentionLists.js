// Shared access to the two picked-product lists (/attention_lists).
//
// Two screens use these and must agree exactly: ATTENTION owns the picking (the
// ✚ on a product tile), MARKETING owns the reviewing (the two tabs). Keeping the
// subscription and both writes in one place means the tick you see on a product
// in Attention and the list you see in Marketing can never drift apart.

import { useEffect, useMemo, useState } from "react";
import { onValue, ref, remove, set } from "firebase/database";
import { database } from "../../firebase";
import { usePermissions } from "../PermissionsContext";
import { listSummaries, newItemRecord } from "./attentionLists";

export function useAttentionLists() {
  const [raw, setRaw] = useState(null);
  const { user } = usePermissions();

  // Small node (two lists of product ids), so unlike the stock tree it's cheap
  // to hold open — counts and ticks stay live without a refresh.
  useEffect(() => onValue(
    ref(database, "attention_lists"),
    (snap) => setRaw(snap.val()),
    (err) => { console.warn("Attention lists: read failed:", err); setRaw({}); },
  ), []);

  const lists = useMemo(() => listSummaries(raw), [raw]);

  // Both writes are keyed BY PRODUCT ID, so adding twice is a no-op rather than
  // a duplicate and removing is a delete at a known path.
  const addToList = (listId, productId) =>
    set(ref(database, `attention_lists/${listId}/items/${productId}`),
        newItemRecord({ uid: user?.uid, nowMs: Date.now() }));

  const removeFromList = (listId, productId) =>
    remove(ref(database, `attention_lists/${listId}/items/${productId}`));

  return { lists, addToList, removeFromList, ready: raw !== null };
}

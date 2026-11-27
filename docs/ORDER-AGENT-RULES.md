# Website-pick nudges for shop staff: the rule line to paste (Junid, 14 Nov 2026)

The Order Alerts card (Settings → Notifications) now has a **Website picks (shops)** group:
Marathon PE, Trophy, Concrete, Marathon Pine. Switching a person ON for a shop writes
`/push_assignments/{uid}/{shop} = true` and `/push_hub_audience/{shop}/{uid}`. The order agent's
2-trading-hour nudge for a website pick stuck at that shop goes to those people (web push, their
own mute still vetoes). Store orders are unaffected (they fan out to warehouse hubs only).

`/push_hub_audience/$hub` already accepts any hub key. `/push_assignments/$uid` refuses unknown keys
(`$other: false`), so until these four lines are pasted a save that switches a shop ON is
`PERMISSION_DENIED` (switching hubs keeps working). database.rules.json is console-managed and is not
edited here.

**Firebase Console → Realtime Database → Rules → `push_assignments` → `$uid`**, add beside `"hub3"`:

```json
"marathon-pe":   { ".validate": "newData.isBoolean()" },
"trophy":        { ".validate": "newData.isBoolean()" },
"concrete":      { ".validate": "newData.isBoolean()" },
"marathon-pine": { ".validate": "newData.isBoolean()" },
```

Then Publish, and on the Order Alerts card switch on each shop's staff.

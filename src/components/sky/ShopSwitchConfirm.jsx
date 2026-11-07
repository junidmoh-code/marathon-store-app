// ─── "CHANGING STORE" — the phone order view's store-switch confirmation ─────
// (Junid, 6 Nov: it was unreadable — its dark inline panel became faint glass
// and the grid showed through.) Same copy, same behaviour: Cancel keeps the
// store, "Switch to …" commits; now on THE ONE OVERLAY (SkyConfirm): a message
// card and two button cards over a dimmed, blurred page, navy on strong glass.
import { SkyConfirm } from "./SkyOverlay.jsx";

export default function ShopSwitchConfirm({ fromLabel, toLabel, cartCount = 0, onCancel, onConfirm }) {
  return (
    <SkyConfirm title="Changing store" confirmLabel={`Switch to ${toLabel}`} onCancel={onCancel} onConfirm={onConfirm}
                testId="shop-switch-confirm" icon="swap">
      <div>Switching from <b>{fromLabel}</b> to <b>{toLabel}</b>.</div>
      <div style={{ marginTop: 8 }}>
        Every order you place will now go to <b>{toLabel}</b>. If this is the wrong store, the stock ships to the wrong branch.
      </div>
      {cartCount > 0 && (
        <div className="sky-ovl-msg__note">
          You have {cartCount} item{cartCount > 1 ? "s" : ""} in the cart — they’ll be placed for {toLabel}.
        </div>
      )}
    </SkyConfirm>
  );
}

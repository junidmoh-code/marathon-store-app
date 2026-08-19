// ─── THE OUTBOX DEDUPE WINDOW — one value, two readers ───────────────────────
// The producer (enqueueWhatsApp, functions/index.js) reuses an identical
// to + templateName + renderedText doc enqueued within this window instead of
// creating a second one. That is what makes a re-enqueue inside the window
// provably harmless — and hold-availability-notify.cjs bets a customer's
// message on exactly that when it decides whether an unresolved claim may
// resume.
//
// The two used to restate the number with a comment asking future readers to
// keep them equal (CodeRabbit #385). They now share this constant, so
// shortening the producer's window cannot silently widen the notifier's idea of
// what is safe to resend.
module.exports = { WHATSAPP_DEDUPE_WINDOW_MS: 90 * 1000 };

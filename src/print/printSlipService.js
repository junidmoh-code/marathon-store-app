// Browser-native printing for the Assistant order slip — ported from the POS
// (marathon-pos-app src/print/printService.js). We render a standalone HTML doc
// into an off-screen iframe and open the browser's native print dialog for JUST
// that iframe, so the app UI is never printed. Same 80mm thermal path the POS
// uses on Windows (Chrome → thermal driver, which auto-cuts at end of job) — no
// ESC/POS, no kiosk/silent print, no native bridge.

// Wait until every <img> has loaded so any inline artwork is laid out before the
// dialog snapshots the page (no-op for a text-only slip).
function waitForImages(doc) {
  const imgs = Array.from(doc.images || []);
  return Promise.all(
    imgs.map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          }),
    ),
  );
}

// Render `html` in an off-screen iframe and trigger its print dialog. Two things
// matter on Windows Chrome: the iframe must stay laid out with real dimensions
// (display:none / 0×0 prints blank — we move it off-screen instead), and content
// is written synchronously via document.write (not srcdoc, whose onload some
// browsers skip). Resolves once the dialog is triggered; iframe is cleaned up
// after printing (or a 60s fallback).
export function printHtmlInIframe(html) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.setAttribute("tabindex", "-1");
    Object.assign(iframe.style, {
      position: "fixed", left: "-10000px", top: "0",
      width: "80mm", height: "200mm", border: "0",
    });

    let cleanupTimer = null;
    const cleanup = () => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    document.body.appendChild(iframe);

    let doc;
    try {
      doc = iframe.contentDocument || iframe.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    const win = iframe.contentWindow;
    const triggerPrint = async () => {
      try {
        await waitForImages(doc);
        win.addEventListener("afterprint", cleanup, { once: true });
        cleanupTimer = setTimeout(cleanup, 60_000);
        setTimeout(() => {
          try {
            win.focus();
            win.print();
            resolve();
          } catch (err) {
            cleanup();
            reject(err);
          }
        }, 60);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    if (doc.readyState === "complete") triggerPrint();
    else iframe.onload = triggerPrint;
  });
}

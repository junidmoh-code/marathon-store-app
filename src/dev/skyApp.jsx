// DEV ONLY — mounts the real App for the sky app harness (dev/sky-app.html).
// Only meaningful under dev/vite.harness.config.mjs, where firebase is the
// offline stand-in; under the normal dev server it refuses to start, so it can
// never read or write the live database by accident.
import "../styles/sky.css";
import "../styles/sky-theme.css";
import "../styles/sky-admin.css";
import { createRoot } from "react-dom/client";
import { database } from "../firebase.js";


const root = createRoot(document.getElementById("root"));
if (!database?.__fake) {
  root.render(<p style={{ padding: 20 }}>Start with: npx vite --config dev/vite.harness.config.mjs</p>);
} else {
  import("../App.jsx").then(({ default: App }) => root.render(<App />));
}

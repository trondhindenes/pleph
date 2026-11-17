// Copies browser assets from node_modules into src/vendor (no bundler needed).
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("src/vendor", { recursive: true });
copyFileSync("node_modules/@highlightjs/cdn-assets/highlight.min.js", "src/vendor/highlight.min.js");

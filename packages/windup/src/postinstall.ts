/**
 * npm postinstall: provision Chromium so `npx windup run` just works.
 * Never fails the user's install — a download problem falls back to the
 * lazy launch-time installer.
 */
import { installChromium, shouldSkipDownload } from "./ensure-browser.js";

if (shouldSkipDownload()) {
  process.exit(0);
}
try {
  if (!installChromium("postinstall")) {
    console.warn("windup: Chromium download skipped/failed — it will be retried on first run.");
  }
} catch {
  // never break npm install
}

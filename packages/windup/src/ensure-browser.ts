import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Zero-friction browser provisioning: `npm i -D windupjs` must be enough.
 *
 * - postinstall downloads ONLY Chromium (~130MB, machine-wide Playwright
 *   cache — shared across projects, downloaded once).
 * - launch-time fallback covers `--ignore-scripts` installs.
 * - Opt-outs: CHROME_PATH (use an existing Chrome/Chromium) or
 *   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 / WINDUP_SKIP_BROWSER_DOWNLOAD=1.
 */
export function shouldSkipDownload(): boolean {
  return Boolean(
    process.env.CHROME_PATH ||
      process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD ||
      process.env.WINDUP_SKIP_BROWSER_DOWNLOAD,
  );
}

/** Download Chromium via the playwright-core CLI. Returns false on failure. */
export function installChromium(reason: string): boolean {
  if (shouldSkipDownload()) return true;
  const require = createRequire(import.meta.url);
  let cli: string;
  try {
    // "playwright-core/cli" is not in the package's exports; the bin is cli.js at the root.
    const pkgJson = require.resolve("playwright-core/package.json");
    cli = pkgJson.replace(/package\.json$/, "cli.js");
  } catch {
    return false;
  }
  console.log(`windup: downloading Chromium (${reason}; one-time, cached machine-wide)...`);
  const result = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  return result.status === 0;
}

/** Playwright launch error for a missing browser binary. */
export function isMissingBrowserError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|browser is not.*installed|playwright.*install/i.test(message);
}

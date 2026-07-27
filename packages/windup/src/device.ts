import { devices } from "playwright-core";
import { getContext } from "./context.js";

/** The active device-emulation preset name, or null. `--device` (WINDUP_DEVICE) wins over config.device. */
export function activeDeviceName(): string | null {
  const env = process.env.WINDUP_DEVICE;
  if (env) return env;
  try {
    return getContext().config.device ?? null;
  } catch {
    return null;
  }
}

/** Filename-safe slug for a device name (`"iPhone 14 Pro"` → `iphone-14-pro`). */
export function deviceSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Cache-key suffix for the active device (`@iphone-14`) — empty when no device, so default paths are unchanged. */
export function deviceSuffix(): string {
  const name = activeDeviceName();
  return name ? `@${deviceSlug(name)}` : "";
}

/**
 * The Playwright context options for the active device (viewport, UA, scale,
 * mobile/touch), or null when no device is set. Throws with the available names
 * if the preset is unknown. Mobile emulation (isMobile/hasTouch) needs chromium.
 */
export function resolveDeviceContext(): Record<string, unknown> | null {
  const name = activeDeviceName();
  if (!name) return null;
  const d = (devices as Record<string, { viewport?: unknown; userAgent?: string; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean }>)[name];
  if (!d) {
    const sample = Object.keys(devices).filter((n) => /iphone|pixel|galaxy|ipad/i.test(n)).slice(0, 6);
    throw new Error(`unknown device "${name}" — use a Playwright device preset (e.g. ${sample.join(", ")}). See https://playwright.dev/docs/emulation`);
  }
  const opts: Record<string, unknown> = {};
  if (d.viewport) opts.viewport = d.viewport;
  if (d.userAgent) opts.userAgent = d.userAgent;
  if (d.deviceScaleFactor !== undefined) opts.deviceScaleFactor = d.deviceScaleFactor;
  if (d.isMobile !== undefined) opts.isMobile = d.isMobile;
  if (d.hasTouch !== undefined) opts.hasTouch = d.hasTouch;
  return opts;
}

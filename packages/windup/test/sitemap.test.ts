import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SiteMapStore } from "../src/sitemap.js";

async function freshStore(): Promise<{ store: SiteMapStore; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "windup-map-"));
  const file = path.join(dir, "site-map.json");
  return { store: await SiteMapStore.load(file), file };
}

function seedLoginFlow(store: SiteMapStore): void {
  store.upsertPage({ sig: "sig:aaa", url: "https://x.com/", title: "Login", interactive: ["input id=user", "button id=entrar"] });
  store.upsertPage({ sig: "sig:bbb", url: "https://x.com/inventory.html", title: "Products", interactive: ["button id=add-to-cart-item", "a data-test=shopping-cart-link"] });
  store.upsertPage({ sig: "sig:ccc", url: "https://x.com/cart.html", title: "Cart", interactive: ["button id=checkout", "button id=remove-item"] });
  store.recordTransition("sig:aaa", { type: "click", selector: "#entrar" }, "sig:bbb");
  store.recordTransition("sig:bbb", { type: "click", selector: ".shopping_cart_link" }, "sig:ccc");
}

describe("SiteMapStore (E2)", () => {
  it("upsert accumulates seen_count and urls; a repeated transition accumulates seen_count", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    store.upsertPage({ sig: "sig:bbb", url: "https://x.com/inventory.html?x=1", title: "Products", interactive: [] });
    store.recordTransition("sig:aaa", { type: "click", selector: "#entrar" }, "sig:bbb");
    const slice = store.sliceForPrompt("sig:aaa", "anything", 10_000);
    expect(store.pageCount).toBe(3);
    expect(slice).toContain("**/inventory.html");
  });

  it("derives url_pattern from the most common pathname", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "cart", 10_000);
    expect(slice).toContain("**/cart.html");
  });

  it("BFS starts from the initial page and does not include it (it enters the prompt live)", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "checkout", 10_000);
    expect(slice).not.toContain("Known page: **/ ");
    expect(slice).toContain("checkout");
  });

  it("unknown initial page → empty slice", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    expect(store.sliceForPrompt("sig:zzz", "anything", 10_000)).toBe("");
  });

  it("respects the chars budget", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "cart checkout products", 200);
    expect(slice.length).toBeLessThanOrEqual(200);
  });

  it("prioritizes pages that match the task terms", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    // budget for a single block: the checkout one must beat the products one
    const slice = store.sliceForPrompt("sig:aaa", "finish the cart checkout", 400);
    expect(slice).toContain("checkout");
  });

  it("includes the arrival path (transition) in the page block", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "products inventory", 10_000);
    expect(slice).toContain("you get here with click '#entrar'");
  });

  it("save + load round-trip", async () => {
    const { store, file } = await freshStore();
    seedLoginFlow(store);
    await store.save();
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.map_version).toBe("0.1");
    expect(Object.keys(raw.pages)).toHaveLength(3);
    const reloaded = await SiteMapStore.load(file);
    expect(reloaded.pageCount).toBe(3);
    expect(reloaded.sliceForPrompt("sig:aaa", "cart", 10_000)).toContain("**/cart.html");
  });
});

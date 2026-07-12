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
  it("upsert acumula seen_count e urls; transição repetida acumula seen_count", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    store.upsertPage({ sig: "sig:bbb", url: "https://x.com/inventory.html?x=1", title: "Products", interactive: [] });
    store.recordTransition("sig:aaa", { type: "click", selector: "#entrar" }, "sig:bbb");
    const slice = store.sliceForPrompt("sig:aaa", "qualquer", 10_000);
    expect(store.pageCount).toBe(3);
    expect(slice).toContain("**/inventory.html");
  });

  it("deriva url_pattern do pathname mais comum", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "carrinho", 10_000);
    expect(slice).toContain("**/cart.html");
  });

  it("BFS parte da página inicial e não inclui a própria (que entra viva no prompt)", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "checkout", 10_000);
    expect(slice).not.toContain("Página conhecida: **/ ");
    expect(slice).toContain("checkout");
  });

  it("página inicial desconhecida → fatia vazia", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    expect(store.sliceForPrompt("sig:zzz", "qualquer", 10_000)).toBe("");
  });

  it("respeita o orçamento de chars", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "carrinho checkout produtos", 200);
    expect(slice.length).toBeLessThanOrEqual(200);
  });

  it("prioriza páginas que casam com os termos da tarefa", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    // orçamento para 1 bloco só: o de checkout deve vencer o de produtos
    const slice = store.sliceForPrompt("sig:aaa", "finalizar checkout do carrinho", 400);
    expect(slice).toContain("checkout");
  });

  it("inclui o caminho de chegada (transição) no bloco da página", async () => {
    const { store } = await freshStore();
    seedLoginFlow(store);
    const slice = store.sliceForPrompt("sig:aaa", "produtos inventário", 10_000);
    expect(slice).toContain("chega-se aqui com click '#entrar'");
  });

  it("save + load fazem roundtrip", async () => {
    const { store, file } = await freshStore();
    seedLoginFlow(store);
    await store.save();
    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.map_version).toBe("0.1");
    expect(Object.keys(raw.pages)).toHaveLength(3);
    const reloaded = await SiteMapStore.load(file);
    expect(reloaded.pageCount).toBe(3);
    expect(reloaded.sliceForPrompt("sig:aaa", "carrinho", 10_000)).toContain("**/cart.html");
  });
});

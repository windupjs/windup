import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.js";

describe("carregamento de env (.env.local > .env)", () => {
  it(".env.local tem precedência sobre .env; ambos carregam", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "windup-env-"));
    await writeFile(path.join(dir, ".env"), "WINDUP_T_A=do-env\nWINDUP_T_B=so-no-env\n");
    await writeFile(path.join(dir, ".env.local"), "WINDUP_T_A=do-local\nWINDUP_T_C=so-no-local\n");
    loadEnv(dir);
    expect(process.env.WINDUP_T_A).toBe("do-local");
    expect(process.env.WINDUP_T_B).toBe("so-no-env");
    expect(process.env.WINDUP_T_C).toBe("so-no-local");
  });

  it("variável já presente no processo nunca é sobrescrita", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "windup-env-"));
    process.env.WINDUP_T_D = "do-processo";
    await writeFile(path.join(dir, ".env.local"), "WINDUP_T_D=do-arquivo\n");
    loadEnv(dir);
    expect(process.env.WINDUP_T_D).toBe("do-processo");
  });

  it("diretório sem arquivos env não explode", () => {
    expect(() => loadEnv("/caminho/que/nao/existe")).not.toThrow();
  });
});

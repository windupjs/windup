import "dotenv/config";
import { Command } from "commander";

const program = new Command();

program.name("spike").description("Spike de validação RubberDuck: plano LLM → execução determinística → replay via cache");

program
  .command("run <cenario>")
  .description("Executa um cenário (usa cache se existir, senão planeja via Gemini)")
  .option("--no-cache", "ignora e não grava cache (mede o caminho LLM isoladamente)")
  .option("--repeat <n>", "executa N vezes em sequência", "1")
  .action(async (cenario: string, opts: { cache: boolean; repeat: string }) => {
    console.log(`[spike] run ${cenario} cache=${opts.cache} repeat=${opts.repeat} (não implementado)`);
  });

program
  .command("bench <cenario>")
  .description("Roda o protocolo completo de validação (doc 06) e imprime o comparativo C1–C5")
  .action(async (cenario: string) => {
    console.log(`[spike] bench ${cenario} (não implementado)`);
  });

const cache = program.command("cache").description("Gerencia o cache de trajetórias");
cache
  .command("clear")
  .description("Apaga o cache de trajetórias")
  .action(async () => {
    console.log("[spike] cache clear (não implementado)");
  });

program.parseAsync(process.argv);

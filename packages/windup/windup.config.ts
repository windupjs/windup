// Dogfood: config do próprio pacote para rodar os cenários de regressão
// (fixtures da spike) a partir deste diretório.
export default {
  llm: { provider: "google", model: "gemini-2.5-flash" },
  scenarios: "scenarios",
};

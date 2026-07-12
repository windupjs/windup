// Dogfood: config do próprio pacote para rodar os cenários de regressão
// (fixtures da spike) a partir deste diretório.
export default {
  llm: { provider: "google", model: "gemini-3.1-flash-lite" },
  scenarios: "scenarios",
  // Manifesto do projeto (E4): caso de teste documentado — a conta "qa" não
  // existe na página; só o manifesto a define, via ENV (nunca literais).
  context: {
    credentials: {
      qa: { user: "ENV:SAUCE_USER", password: "ENV:SAUCE_PASSWORD" },
    },
  },
};

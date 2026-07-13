// Dogfood: the package's own config to run the regression scenarios
// (spike fixtures) from this directory.
export default {
  llm: { provider: "google", model: "gemini-3.1-flash-lite" },
  scenarios: "scenarios",
  // Project manifest (E4): documented test case — the "qa" account does not
  // exist on the page; only the manifest defines it, via ENV (never literals).
  context: {
    credentials: {
      qa: { user: "ENV:SAUCE_USER", password: "ENV:SAUCE_PASSWORD" },
    },
  },
};

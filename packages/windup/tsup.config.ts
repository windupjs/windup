import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/adapters/vitest.ts", "src/postinstall.ts"],
  format: ["esm"],
  dts: { entry: ["src/index.ts", "src/adapters/vitest.ts"] },
  clean: true,
  sourcemap: true,
  target: "node20",
});

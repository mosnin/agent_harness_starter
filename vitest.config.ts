import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Retained third-party evidence is data, never part of our executable suite.
    exclude: [...configDefaults.exclude, ".research/**", "docs/research/**", "benchmarks/helm-enterprise/fixtures/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

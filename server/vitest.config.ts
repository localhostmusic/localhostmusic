import { defineConfig } from "vitest/config";

// Tests live in test/, outside tsconfig's rootDir, so the build never compiles them.
// The exclude stops vitest picking up compiled copies under dist/ and live/.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["**/node_modules/**", "dist/**", "live/**"],
  },
});

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        kvNamespaces: ["OAUTH_KV"],
        bindings: {
          CLOUDFLARE_API_TOKEN: "test-cloudflare-token-value",
          MCP_ACCESS_KEY: "test-access-key-that-is-long-enough-000",
        },
      },
    }),
  ],
  test: { include: ["test/worker/**/*.test.ts"] },
});

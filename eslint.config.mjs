import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "platform/drizzle/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    // Tenancy guard (DESIGN-AUTH-TENANCY 3.3): outside platform/src/db,
    // code must go through tenantDb and must not touch the raw client or
    // the postgres driver directly.
    files: ["platform/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["postgres", "**/db/client", "**/db/client.js"],
              message:
                "Raw database access is limited to platform/src/db; use tenantDb (src/db/tenant.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["platform/src/db/**/*.ts", "platform/src/index.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);

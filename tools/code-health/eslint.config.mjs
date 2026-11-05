// ESLint flat config for the whole repository, run from tools/code-health (see docs/code-health.md).
// Existing violations are frozen in baseline.json by ratchet.mjs; CI fails only on new ones.
import { fileURLToPath } from "node:url";
import path from "node:path";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import globals from "globals";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Rules shared by both halves. eqeqeq allows `== null`, the one loose comparison the code uses on purpose.
const shared = {
  eqeqeq: ["error", "always", { null: "ignore" }],
  // node:test's test()/describe() return promises the runner awaits itself.
  "@typescript-eslint/no-floating-promises": [
    "error",
    { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite", "before", "after", "beforeEach", "afterEach"] }] },
  ],
  "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
};
const unusedVars = ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "portal/.next/**",
      "portal/next-env.d.ts",
      "portal/ui-harness/dist/**",
      "portal/ui-harness/test-results/**",
      "portal/ui-harness/playwright-report/**",
      "portal/test-results/**",
      "**/coverage-fixtures/**",
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: "off" } },
  // Node ESM: engine/, cli/, tools/, status/. Type-aware through tsconfig.engine.json (allowJs, no checkJs).
  {
    files: ["engine/**/*.mjs", "cli/**/*.mjs", "tools/**/*.mjs", "status/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
      parser: tseslint.parser,
      parserOptions: { project: [path.join(here, "tsconfig.engine.json")], tsconfigRootDir: repoRoot },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...shared, "no-unused-vars": unusedVars },
  },
  // Portal: TypeScript + React + Next.
  {
    files: ["portal/**/*.ts", "portal/**/*.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { project: [path.join(repoRoot, "portal/tsconfig.json")], tsconfigRootDir: repoRoot },
    },
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    settings: { next: { rootDir: path.join(repoRoot, "portal") } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      ...shared,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": unusedVars,
    },
  },
);

import babelParser from "@babel/eslint-parser";

export default [
  {
    ignores: ["node_modules/**", "runs/**", "test-results/**", "playwright-report/**"],
  },
  {
    files: ["**/*.js", "**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          plugins: [["@babel/plugin-syntax-typescript", { onlyRemoveTypeImports: true }]],
        },
      },
    },
    rules: {
      "no-constant-condition": "error",
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-unreachable": "error",
    },
  },
];

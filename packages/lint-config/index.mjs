// The one criterion for code migrated to the refactor's rules (docs/proposals/web-wallet-refactor-preamble.md):
// ESLint rules plus the repo's Prettier format, reported by one `eslint` run. Each package passes the paths it has
// migrated; a slice grows those lists and never weakens the rules.
import js from "@eslint/js"
import prettier from "eslint-plugin-prettier"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

const SWALLOW = "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression"
const swallow = (shape) => ({ selector: `${SWALLOW}${shape}`, message: "Do not swallow errors." })
const NO_SWALLOW = [
  swallow("[body.type='BlockStatement'][body.body.length=0]"),
  swallow("[body.type='Literal']"),
  swallow("[body.type='Identifier'][body.name='undefined']"),
]
const NO_MODULE_MOCKS = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock']",
  message: "Inject an in-memory fake of the public interface instead of mocking modules.",
}

/**
 * @param {object} migrated
 * @param {string} migrated.tsconfigRootDir the package directory (`import.meta.dirname`)
 * @param {string[]} [migrated.engine] framework-free code: no React, no event emitters, no floating promises
 * @param {string[]} [migrated.react] hooks and components
 * @param {string[]} [migrated.tests] tests: no module mocks
 */
export function migrated({ tsconfigRootDir, engine = [], react = [], tests = [] }) {
  const all = [...engine, ...react, ...tests]
  return tseslint.config(
    { ignores: ["dist/**"] },
    {
      files: all,
      extends: [js.configs.recommended, ...tseslint.configs.recommended],
      plugins: { prettier },
      rules: {
        "prettier/prettier": "error",
        "no-empty": ["error", { allowEmptyCatch: false }],
        "no-restricted-syntax": ["error", ...NO_SWALLOW],
      },
    },
    engine.length > 0 && {
      files: engine,
      languageOptions: { parserOptions: { projectService: true, tsconfigRootDir } },
      rules: {
        "@typescript-eslint/no-floating-promises": "error",
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              { group: ["react", "react-dom", "react/*"], message: "The engine runs without React." },
              { group: ["eventemitter3", "**/GlobalEventEmitter"], message: "State changes go through stores." },
            ],
          },
        ],
      },
    },
    react.length > 0 && {
      files: react,
      plugins: { "react-hooks": reactHooks },
      rules: reactHooks.configs.recommended.rules,
    },
    tests.length > 0 && {
      files: tests,
      rules: { "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_MODULE_MOCKS] },
    },
  ).filter(Boolean)
}

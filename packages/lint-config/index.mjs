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
const NO_THROW = {
  selector: "ThrowStatement > NewExpression[callee.name='Error']",
  message: 'Throw WalletError(code) instead of new Error("…")',
}
const NO_MODULE_MOCKS = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock']",
  message: "Inject an in-memory fake of the public interface instead of mocking modules.",
}
// A negated matcher asserts absence, as a privacy check does, so it pins no wording.
const MATCHER =
  "CallExpression[callee.property.name=/^(toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toThrow|toThrowError|toHaveProperty|toHaveTextContent)$/]" +
  ":not([callee.object.property.name='not'])"
const copy = (target) => ({
  selector: `${MATCHER} > ${target}, ${MATCHER} > :matches(ObjectExpression, ArrayExpression) ${target}`,
  message: "Assert copy through the constant or error that owns it, not a literal.",
})
// ponytail: prose is a literal with a space; a one-word message slips through.
const NO_COPY = [
  copy("Literal[value=/\\s/]"),
  copy("Literal[regex.pattern=/ /]"),
  copy("TemplateLiteral:has(TemplateElement[value.raw=/\\s/])"),
]
const COPY_ATTR = "JSXAttribute[name.name=/^(title|label|placeholder|aria-label|alt)$/]"
// Preamble "Storage": only platform storage touches browser storage or walletStorage's copy.
const STORAGE = "Read and write through a persistent store on the Database, or the platform storage helpers."
const STORAGE_GLOBALS = ["localStorage", "sessionStorage", "indexedDB"]
const STORAGE_IMPORTS = {
  group: ["**/walletStorage", "**/walletStorage.js"],
  importNames: ["walletStorage"],
  message: STORAGE,
}
const NO_STORAGE_IMPORT = { selector: "ImportExpression[source.value=/walletStorage/]", message: STORAGE }
const STORAGE_RULES = {
  "no-restricted-globals": ["error", ...STORAGE_GLOBALS.map((name) => ({ name, message: STORAGE }))],
  "no-restricted-properties": [
    "error",
    ...["window", "globalThis", "self"].flatMap((object) =>
      STORAGE_GLOBALS.map((property) => ({ object, property, message: STORAGE })),
    ),
  ],
}
const jsxCopy = (selector) => ({ selector, message: "Render copy from the component's Foo.copy.ts." })
const NO_JSX_COPY = [
  jsxCopy("JSXText[value=/[A-Za-z]/]"),
  jsxCopy(`${COPY_ATTR} > Literal[value=/[A-Za-z]/]`),
  jsxCopy(`${COPY_ATTR} > JSXExpressionContainer > Literal[value=/[A-Za-z]/]`),
  jsxCopy(`${COPY_ATTR} > JSXExpressionContainer > TemplateLiteral:has(TemplateElement[value.raw=/[A-Za-z]/])`),
]

/**
 * @param {object} migrated
 * @param {string} migrated.tsconfigRootDir the package directory (`import.meta.dirname`)
 * @param {string[]} [migrated.engine] framework-free code: no React, no event emitters, no floating promises
 * @param {string[]} [migrated.react] hooks and components
 * @param {string[]} [migrated.views] components in folders: also no copy literals in JSX
 * @param {string[]} [migrated.tests] tests: no module mocks
 * @param {boolean} [migrated.copyFreeTests] tests also never assert copy
 * @param {string[]} [migrated.platformStorage] the platform storage code, which may touch storage directly
 * @param {string[]} [migrated.storageBaseline] migrated files that still touch storage directly; may only shrink
 */
export function migrated({
  tsconfigRootDir,
  engine = [],
  react = [],
  views = [],
  tests = [],
  copyFreeTests = false,
  platformStorage = [],
  storageBaseline = [],
}) {
  const all = [...engine, ...react, ...views, ...tests]
  const storageExempt = [...platformStorage, ...storageBaseline]
  // The rule for `files`, with the storage bans added for each file that is not storage-exempt.
  const exempting = (files, rule, options) =>
    files.length === 0
      ? []
      : [
          { files, rules: { [rule]: options(false) } },
          { files, ignores: storageExempt, rules: { [rule]: options(true) } },
        ]
  const syntax = (selectors) => (storage) => ["error", ...selectors, ...(storage ? [NO_STORAGE_IMPORT] : [])]
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
      rules: { "@typescript-eslint/no-floating-promises": "error" },
    },
    ...exempting(engine, "no-restricted-syntax", syntax([...NO_SWALLOW, NO_THROW])),
    ...exempting(engine, "no-restricted-imports", (storage) => [
      "error",
      {
        patterns: [
          { group: ["react", "react-dom", "react/*"], message: "The engine runs without React." },
          { group: ["eventemitter3", "**/GlobalEventEmitter"], message: "State changes go through stores." },
          ...(storage ? [STORAGE_IMPORTS] : []),
        ],
      },
    ]),
    engine.length + react.length + views.length > 0 && {
      files: [...engine, ...react, ...views],
      ignores: storageExempt,
      rules: STORAGE_RULES,
    },
    react.length + views.length > 0 && {
      files: [...react, ...views],
      ignores: [...storageExempt, ...engine],
      rules: { "no-restricted-imports": ["error", { patterns: [STORAGE_IMPORTS] }] },
    },
    react.length + views.length > 0 && {
      files: [...react, ...views],
      plugins: { "react-hooks": reactHooks },
      rules: reactHooks.configs.recommended.rules,
    },
    ...exempting([...react, ...views], "no-restricted-syntax", syntax([...NO_SWALLOW, NO_THROW])),
    ...exempting(views, "no-restricted-syntax", syntax([...NO_SWALLOW, NO_THROW, ...NO_JSX_COPY])),
    tests.length > 0 && {
      files: tests,
      rules: {
        "no-restricted-syntax": ["error", ...NO_SWALLOW, NO_MODULE_MOCKS, ...(copyFreeTests ? NO_COPY : [])],
      },
    },
  ).filter(Boolean)
}

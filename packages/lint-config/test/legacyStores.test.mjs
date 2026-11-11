import assert from "node:assert/strict"
import { test } from "node:test"
import { storeChannels } from "../legacyStores.mjs"

const WEB = "packages/web-wallet/src/features/x/store.ts"
const CORE = "packages/front-core/src/core/x/store.ts"

const cases = [
  // 1. IStorageAdapter-typed declarations, RecordStorage construction or extension.
  ["adapter field", CORE, `class A { constructor(private s: IStorageAdapter) {} }`, ["adapter"]],
  ["adapter Pick", CORE, `function f(s: Pick<IStorageAdapter, "getItem">) {}`, ["adapter"]],
  ["adapter import only", CORE, `import type { IStorageAdapter } from "./adapter"`, []],
  ["adapter in a comment", CORE, `// takes s: IStorageAdapter\nconst a = 1`, []],
  ["new RecordStorage", CORE, `const s = new RecordStorage<X>({ key })`, ["recordStorage"]],
  ["extends RecordStorage", CORE, `class S extends RecordStorage<X> {}`, ["recordStorage"]],
  ["RecordStorage re-export", CORE, `export { RecordStorage } from "./RecordStorage"`, []],
  // 2. webStorage item calls and the walletStorage object.
  ["webStorage getItem", WEB, `await webStorage.getItem("k")`, ["webStorage"]],
  ["webStorage passed on", WEB, `Store.get(webStorage)\nwebStorage.readOtherDatabases(f)`, []],
  ["walletStorage object", WEB, `walletStorage\n  .setItem(k, v)`, ["walletStorage"]],
  ["walletStorage module", WEB, `import { reloadPage } from "../storage/walletStorage"`, []],
  // 3. Keyed calls with a key outside the allow-list.
  [
    "device key",
    WEB,
    `const K = "webwallet.hide"\ndeviceStorage.getItem(K)`,
    ["deviceStorage:webwallet.hide"],
  ],
  ["allowed device key", WEB, `deviceStorage.setItem("webwallet.endpoints", v)`, []],
  ["localStorage literal", WEB, `window.localStorage.removeItem('a.b')`, ["localStorage:a.b"]],
  ["allowed tab prefix", WEB, "const key = `zkm.once.${name}`\nsessionStorage.getItem(key)", []],
  [
    "template with an unknown part",
    WEB,
    'const R = "cb"\nrollupStorage.removeItem(`${R}:${state}`)',
    ["rollupStorage:cb:*"],
  ],
  ["unresolved key", WEB, `sessionStorage.setItem(keyOf(id), v)`, ["sessionStorage:?"]],
  [
    "tabStash seam with an object key",
    WEB,
    `type TabStash = typeof tabStash\nconst KEYS = { token: "obsidion.name-grant" }\n` +
      `function f(stash: TabStash) { stash.get(KEYS.token) }`,
    [],
  ],
  [
    "tabStash seam with a parameter key",
    WEB,
    `function f(stash: typeof tabStash, key: string) { stash.set(key, "1") }`,
    ["tabStash:?"],
  ],
  ["tabStash key typed TabKey", WEB, `function f(key: TabKey) { tabStash.get(key) }`, []],
  [
    "arrow parameter typed TabKey",
    WEB,
    `const put = (key: TabKey, v: string) => tabStash.set(key, v)`,
    [],
  ],
  [
    "TabKey parameter of another function",
    WEB,
    `function a(key: TabKey) {}\nfunction b(key: string) { tabStash.set(key, "1") }`,
    ["tabStash:?"],
  ],
  [
    "parameter shadowing a constant",
    WEB,
    `const key = "zkm.once.x"\nfunction f(key: string) { tabStash.get(key) }`,
    ["tabStash:?"],
  ],
  [
    "arrow parameter shadowing a constant",
    WEB,
    `const key = "zkm.once.x"\nkeys.forEach(key => tabStash.get(key))`,
    ["tabStash:?"],
  ],
  ["tabStash outside the list", WEB, `tabStash.set("x.y", v)`, ["tabStash:x.y"]],
  [
    "tab key through deviceStorage",
    WEB,
    `deviceStorage.getItem("zkm.once.x")`,
    ["deviceStorage:zkm.once.x"],
  ],
  [
    "tab key through localStorage",
    WEB,
    `localStorage.setItem("obsidion.pending-claim", v)`,
    ["localStorage:obsidion.pending-claim"],
  ],
  ["device key through tabStash", WEB, `tabStash.get("zkm_bid")`, ["tabStash:zkm_bid"]],
  [
    "device key through sessionStorage",
    WEB,
    `sessionStorage.getItem("webwallet.endpoints")`,
    ["sessionStorage:webwallet.endpoints"],
  ],
  [
    "TabKey through deviceStorage",
    WEB,
    `function f(key: TabKey) { deviceStorage.getItem(key) }`,
    ["deviceStorage:<TabKey>"],
  ],
  ["property of another object", WEB, `deps.localStorage.getItem("a")`, []],
  // 4. A StringStore parameter defaulted to sessionStorage.
  [
    "StringStore default",
    WEB,
    `function f(store: StringStore = sessionStorage) {}`,
    ["stringStoreDefault"],
  ],
  ["StringStore without default", WEB, `function f(store: StringStore) {}`, []],
  // 5. An "@obsidion/" key staged with w.put.
  [
    "root cursor through a constant",
    CORE,
    'const K = "@obsidion/scan/cursor"\nconst cursorKey = `${K}/${id}`\nw.put(cursorKey, v)',
    ["rootCursor"],
  ],
  [
    "root cursor through a function",
    CORE,
    'const K = "@obsidion/scan"\nfunction cursorKey(c: C): string {\n  return `${K}/${c.id}`\n}\n' +
      "w.put(cursorKey(ctx), v)",
    ["rootCursor"],
  ],
  [
    "acct/ key beside a legacy constant",
    CORE,
    'const OLD = "@obsidion/ops"\nconst PREFIX = "acct/ops"\nw.put(`${PREFIX}/${id}`, v)',
    [],
  ],
]

for (const [name, file, text, expected] of cases)
  test(`store channels: ${name}`, () => assert.deepEqual(storeChannels(file, text), expected))

test("a key resolves through a function's only non-null return", () => {
  const text =
    'const PREFIX = "a.b:"\nfunction keyOf(f: string): string | null {\n' +
    "  try {\n    return PREFIX + hash(f)\n  } catch {\n    return null\n  }\n}\n" +
    "const key = keyOf(x)\nsessionStorage.getItem(key)"
  assert.deepEqual(storeChannels(WEB, text), ["sessionStorage:a.b:*"])
})

test("a constant declared in another function is not visible", () => {
  const text =
    'function a() { const key = "zkm.once.x"; use(key) }\n' +
    "function b(key: string) { tabStash.get(key) }"
  assert.deepEqual(storeChannels(WEB, text), ["tabStash:?"])
})

test("exclusions: tests, storage migrations, channel implementations, declarations", () => {
  const text = `walletStorage.getItem("k")`
  for (const file of [
    "packages/web-wallet/src/features/x/store.test.ts",
    "packages/web-wallet/test/store.ts",
    "packages/front-core/src/storageMigrations/transfers.ts",
    "packages/web-wallet/src/platform/storage/requests.ts",
    "packages/front-core/src/core/storages/adapter.ts",
    "packages/front-core/src/core/services/bridge/RecordStorage.ts",
    "packages/web-wallet/src/types.d.ts",
    "packages/sdk/src/store.ts",
  ])
    assert.deepEqual(storeChannels(file, text), [], file)
})

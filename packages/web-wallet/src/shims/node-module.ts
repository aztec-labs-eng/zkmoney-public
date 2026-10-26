/**
 * Browser stub for `node:module`. `@aztec-labs/ethereum`'s L1 deploy module calls `createRequire` at
 * import, and the vendored `@oxide/l1-contracts` barrel reaches it through its deploy helpers. No
 * wallet flow deploys L1 contracts; the returned `require` fails loudly if one ever runs.
 */
export function createRequire(_from: string | URL): (id: string) => never {
  return (id) => {
    throw new Error(`require("${id}") is not available in the browser`)
  }
}

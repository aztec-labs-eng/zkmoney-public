/**
 * Browser stub for `@crate-crypto/node-eth-kzg` (a native Node addon reached
 * via `@aztec/blob-lib`'s KZG context). Blob commitment computation is a
 * server/sequencer concern — no wallet flow evaluates KZG in the browser. The
 * constants are the protocol-fixed EIP-4844 values behind blob-lib's lazy
 * `getBytesPerBlob`/`getBytesPerCommitment`; the context class fails loudly
 * if a runtime path ever reaches actual KZG computation.
 */
export const BYTES_PER_FIELD_ELEMENT = 32
export const BYTES_PER_BLOB = 4096 * BYTES_PER_FIELD_ELEMENT // 131072
export const BYTES_PER_COMMITMENT = 48

export class DasContextJs {
  // blob-lib instantiates via the static, never the constructor.
  static create(_opts?: unknown): DasContextJs {
    throw new Error(
      "@crate-crypto/node-eth-kzg is not available in the browser (KZG is server-side)",
    )
  }
  private constructor() {}
}

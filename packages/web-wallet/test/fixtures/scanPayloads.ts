import { Fr } from "@aztec/aztec.js/fields"
import { Grumpkin } from "@aztec/foundation/crypto/grumpkin"
import { Network } from "@obsidion/core/constants"
import { MAX_TAG_LENGTH } from "@obsidion/core/constants"
import { encodeInline, encodeRequestInline, mintQRHandshakeShare } from "@obsidion/front-core"
import { encodePaylinkInline } from "@obsidion/sdk"

export const PEER_L2 = `0x${"12".repeat(32)}` as const
export const PEER_L1 = `0x${"23".repeat(20)}` as const
export const CONNECT_FRAGMENT = encodeInline({
  version: "1.0:testnet",
  kind: "handshake",
  tag: "alice",
  l2Address: PEER_L2,
  xmtpHandle: PEER_L1,
  uuid: "a1b2c3d4-e5f6-4a7b-89ab-cdef01234567",
})
export const CONNECT_LINK = `https://wallet.staging.zk.money/connect#${CONNECT_FRAGMENT}`
export const REQUEST_FRAGMENT = encodeRequestInline({
  requestId: `0x${"01".repeat(32)}`,
  requesterTag: "alice",
  amountAtomic: 1000000n,
  networkId: "0xrollup",
  tokenAddress: `0x${"1b".repeat(32)}`,
})
export const PAYLINK_FRAGMENT = encodePaylinkInline({
  secret: new Fr(1n),
  paylinkType: "paylinkDirect",
  classId: new Fr(2n),
  chainId: 31337,
  fallbackKeyHash: new Fr(3n),
  rollupVersion: 1,
  escrowTagSecret: Grumpkin.generator,
})

const preparedPaylink = {
  secret: new Fr(4n),
  paylinkType: "paylinkDirect",
  classId: new Fr(5n),
  chainId: 31337,
  fallbackKeyHash: new Fr(6n),
  rollupVersion: 1,
  escrowTagSecret: Grumpkin.generator,
} satisfies Parameters<typeof encodePaylinkInline>[0]

export const PREPARED_PAYLINK_FRAGMENTS = {
  direct: encodePaylinkInline(preparedPaylink),
  email: encodePaylinkInline({
    ...preparedPaylink,
    paylinkType: "paylinkEmail",
  } satisfies Parameters<typeof encodePaylinkInline>[0]),
}

export async function walletQrCorpus() {
  const longConnect = await mintQRHandshakeShare({
    tag: "a".repeat(MAX_TAG_LENGTH),
    ownXmtpHandle: PEER_L1,
    chain: Network.TESTNET,
    l2Address: PEER_L2,
    stealthAddress: PEER_L1,
    baseUrl: "https://wallet-pr-123456789.staging.zk.money",
    uuid: () => "01234567-89ab-4def-8123-456789abcdef",
    now: () => 1750000000000,
    record: async () => {},
  })
  return {
    paylink: `https://paylink.zk.money/claim#${PAYLINK_FRAGMENT}`,
    request: `https://paylink.zk.money/request#${REQUEST_FRAGMENT}`,
    connect: CONNECT_LINK,
    longConnect,
  }
}

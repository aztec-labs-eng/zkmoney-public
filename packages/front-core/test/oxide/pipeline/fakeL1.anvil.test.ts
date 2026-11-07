// @vitest-environment node
/**
 * The fake L1 the pipeline suites run on, held to a real chain: each read the pipeline makes, sent
 * through the sdk to anvil with the real contracts and to the fake built from the same inputs,
 * answers the same. The portal's `Deposit` log and `TX_AMOUNT_CAP` need the rollup stack, which
 * anvil does not run; the SIPA rows e2e reads them on the sandbox.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createExtendedL1Client } from "@aztec-labs/ethereum/client"
import { deployMulticall3 } from "@aztec-labs/ethereum/contracts"
import { startAnvil } from "@aztec-labs/ethereum/test"
import { createLogger } from "@aztec-labs/foundation/log"
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  zeroAddress,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import {
  blessSIPAImplementation,
  deployContract,
  deployForwardingTable,
  deployMockPortal,
  deployNameRegistry,
  deploySIPAFactory,
  deploySIPAImplementations,
  deployUserOpSIPA,
  DEFAULT_FORWARDING_TABLE_INTENTS,
  MintableTokenAbi,
  MintableTokenBytecode,
  readForwardingTableRow,
  SipaIntent,
} from "@oxide/l1-contracts"
import {
  readBlessedImplementations,
  readDepositSIPAImplementation,
  readRegistrationSIPAImplementation,
  readSipaCloneImplementation,
  readSipaHoldingsAtHead,
  readSipaIntent,
  readSipaPortalTerms,
  readSweepEmitters,
  readTokenTransfers,
} from "@obsidion/sdk"
import { FakeL1 } from "./fakeL1"

const deployer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
)
const SIPA = "0x00000000000000000000000000000000000005a1" as Address
const OTHER = "0x00000000000000000000000000000000000005a2" as Address
const UNLISTED = "0x00000000000000000000000000000000000000ee" as Address

let stop: () => Promise<void>
let chain: PublicClient
let wallet: WalletClient
let fake: FakeL1
let token: Address
let factory: Address
let table: Address
let portal: Address
let implementations: Awaited<ReturnType<typeof deploySIPAImplementations>>
let laterUserOp: Address
const transfers: `0x${string}`[] = []

const send = async (hash: `0x${string}`) => {
  await chain.waitForTransactionReceipt({ hash })
  return hash
}

beforeAll(async () => {
  const anvil = await startAnvil({ port: 0, hardfork: "osaka" })
  stop = anvil.stop
  // Uncached: each test reads the head its transfers were mined under.
  chain = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl), cacheTime: 0 })
  wallet = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.rpcUrl) })
  await deployMulticall3(
    createExtendedL1Client([anvil.rpcUrl], deployer, foundry),
    createLogger("fake-l1-contract"),
  )
  token = await deployContract(wallet, chain, MintableTokenAbi, MintableTokenBytecode, [
    "Dai",
    "DAI",
    18,
  ])
  portal = await deployMockPortal(wallet, chain, token, 7n)
  const nameRegistry = await deployNameRegistry(wallet, chain, deployer.address, deployer.address)
  factory = await deploySIPAFactory(wallet, chain, deployer.address)
  const rows = [{ token, portal, intents: DEFAULT_FORWARDING_TABLE_INTENTS }]
  table = await deployForwardingTable(wallet, chain, {
    owner: deployer.address,
    rollupVersion: 7n,
    beneficiary: deployer.address,
    rows,
  })
  implementations = await deploySIPAImplementations(wallet, chain, {
    sipaFactory: factory,
    forwardingTable: table,
    nameRegistry,
  })
  laterUserOp = await deployUserOpSIPA(wallet, chain)
  await blessSIPAImplementation(wallet, chain, factory, laterUserOp)
  // The funder's money moves: into the SIPA twice, and once elsewhere; ETH reaches the SIPA.
  const write = async (functionName: "mint" | "transfer", to: Address, amount: bigint) =>
    send(
      await wallet.writeContract({
        account: deployer,
        chain: foundry,
        address: token,
        abi: MintableTokenAbi,
        functionName,
        args: [to, amount],
      }),
    )
  await write("mint", deployer.address, parseEther("10"))
  for (const [to, amount] of [
    [SIPA, parseEther("3")],
    [OTHER, parseEther("1")],
    [SIPA, parseEther("2")],
  ] as const)
    transfers.push(await write("transfer", to, amount))
  await send(
    await wallet.sendTransaction({
      account: deployer,
      chain: foundry,
      to: SIPA,
      value: parseEther("0.01"),
    }),
  )

  // The fake, built from the same inputs.
  fake = new FakeL1({ factory, table, portals: [portal] })
  fake.head = await chain.getBlockNumber()
  fake.token(token, "DAI", 18)
  const blessed = [
    [SipaIntent.Deposit, implementations.depositSIPAImplementation],
    [SipaIntent.Registration, implementations.registrationSIPAImplementation],
    [SipaIntent.UserOp, implementations.userOpSIPAImplementation],
    [SipaIntent.UserOp, laterUserOp],
  ] as const
  for (const [intent, implementation] of blessed) fake.bless(intent, implementation, 1n)
  for (const row of rows)
    for (const fees of row.intents)
      fake.row(row.token, fees.intent, {
        portal: row.portal,
        beneficiary: deployer.address,
        ...fees,
      })
  fake.setBalance(deployer.address, token, parseEther("10"))
  fake.transfer(token, deployer.address, SIPA, parseEther("3"))
  fake.transfer(token, deployer.address, OTHER, parseEther("1"))
  fake.transfer(token, deployer.address, SIPA, parseEther("2"))
  fake.setBalance(SIPA, zeroAddress, parseEther("0.01"))
}, 180_000)

afterAll(async () => {
  await stop?.()
})

/** The same read on both chains. */
async function both<T>(read: (client: PublicClient) => Promise<T>): Promise<[T, T]> {
  return [await read(chain), await read(fake.client)]
}

/** A log read without where it sits, which differs between the chains. */
const placeless = <T extends { blockNumber: bigint; txHash: string; logIndex: number }>(
  logs: T[],
) => logs.map((log) => ({ ...log, blockNumber: undefined, txHash: undefined, logIndex: undefined }))

describe("the fake L1 against anvil", () => {
  it("answers the factory's implementations and blessed list as the factory does", async () => {
    for (const read of [
      (c: PublicClient) => readDepositSIPAImplementation(c, factory),
      (c: PublicClient) => readRegistrationSIPAImplementation(c, factory),
      (c: PublicClient) => readBlessedImplementations(c, factory, SipaIntent.UserOp, 0n),
      (c: PublicClient) => readSipaIntent(c, factory, SIPA),
      (c: PublicClient) => readSipaCloneImplementation(c, factory, SIPA),
    ]) {
      const [real, faked] = await both(read)
      expect(faked).toEqual(real)
    }
  })

  it("answers the table's rows, and refuses a token it does not list", async () => {
    for (const intent of [SipaIntent.Deposit, SipaIntent.Registration, SipaIntent.UserOp]) {
      const [real, faked] = await both((c) => readForwardingTableRow(c, table, token, intent))
      expect(faked).toEqual(real)
    }
    const [real, faked] = await both((c) =>
      readForwardingTableRow(c, table, UNLISTED, SipaIntent.Deposit),
    )
    expect(real).toBeUndefined()
    expect(faked).toBeUndefined()
  })

  it("fails the portal terms where the portal has no cap", async () => {
    const route = { forwardingTable: table, token, intent: SipaIntent.Deposit }
    await expect(readSipaPortalTerms(chain, route)).rejects.toThrow()
    await expect(readSipaPortalTerms(fake.client, route)).rejects.toThrow()
  })

  it("answers transfers in and out by side, and the holdings of each address", async () => {
    const head = await chain.getBlockNumber()
    for (const [side, addresses] of [
      ["to", [SIPA]],
      ["from", [deployer.address]],
    ] as const) {
      const [real, faked] = await both((c) =>
        readTokenTransfers(c, [token], side, addresses, 0n, head),
      )
      expect(placeless(faked)).toEqual(placeless(real))
      expect(real.length).toBeGreaterThan(0)
    }
    const [real, faked] = await both((c) =>
      readSipaHoldingsAtHead(c, [
        { sipa: SIPA, tokens: [token] },
        { sipa: OTHER, tokens: [token] },
      ]),
    )
    expect(faked.balances).toEqual(real.balances)
    expect(typeof faked.timestamp).toBe(typeof real.timestamp)
  })

  it("finds no sweep emitter in a plain transfer", async () => {
    const [tx] = transfers
    const fakeTx = (await readTokenTransfers(fake.client, [token], "to", [SIPA], 0n, fake.head))[0]!
      .txHash
    expect(await readSweepEmitters(chain, tx!, 0n)).toEqual([])
    expect(await readSweepEmitters(fake.client, fakeTx, 0n)).toEqual([])
  })
})

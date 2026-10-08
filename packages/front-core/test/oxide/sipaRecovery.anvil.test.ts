// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createExtendedL1Client } from "@aztec/ethereum/client"
import { deployMulticall3 } from "@aztec/ethereum/contracts"
import { startAnvil } from "@aztec/ethereum/test"
import { createLogger } from "@aztec/foundation/log"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { secp256k1 } from "@noble/curves/secp256k1"
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
  erc20Abi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import {
  deployContract,
  deployMockLegacyDepositPool,
  deployMockPortal,
  deployNameRegistry,
  deploySIPAFactory,
  deploySIPAImplementations,
  deployOxideAccountFactory,
  predictAccountAddress,
  encodeAccountInitCode,
  TestERC20Abi,
  TestERC20Bytecode,
  predictSIPA,
  getAuthKeys,
} from "@oxide/l1-contracts"
import { predictLegacySIPA } from "@oxide/l1-contracts/legacy_sipa.js"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { buildDepositIntent, deriveRecoveryAddress } from "@obsidion/sdk"
import {
  runSipaRecovery,
  sipaDeployArgCandidates,
  type SipaRecoveryDeps,
} from "../../src/oxide/sipaRecovery"
import { signAccountDigest } from "../../src/oxide/accountSignature"

const deployer = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
)
const bootstrap = privateKeyToAccount(`0x${"42".repeat(32)}`)
const target = privateKeyToAccount(`0x${"77".repeat(32)}`).address
const salt = new Fr(123n)
const stealth = { scalar: 55n, publicKey: secp256k1.ProjectivePoint.BASE.multiply(55n).toAffine() }
const rollupVersion = 7n
const amount = 1000n

let stop: () => Promise<void>
let client: PublicClient
let wallet: WalletClient
let token: Address
let accountFactory: Address
let factory: Address
let implementation: Address

beforeAll(async () => {
  const anvil = await startAnvil({ port: 0, hardfork: "osaka" })
  stop = anvil.stop
  client = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) })
  wallet = createWalletClient({ account: deployer, chain: foundry, transport: http(anvil.rpcUrl) })
  await deployMulticall3(
    createExtendedL1Client([anvil.rpcUrl], deployer, foundry),
    createLogger("wallet-recovery"),
  )
  token = await deployContract(wallet, client, TestERC20Abi, TestERC20Bytecode, [
    "Test",
    "T",
    deployer.address,
  ])
  accountFactory = await deployOxideAccountFactory(wallet, client)
  // Recovery never reaches the portal; the mock only gives the implementations a version to pin.
  const portal = await deployMockPortal(wallet, client, token, rollupVersion)
  const nameRegistry = await deployNameRegistry(wallet, client, deployer.address, deployer.address)
  factory = await deploySIPAFactory(wallet, client, deployer.address)
  ;({ depositSIPAImplementation: implementation } = await deploySIPAImplementations(
    wallet,
    client,
    { sipaFactory: factory, portal, nameRegistry },
  ))
}, 120_000)
afterAll(async () => {
  await stop?.()
})

async function balance(address: Address) {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  })
}
async function mint(address: Address) {
  await client.waitForTransactionReceipt({
    hash: await wallet.writeContract({
      account: deployer,
      chain: foundry,
      address: token,
      abi: TestERC20Abi,
      functionName: "mint",
      args: [address, amount],
    }),
  })
}
const readDeployed = async (address: Address) =>
  !!(await client.getCode({ address }))?.replace(/^0x$/, "")
const sendTransaction = (to: Address, data: Hex) =>
  wallet.sendTransaction({ account: deployer, chain: foundry, to, data })
const waitForReceipt = async (hash: Hex) =>
  (await client.waitForTransactionReceipt({ hash })).status === "success"

it("recovers a saved account deposit with both contracts initially undeployed, then recovers a later deposit", async () => {
  const account = await predictAccountAddress(client, accountFactory, bootstrap.address)
  const intentHash = keccak256(toBytes("current-recovery"))
  const recoveryCommitment = deriveRecoveryCommitment(
    salt,
    EthAddress.fromString(account),
  ).toString() as Hex
  const sipa = await predictSIPA(
    client,
    factory,
    implementation,
    intentHash,
    recoveryCommitment,
    rollupVersion,
    true,
  )
  const record = JSON.parse(
    JSON.stringify({
      sipaAddress: sipa,
      messageSecret: salt.toString(),
      recoveryAddress: "",
      recipientHash: new Fr(1n).toString(),
      tokenAddress: token,
      origin: {
        protocol: "account",
        sipaFactory: factory,
        implementation,
        intentHash,
        rollupVersion: String(rollupVersion),
        resweepable: true,
        recoveryCommitment,
        recoveryAccount: account,
        accountFactory,
      },
    }),
  )
  expect(await readDeployed(sipa)).toBe(false)
  expect(await readDeployed(account)).toBe(false)
  for (let attempt = 0; attempt < 2; attempt++) {
    await mint(sipa)
    const before = await balance(target)
    const upsert = vi.fn(async () => undefined)
    await runSipaRecovery({
      record,
      stealthKey: stealth,
      target,
      tokens: [token],
      chainId: foundry.id,
      accountInitCode:
        attempt === 0 ? encodeAccountInitCode(accountFactory, bootstrap.address) : undefined,
      signAccount: (account, hash) =>
        signAccountDigest({
          account,
          hash,
          chainId: foundry.id,
          bootstrap,
          reader: {
            getCode: (address) => client.getCode({ address }),
            readAuthKeys: (address) => getAuthKeys(client, address),
          },
        }),
      deployment: {
        readDeployed,
        candidates: sipaDeployArgCandidates(record, []),
        predict: (candidate) =>
          candidate.protocol === "account"
            ? predictSIPA(
                client,
                candidate.sipaFactory,
                candidate.args.implementation,
                candidate.args.intentHash,
                candidate.args.recoveryCommitment,
                candidate.args.rollupVersion,
                candidate.args.resweepable,
              )
            : predictLegacySIPA(client, candidate.sipaFactory, candidate.args),
      },
      sendTransaction,
      waitForReceipt,
      store: { get: () => undefined, upsert },
    })
    expect(await balance(target)).toBe(before + amount)
    expect(await balance(sipa)).toBe(0n)
    expect(upsert).toHaveBeenCalledWith(
      sipa,
      expect.objectContaining({ phase: "recovered", recoveryTxHash: expect.any(String) }),
    )
  }
})

it("recovers ETH and a token sent to an undeployed account deposit in one transaction", async () => {
  const account = await predictAccountAddress(client, accountFactory, bootstrap.address)
  const intentHash = keccak256(toBytes("eth-recovery"))
  const recoveryCommitment = deriveRecoveryCommitment(
    salt,
    EthAddress.fromString(account),
  ).toString() as Hex
  const sipa = await predictSIPA(
    client,
    factory,
    implementation,
    intentHash,
    recoveryCommitment,
    rollupVersion,
    true,
  )
  const origin = {
    protocol: "account" as const,
    sipaFactory: factory,
    implementation,
    intentHash,
    rollupVersion: String(rollupVersion),
    resweepable: true,
    recoveryCommitment,
    recoveryAccount: account,
    accountFactory,
  }
  const record = {
    sipaAddress: sipa,
    messageSecret: salt.toString(),
    recoveryAddress: "",
    tokenAddress: zeroAddress,
    origin,
  } as never
  await waitForReceipt(
    await wallet.sendTransaction({
      account: deployer,
      chain: foundry,
      to: sipa,
      value: parseEther("0.5"),
    }),
  )
  expect(await readDeployed(sipa)).toBe(false)
  const deps: Omit<SipaRecoveryDeps, "tokens"> = {
    record,
    stealthKey: stealth,
    target,
    chainId: foundry.id,
    accountInitCode: (await readDeployed(account))
      ? undefined
      : encodeAccountInitCode(accountFactory, bootstrap.address),
    signAccount: (account, hash) =>
      signAccountDigest({
        account,
        hash,
        chainId: foundry.id,
        bootstrap,
        reader: {
          getCode: (address) => client.getCode({ address }),
          readAuthKeys: (address) => getAuthKeys(client, address),
        },
      }),
    deployment: {
      readDeployed,
      candidates: sipaDeployArgCandidates({ recipientHash: "", recoveryAddress: "", origin }, []),
      predict: (candidate) =>
        predictSIPA(
          client,
          candidate.sipaFactory,
          candidate.args.implementation,
          candidate.args.intentHash,
          (candidate.args as { recoveryCommitment: Hex }).recoveryCommitment,
          candidate.args.rollupVersion,
          candidate.args.resweepable,
        ),
    },
    sendTransaction,
    waitForReceipt,
    store: { get: () => undefined, upsert: vi.fn(async () => undefined) },
  }
  await expect(runSipaRecovery({ ...deps, tokens: [zeroAddress, token] })).rejects.toThrow()
  expect(await client.getBalance({ address: sipa })).toBe(parseEther("0.5"))
  expect(await readDeployed(sipa)).toBe(false)

  await mint(sipa)
  const before = await client.getBalance({ address: target })
  const tokensBefore = await balance(target)
  await runSipaRecovery({ ...deps, tokens: [zeroAddress, token] })

  expect(await client.getBalance({ address: sipa })).toBe(0n)
  expect(await client.getBalance({ address: target })).toBe(before + parseEther("0.5"))
  expect(await balance(sipa)).toBe(0n)
  expect(await balance(target)).toBe(tokensBefore + amount)
})

describe.each([false, true])("historical persisted deposit (resweepable=%s)", (resweepable) => {
  it("reconstructs a codeless address and moves its funds through the old recovery protocol", async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../vendor/oxide/yarn-project/end-to-end/src/test_utils/fixtures/legacy_sipa.json",
          import.meta.url,
        ),
        "utf8",
      ),
    )
    const pool = await deployMockLegacyDepositPool(wallet, client, rollupVersion)
    const legacyFactory = await deployContract(
      wallet,
      client,
      fixture.contracts.SIPAFactory.abi,
      fixture.contracts.SIPAFactory.bytecode,
      [deployer.address],
    )
    const legacyImplementation = await deployContract(
      wallet,
      client,
      fixture.contracts.DepositSIPA.abi,
      fixture.contracts.DepositSIPA.bytecode,
      [pool, 1n],
    )
    await client.waitForTransactionReceipt({
      hash: await wallet.writeContract({
        account: deployer,
        chain: foundry,
        address: legacyFactory,
        abi: fixture.contracts.SIPAFactory.abi,
        functionName: "bless",
        args: [legacyImplementation],
      }),
    })
    const recipientHash = new Fr(2n).toString() as Hex
    const recoveryAddress = deriveRecoveryAddress(stealth.publicKey, salt).toString() as Address
    const intent = buildDepositIntent({
      implementation: legacyImplementation,
      recipientCommitment: recipientHash,
    })
    const sipa = await predictLegacySIPA(client, legacyFactory, {
      implementation: legacyImplementation,
      intentHash: intent.intentHash,
      recoveryAddress,
      rollupVersion,
      resweepable,
    })
    const record = JSON.parse(
      JSON.stringify({
        sipaAddress: sipa,
        recipientHash,
        messageSecret: salt.toString(),
        recoveryAddress,
        tokenAddress: token,
      }),
    )
    expect(record.origin).toBeUndefined()
    expect(await readDeployed(sipa)).toBe(false)
    for (let attempt = 0; attempt < 2; attempt++) {
      await mint(sipa)
      const before = await balance(target)
      const upsert = vi.fn(async () => undefined)
      await runSipaRecovery({
        record,
        stealthKey: stealth,
        target,
        tokens: [token],
        chainId: foundry.id,
        deployment: {
          readDeployed,
          candidates: sipaDeployArgCandidates(record, [
            {
              sipaFactory: legacyFactory,
              implementation: legacyImplementation,
              rollupVersion,
            },
          ]),
          predict: (candidate) => {
            if (candidate.protocol !== "legacy-eoa") throw new Error("Unexpected protocol")
            return predictLegacySIPA(client, candidate.sipaFactory, candidate.args)
          },
        },
        sendTransaction,
        waitForReceipt,
        store: { get: () => undefined, upsert },
      })
      expect(await balance(target)).toBe(before + amount)
      expect(await balance(sipa)).toBe(0n)
      expect(upsert).toHaveBeenCalledWith(
        sipa,
        expect.objectContaining({ phase: "recovered", recoveryTxHash: expect.any(String) }),
      )
    }
  })
})

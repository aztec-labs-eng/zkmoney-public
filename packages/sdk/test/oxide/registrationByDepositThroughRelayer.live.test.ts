/**
 * Registration-by-deposit driven THROUGH a live persistent sandbox + a RUNNING oxide-relayer
 * (registration-fee.md, D3a). Unlike `registrationByDeposit.e2e.sandbox.test.ts` — which deploys its own
 * in-process stack and acts AS the relayer (deploy clone + sweep inline) — this exercises the real
 * rail end to end:
 *
 *   broadcast the registration SIPA over `SIPABroadcaster.broadcast_registration_sipa`
 *     → the running relayer discovers it from the `RegistrationSIPA` public log
 *     → funds land at the counterfactual SIPA on L1
 *     → the relayer deploys the clone and runs the 7-arg registration sweep (`AccountRegistry.register`)
 *     → assert register()'s outcomes on-chain.
 *
 * It needs external infra (an Aztec node, an anvil L1, the address-registry serving the oxide
 * manifest, and a running sandbox oxide-relayer in `deposits` mode), so it is OPT-IN: it self-skips
 * unless `OXIDE_LIVE_RELAYER_E2E=1`. Run it against a sandbox brought up by
 * `deploySandboxOxide.ts` + `oxide-relayer/run.sh`:
 *
 *   OXIDE_LIVE_RELAYER_E2E=1 pnpm --filter @obsidion/sdk exec vitest run \
 *     test/oxide/registrationByDepositThroughRelayer.live.test.ts
 *
 * The registry's domain owner + registration fee are deployment immutables; override
 * `OXIDE_SANDBOX_DOMAIN_OWNER_KEY` / `OXIDE_SANDBOX_REGISTRATION_FEE` to match a non-default deploy.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { secp256k1 } from "@noble/curves/secp256k1"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { createAztecNodeClient } from "@aztec/aztec.js/node"
import { getInitialTestAccountsData } from "@aztec/accounts/testing"
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC"
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toBytes,
  type Address,
  type Hex,
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { extractPinnedOxideEnvTuple } from "@obsidion/core/oxide"
import {
  predictAccountAddress,
  buildNameClaimTypedData,
  getUserRecord,
  readNameOf,
  readUserAddress,
} from "@oxide/l1-contracts"
import {
  EMPTY_SIGNED_TERMS,
  SipaSelfResolver,
  encodeRegistrationBroadcast,
  epochDay,
  getBroadcasterArtifact,
  getSponsoredFPCInstance,
  getSponsoredFeePaymentMethod,
  readDepositFee,
  readSweepEvents,
  sendEmptyTxs,
  BroadcasterContract,
} from "../../src/index.js"
import { ObsidionWalletTest } from "../../src/obsidion/ObsidionWalletTest.js"

const LIVE = process.env.OXIDE_LIVE_RELAYER_E2E === "1"

const MANIFEST_URL =
  process.env.OXIDE_SANDBOX_MANIFEST_URL ?? "http://localhost:8083/oxide/sandbox.json"
const NODE_URL = process.env.AZTEC_NODE_URL ?? "http://localhost:8080"
const L1_RPC = process.env.L1_RPC_URL ?? "http://localhost:8545"
const PORTAL = process.env.OXIDE_PORTAL ?? ""
// Anvil #0 — the sandbox token owner (mint) and the default relayer EOA.
const TOKEN_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex
// Registry domain owner + beneficiary id 0 (deploySandboxOxide DEFAULT_DOMAIN_OWNER_KEY).
const DOMAIN_OWNER_KEY = (process.env.OXIDE_SANDBOX_DOMAIN_OWNER_KEY ??
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a") as Hex
const STEALTH_SCALAR = BigInt(`0x${"4a".repeat(31)}01`)
const RESOLVER_SCALAR = BigInt(`0x${"5a".repeat(31)}01`)
const REG_FEE = BigInt(process.env.OXIDE_SANDBOX_REGISTRATION_FEE ?? String(49n * 10n ** 17n))
const DEPOSIT_AMOUNT = 50n * 10n ** 18n
const NONCE = 4242
const SWEEP_TIMEOUT_MS = 4 * 60_000
const TEST_TIMEOUT = 8 * 60_000

const REGISTRATION_RECORD_ABI = [
  {
    type: "tuple",
    components: [
      { name: "nameHash", type: "bytes32" },
      { name: "owner", type: "address" },
      {
        name: "publicKey",
        type: "tuple",
        components: [
          { name: "x", type: "uint256" },
          { name: "y", type: "uint256" },
        ],
      },
      { name: "l2Address", type: "bytes32" },
      { name: "resolver", type: "address" },
      { name: "rollupVersion", type: "uint256" },
      { name: "beneficiaryId", type: "uint256" },
    ],
  },
] as const

const tokenAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function balanceOf(address owner) view returns (uint256)",
])

const eqAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

describe.skipIf(!LIVE)("registration by deposit through a running relayer (live)", () => {
  let manifest: unknown

  beforeAll(async () => {
    manifest = await (await fetch(MANIFEST_URL)).json()
  }, TEST_TIMEOUT)

  it(
    "broadcasts a registration SIPA that the running relayer discovers, sweeps, and register()s",
    async () => {
      const { tuple } = extractPinnedOxideEnvTuple(manifest, { portal: PORTAL })
      const registry = tuple.registry as Address
      const metadataRegistry = tuple.accountMetadataRegistry as Address
      const factory = tuple.accountFactory as Address
      const portal = tuple.portal as Address
      const registrationImpl = tuple.registrationSIPAImplementation as Address
      const token = tuple.token as Address
      const broadcasterL2 = tuple.l2Broadcaster as string
      const rollupVersion = BigInt(tuple.rollupVersion)

      const publicClient = createPublicClient({ chain: foundry, transport: http(L1_RPC) })
      const chainId = await publicClient.getChainId()
      const minter = privateKeyToAccount(TOKEN_OWNER_KEY)
      const walletClient = createWalletClient({
        account: minter,
        chain: foundry,
        transport: http(L1_RPC),
      })

      // Fresh bootstrap key per run → a fresh, undeployed owner (a 4337 account maps to one name).
      const bootstrap = privateKeyToAccount(generatePrivateKey())
      const domainOwner = privateKeyToAccount(DOMAIN_OWNER_KEY)
      const beneficiary = domainOwner.address // beneficiary id 0
      const owner = (await predictAccountAddress(
        publicClient,
        factory,
        bootstrap.address,
      )) as Address

      // L2 wallet against the LIVE node: a schnorr test account + SponsoredFPC, also drives blocks.
      const node = createAztecNodeClient(NODE_URL)
      const nodeInfo = await node.getNodeInfo()
      const wallet: any = await ObsidionWalletTest.create(node, {
        dataDirectory: `pxe-reg-relayer-e2e-${Date.now()}`,
        proverEnabled: nodeInfo.realProofs,
      })
      const accountsData = await getInitialTestAccountsData()
      const accounts = await Promise.all(
        accountsData.map(async (d) => {
          const mgr = await wallet.createSchnorrAccount(d.secret, d.salt, d.signingKey, d.type)
          return mgr.getAccountContract().getAccount(await mgr.getCompleteAddress())
        }),
      )
      await wallet.setAccounts(accounts)
      await wallet.pxe.registerContractClass(SponsoredFPCContractArtifact)
      await wallet.pxe.registerContract(await getSponsoredFPCInstance())
      const from = accounts[0]!
      const paymentMethod = await getSponsoredFeePaymentMethod(wallet.pxe)
      const l2Recipient = from.getAddress() as AztecAddress

      try {
        const stealth = secp256k1.ProjectivePoint.BASE.multiply(STEALTH_SCALAR).toAffine()
        const resolverPoint = secp256k1.ProjectivePoint.BASE.multiply(RESOLVER_SCALAR).toAffine()
        const selfResolver = new SipaSelfResolver(STEALTH_SCALAR, {
          x: resolverPoint.x,
          y: resolverPoint.y,
        })

        const nameHash = keccak256(toBytes(`relay-e2e-${Date.now()}`))
        const record = {
          nameHash,
          owner,
          publicKey: { x: stealth.x, y: stealth.y },
          l2Address: l2Recipient.toString() as Hex,
          resolver: domainOwner.address,
          rollupVersion,
          beneficiaryId: 0n,
        }
        const registrationData = encodeAbiParameters(REGISTRATION_RECORD_ABI, [record])
        const registration = keccak256(registrationData)

        const day = epochDay((await publicClient.getBlock()).timestamp)
        const { sipaAddress, sipaArgs, resolution } = await selfResolver.resolveAddress({
          user: l2Recipient,
          day,
          nonce: NONCE,
          publicClient,
          accountRegistry: registry,
          portal,
          rollupVersion,
          registration,
          resweepable: false,
        })

        const consentDigest = keccak256(
          encodeAbiParameters(
            [{ type: "bytes" }, { type: "uint256" }, { type: "address" }],
            [registrationData, BigInt(chainId), registry],
          ),
        )
        const consentSig = await bootstrap.sign({ hash: consentDigest })
        const deadline = 9_999_999_999n
        // Domain-owner nonces are a global single-use set (NameRegistry.usedDomainOwnerNonces);
        // a fresh value per run keeps repeated runs against one deployment from colliding.
        const claimNonce =
          BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000))
        const claimSig = await domainOwner.signTypedData(
          buildNameClaimTypedData({
            chainId,
            nameRegistry: registry,
            nameHash,
            userAddress: owner,
            nonce: claimNonce,
            deadline,
          }),
        )
        const domainAuth = { nonce: claimNonce, deadline, signature: claimSig }

        // Broadcast over the D3a rail so the running relayer discovers the registration SIPA.
        const artifact = await getBroadcasterArtifact()
        const broadcasterAddr = AztecAddress.fromStringUnsafe(broadcasterL2)
        const instance = await node.getContract(broadcasterAddr)
        expect(instance).toBeTruthy()
        await wallet.pxe.registerContractClass(artifact)
        await wallet.pxe.registerContract(instance)
        const broadcaster = BroadcasterContract.at(broadcasterAddr, artifact, wallet)
        const call = encodeRegistrationBroadcast({
          recipient: l2Recipient.toString() as Hex,
          sharedSecretSalt: resolution.messageSecret.toString() as Hex,
          sipaArgs,
          registrationData,
          consentSig,
          domainAuth,
          signedTerms: EMPTY_SIGNED_TERMS,
        })
        await broadcaster.methods
          .broadcast_registration_sipa(
            call.recipient,
            call.sharedSecretSalt,
            call.registrationHi,
            call.registrationLo,
            call.recoveryAddress,
            call.depositPool,
            call.resweepable,
            call.payloadBytesLen,
            call.payloadFields,
          )
          .send({ from: l2Recipient, fee: { paymentMethod } })

        // Fund the SIPA on L1 (mint directly, as the token owner).
        const beneficiaryBefore = (await publicClient.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [beneficiary],
        })) as bigint
        expect(await publicClient.getCode({ address: owner })).toBeFalsy()
        const mintHash = await walletClient.writeContract({
          address: token,
          abi: tokenAbi,
          functionName: "mint",
          args: [sipaAddress, DEPOSIT_AMOUNT],
          account: minter,
          chain: foundry,
        })
        await publicClient.waitForTransactionReceipt({ hash: mintHash })

        // Wait for the running relayer to sweep, driving L2 blocks (sandbox has no continuous sequencer).
        const deadlineMs = Date.now() + SWEEP_TIMEOUT_MS
        let registered = false
        while (Date.now() < deadlineMs) {
          await sendEmptyTxs(wallet, from, 2, paymentMethod)
          if (eqAddr(await readUserAddress(publicClient, registry, nameHash), owner)) {
            registered = true
            break
          }
        }
        await sendEmptyTxs(wallet, from, 2, paymentMethod)
        expect(registered).toBe(true)

        // register()'s outcomes, verified on L1.
        expect(eqAddr(await readUserAddress(publicClient, registry, nameHash), owner)).toBe(true)
        expect((await readNameOf(publicClient, registry, owner)).toLowerCase()).toBe(
          nameHash.toLowerCase(),
        )
        const record = await getUserRecord(publicClient, metadataRegistry, owner)
        expect(eqAddr(record.l2Address, l2Recipient.toString())).toBe(true)
        const beneficiaryAfter = (await publicClient.readContract({
          address: token,
          abi: tokenAbi,
          functionName: "balanceOf",
          args: [beneficiary],
        })) as bigint
        expect(beneficiaryAfter - beneficiaryBefore).toBe(REG_FEE)
        expect(await publicClient.getCode({ address: owner })).toBeTruthy()

        const sweeps = await readSweepEvents(publicClient, sipaAddress)
        expect(sweeps.length).toBeGreaterThan(0)
        const depositFee = await readDepositFee(publicClient, registrationImpl)
        expect(sweeps[0]!.amount).toBe(DEPOSIT_AMOUNT - REG_FEE - depositFee)
      } finally {
        await wallet.stop()
      }
    },
    TEST_TIMEOUT,
  )
})

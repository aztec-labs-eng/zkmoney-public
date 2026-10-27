// @obsidion/core/constants — leaf runtime values for the obsidion workspace.
//
// Invariant: this module must not transitively import contract artifacts,
// any @obsidion workspace package, or @aztec/* runtime entry points.
// All @aztec/* references are type-only and live under ./types.

// ── Network ──────────────────────────────────────────────────────────

export enum Network {
  TESTNET = "testnet",
  SANDBOX = "sandbox",
  MAINNET = "mainnet",
}

/** True when a registry value is keyed by network rather than holding one flat value. */
export function isNetworkScoped(value: object): boolean {
  return Object.values(Network).some((network) => network in value)
}

// ── Contracts catalog ─────────────────────────────────────────────────

// The deployment slot: the deploy salt's preimage and every ContractService's local version
// stamp. Each generation must resolve its own slot, so this MUST differ from the frozen v4
// snapshot's baked "0.0.2".
export const CONTRACT_SERVICE_VERSION = "0.0.3"

export const DEFAULT_CONTRACTS = {
  // The oxide-owned consolidated token+bridge contract. This is the ONLY
  // token contract identity — the ticker is strictly a display symbol
  // (WALLET_TOKEN_SYMBOL below), never a ContractName, and does not move
  // when the ticker does.
  oxideToken: "oxideToken",
  oidcKeyRegistry: "oidcKeyRegistry",
  sponsorFPC: "sponsorFPC",
  // Campaign sponsorship: eligibility is the user's NameClaim + bootstrap-key binding.
  claimFpc: "claimFpc",
  obsidionAccountAlpha: "obsidionAccountAlpha",
  obsidionAccountAlphaTest: "obsidionAccountAlphaTest",
  paylinkEmail: "paylinkEmail",
  paylinkDirect: "paylinkDirect",
  passwordFPC: "passwordFPC",
} as const

export const DEFAULT_CONTRACTS_NAME = [
  DEFAULT_CONTRACTS.oxideToken,
  DEFAULT_CONTRACTS.oidcKeyRegistry,
  DEFAULT_CONTRACTS.sponsorFPC,
  DEFAULT_CONTRACTS.claimFpc,
  DEFAULT_CONTRACTS.obsidionAccountAlpha,
  DEFAULT_CONTRACTS.obsidionAccountAlphaTest,
  DEFAULT_CONTRACTS.paylinkEmail,
  DEFAULT_CONTRACTS.paylinkDirect,
  DEFAULT_CONTRACTS.passwordFPC,
] as const

// ── Fee payment ──────────────────────────────────────────────────────

/**
 * FPC Payment Types - specifies which FPC contract to use for fee payments
 */
export enum FPCPaymentType {
  SPONSOR_FPC = "sponsorFPC",
  PASSWORD_FPC = "passwordFPC",
}

// Type-only import: erased at runtime; does not pull anything heavy.
import type { ContractName } from "../types/index.js"

/**
 * Maps FPC payment type to the corresponding contract name
 */
export function getFPCContractName(paymentType: FPCPaymentType): ContractName {
  switch (paymentType) {
    case FPCPaymentType.SPONSOR_FPC:
      return DEFAULT_CONTRACTS.sponsorFPC
    case FPCPaymentType.PASSWORD_FPC:
      return DEFAULT_CONTRACTS.passwordFPC
    default:
      throw new Error(`Unknown FPC payment type: ${paymentType}`)
  }
}

// ── Auth ─────────────────────────────────────────────────────────────

export enum AUTH_TYPE {
  WEB_AUTHN = 1,
  ECDSA_K256 = 2,
  SCHNORR = 3,
  MULTISIG = 4,
}

// ── WebAuthn PRF salt ────────────────────────────────────────────────

/** Label the PRF salt is hashed from. Never sent to an authenticator itself. */
export const MSK_PRF_SALT_LABEL = "obsidion.wallet.msk.prf.salt.v1"

/**
 * The 32-byte input every wallet master key is derived from: `SHA-256(utf8(MSK_PRF_SALT_LABEL))`,
 * precomputed. Every account's address derives from the key this salt yields, so the bytes are
 * protocol-fixed: a different salt silently derives a different wallet for the same passkey. A new
 * scheme adds a v2 salt beside this one. `test/mskPrf.test.mjs` pins the bytes and the hash.
 */
export const MSK_PRF_SALT: Uint8Array = new Uint8Array([
  0xa8, 0xe5, 0x12, 0x61, 0xf6, 0xa1, 0x47, 0xfd, 0x70, 0xb4, 0x50, 0x6a, 0xc3, 0x12, 0x75, 0xc6,
  0x12, 0x55, 0xaa, 0x40, 0x54, 0xb8, 0xfb, 0x72, 0xc1, 0x69, 0xa1, 0x80, 0x24, 0x2f, 0xbb, 0xc6,
])

// ── Passkey providers ────────────────────────────────────────────────

/** Default relying-party display name in the passkey sheet; the web wallet allows an environment override. */
export const PASSKEY_RP_NAME = "zk.money"

export const WEB_PASSKEY_RP_IDS = {
  "production": "auth.zk.money",
  "dev": "dev.zk.money",
  "staging": "staging.zk.money",
  "preview": "staging.zk.money",
  "prod-preview": "preview.zk.money",
  "local": "localhost",
} as const

export const WEB_PASSKEY_PRODUCTION_ORIGINS = [
  "https://auth.zk.money",
  "https://wallet.zk.money",
  "https://launch.zk.money",
] as const

/** All-zeros AAGUID; iCloud Keychain reports it on iOS native. */
export const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000"
/** Apple iCloud Keychain, when a non-zero AAGUID is surfaced. */
export const APPLE_ICLOUD_AAGUID = "fbfc3007-154e-4ecc-8c0b-6e020557d7bd"
export const GPM_AAGUID = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4"
export const ONEPASSWORD_AAGUID = "bada5566-a7aa-401f-bd96-45619a55120d"

/** YubiKey 5 Series with NFC; the one security key measured on iOS (prf-compat 2026-06-10). */
export const YUBIKEY_5_SERIES_NFC_AAGUID = "d7781e5d-e353-46aa-afe2-3ca49f13332a"
export const YUBIKEY_5_USB_A_AAGUID = "cb69481e-8ff7-4039-93ec-0a2729a154a8"
export const YUBIKEY_5_USB_C_AAGUID = "ee882879-721c-4913-9775-3dfcce97072a"
export const YUBIKEY_5_NFC_AAGUID = "2fc0579f-8113-47ea-b116-bb5a8db9202a"
export const YUBIKEY_5_SERIES_AAGUID = "fa2b99dc-9e39-4257-8f92-4a30d23c4118"

/**
 * Every Yubico FIDO2 authenticator the FIDO Metadata Service lists, per firmware and profile:
 * YubiKey 5, 5 FIPS, 5 CCN, Bio and Security Key. Read off the MDS-backed
 * passkeydeveloper/passkey-authenticator-aaguids list on 2026-09-25 and checked against MDS blob 285:
 * every id's metadata lists the `hmac-secret` extension the PRF output rides on. A new firmware
 * ships a new id.
 */
export const YUBICO_AAGUIDS: readonly string[] = [
  "a4e9fc6d-4cbe-4758-b8ba-37598bb5bbaa", // Security Key NFC by Yubico
  "b7d3f68e-88a6-471e-9ecf-2df26d041ede", // Security Key NFC by Yubico
  "e77e3c64-05e3-428b-8824-0cbeb04b829d", // Security Key NFC by Yubico
  "0bb43545-fd2c-4185-87dd-feb0b2916ace", // Security Key NFC by Yubico - Enterprise Edition
  "47ab2fb4-66ac-4184-9ae1-86be814012d5", // Security Key NFC by Yubico - Enterprise Edition
  "ed042a3a-4b22-4455-bb69-a267b652ae7e", // Security Key NFC by Yubico - Enterprise Edition
  "72c6b72d-8512-4c66-8359-9d3d10d9222f", // Security Key NFC by Yubico - Enterprise Edition (Enterprise Profile)
  "9ff4cc65-6154-4fff-ba09-9e2af7882ad2", // Security Key NFC by Yubico - Enterprise Edition (Enterprise Profile)
  "2772ce93-eb4b-4090-8b73-330f48477d73", // Security Key NFC by Yubico - Enterprise Edition Preview
  "760eda36-00aa-4d29-855b-4012a182cdeb", // Security Key NFC by Yubico Preview
  "b92c3f9a-c014-4056-887f-140a2501163b", // Security Key by Yubico
  "f8a011f3-8c0a-4d15-8006-17111f9edc7d", // Security Key by Yubico
  "149a2021-8ef6-4133-96b8-81f8d5b7f1f5", // Security Key by Yubico with NFC
  "6d44ba9b-f6ec-2e49-b930-0c8fe920cb73", // Security Key by Yubico with NFC
  "3aa78eb1-ddd8-46a8-a821-8f8ec57a7bd5", // YubiKey 5 CCN Series with NFC
  "eb7ef748-cbe0-4b40-b8f6-07bd2d592d35", // YubiKey 5 CCN Series with NFC (Consumer Profile)
  "3ec9c8d3-a5a7-415b-a7b5-f1d606368d3f", // YubiKey 5 CCN Series with NFC (Enterprise Profile)
  "4fc84f16-2545-4e53-b8fc-7bf4d7282a10", // YubiKey 5 CCN Series with NFC (Enterprise Profile)
  "57f7de54-c807-4eab-b1c6-1c9be7984e92", // YubiKey 5 FIPS Series
  "73bb0cd4-e502-49b8-9c6f-b59445bf720b", // YubiKey 5 FIPS Series
  "905b4cb4-ed6f-4da9-92fc-45e0d4e9b5c7", // YubiKey 5 FIPS Series (Enterprise Profile)
  "d2fbd093-ee62-488d-9dad-1e36389f8826", // YubiKey 5 FIPS Series (RC Preview)
  "7b96457d-e3cd-432b-9ceb-c9fdd7ef7432", // YubiKey 5 FIPS Series with Lightning
  "85203421-48f9-4355-9bc8-8a53846e5083", // YubiKey 5 FIPS Series with Lightning
  "3a662962-c6d4-4023-bebb-98ae92e78e20", // YubiKey 5 FIPS Series with Lightning (Enterprise Profile)
  "9e66c661-e428-452a-a8fb-51f7ed088acf", // YubiKey 5 FIPS Series with Lightning (RC Preview)
  "5b0e46ba-db02-44ac-b979-ca9b84f5e335", // YubiKey 5 FIPS Series with Lightning Preview
  "c1f9a0bc-1dd2-404a-b27f-8e29047a43fd", // YubiKey 5 FIPS Series with NFC
  "fcc0118f-cd45-435b-8da1-9782b2da0715", // YubiKey 5 FIPS Series with NFC
  "79f3c8ba-9e35-484b-8f47-53a5a0f5c630", // YubiKey 5 FIPS Series with NFC (Enterprise Profile)
  "ce6bf97f-9f69-4ba7-9032-97adc6ca5cf1", // YubiKey 5 FIPS Series with NFC (RC Preview)
  "62e54e98-c209-4df3-b692-de71bb6a8528", // YubiKey 5 FIPS Series with NFC Preview
  "19083c3d-8383-4b18-bc03-8f1c9ab2fd1b", // YubiKey 5 Series
  "cb69481e-8ff7-4039-93ec-0a2729a154a8", // YubiKey 5 Series
  "ee882879-721c-4913-9775-3dfcce97072a", // YubiKey 5 Series
  "ff4dac45-ede8-4ec2-aced-cf66103f4335", // YubiKey 5 Series
  "0a357157-9b18-4c8a-920e-d156e972b2f8", // YubiKey 5 Series (Consumer Profile)
  "20ac7a17-c814-4833-93fe-539f0d5e3389", // YubiKey 5 Series (Enterprise Profile)
  "4599062e-6926-4fe7-9566-9e8fb1aedaa0", // YubiKey 5 Series (Enterprise Profile)
  "524de2de-982f-49b4-a769-2b5e3b73ad79", // YubiKey 5 Series (Enterprise Profile)
  "24673149-6c86-42e7-98d9-433fb5b73296", // YubiKey 5 Series with Lightning
  "a02167b9-ae71-4ac7-9a07-06432ebb6f1c", // YubiKey 5 Series with Lightning
  "c5ef55ff-ad9a-4b9f-b580-adebafe026d0", // YubiKey 5 Series with Lightning
  "03012cb7-4fb2-42e7-9e8d-a81f10e2a5e9", // YubiKey 5 Series with Lightning (Consumer Profile)
  "3b24bf49-1d45-4484-a917-13175df0867b", // YubiKey 5 Series with Lightning (Enterprise Profile)
  "b90e7dc1-316e-4fee-a25a-56a666a670fe", // YubiKey 5 Series with Lightning (Enterprise Profile)
  "c3479970-e58a-4f70-836f-853bf42fb063", // YubiKey 5 Series with Lightning (Enterprise Profile)
  "3124e301-f14e-4e38-876d-fbeeb090e7bf", // YubiKey 5 Series with Lightning Preview
  "2fc0579f-8113-47ea-b116-bb5a8db9202a", // YubiKey 5 Series with NFC
  "a25342c0-3cdc-4414-8e46-f4807fca511c", // YubiKey 5 Series with NFC
  "d7781e5d-e353-46aa-afe2-3ca49f13332a", // YubiKey 5 Series with NFC
  "fa2b99dc-9e39-4257-8f92-4a30d23c4118", // YubiKey 5 Series with NFC
  "f4ce5fc0-57d3-46f5-a736-efb7d5bc63b5", // YubiKey 5 Series with NFC (Consumer Profile)
  "7dab85a5-d16d-4eaf-a7ef-4c1385b151c5", // YubiKey 5 Series with NFC (Consumer Profile) KVZR57-2
  "1ac71f64-468d-4fe0-bef1-0e5f2f551f18", // YubiKey 5 Series with NFC (Enterprise Profile)
  "41e39911-c669-4811-b860-c6ad0b411b96", // YubiKey 5 Series with NFC (Enterprise Profile)
  "6ab56fad-881f-4a43-acb2-0be065924522", // YubiKey 5 Series with NFC (Enterprise Profile)
  "662ef48a-95e2-4aaa-a6c1-5b9c40375824", // YubiKey 5 Series with NFC - Enhanced PIN
  "b2c1a50b-dad8-4dc7-ba4d-0ce9597904bc", // YubiKey 5 Series with NFC - Enhanced PIN (Enterprise Profile)
  "0ebd9f2c-f685-441c-8c3e-a02a234a840a", // YubiKey 5 Series with NFC Enhanced PIN (Consumer Profile)
  "9a3f2abd-a73d-439c-9ee7-1b53a857eaa7", // YubiKey 5 Series with NFC Enhanced PIN (Enterprise Profile)
  "9eb7eabc-9db5-49a1-b6c3-555a802093f4", // YubiKey 5 Series with NFC KVZR57
  "34f5766d-1536-4a24-9033-0e294e510fb0", // YubiKey 5 Series with NFC Preview
  "9dd8d593-2213-438a-97f8-d6b813d51c27", // YubiKey Bio Fido Edition (Consumer Profile)
  "add92433-0d69-4026-8166-29b25bce64e9", // YubiKey Bio Fido Edition (Enterprise Profile)
  "ba0a9266-40d8-4048-9786-d710b5474752", // YubiKey Bio Multi-protocol Edition (Consumer Profile)
  "9806a2c8-c0da-478e-b4ca-620005d34182", // YubiKey Bio Multi-protocol Edition (Consumer Profile) 1VDJSN-2
  "dc5e949d-f939-43b3-9877-a85c7186b753", // YubiKey Bio Multi-protocol Edition (Enterprise Profile)
  "7409272d-1ff9-4e10-9fc9-ac0019c124fd", // YubiKey Bio Series - FIDO Edition
  "d8522d9f-575b-4866-88a9-ba99fa02f35b", // YubiKey Bio Series - FIDO Edition
  "dd86a2da-86a0-4cbe-b462-4bd31f57bc6f", // YubiKey Bio Series - FIDO Edition
  "83c47309-aabb-4108-8470-8be838b573cb", // YubiKey Bio Series - FIDO Edition (Enterprise Profile)
  "8c39ee86-7f9a-4a95-9ba3-f6b097e5c2ee", // YubiKey Bio Series - FIDO Edition (Enterprise Profile)
  "ad08c78a-4e41-49b9-86a2-ac15b06899e2", // YubiKey Bio Series - FIDO Edition (Enterprise Profile)
  "34744913-4f57-4e6e-a527-e9ec3c4b94e6", // YubiKey Bio Series - Multi-protocol Edition
  "7d1351a6-e097-4852-b8bf-c9ac5c9ce4a3", // YubiKey Bio Series - Multi-protocol Edition
  "90636e1f-ef82-43bf-bdcf-5255f139d12f", // YubiKey Bio Series - Multi-protocol Edition
  "6ec5cff2-a0f9-4169-945b-f33b563f7b99", // YubiKey Bio Series - Multi-protocol Edition (Enterprise Profile)
  "97e6a830-c952-4740-95fc-7c78dc97ce47", // YubiKey Bio Series - Multi-protocol Edition (Enterprise Profile)
  "58276709-bb4b-4bb3-baf1-60eea99282a7", // YubiKey Bio Series - Multi-protocol Edition 1VDJSN
]

/** The security keys the wallet accepts: the Yubico family (FIDO MDS). */
export const SECURITY_KEY_AAGUIDS: ReadonlySet<string> = new Set([
  YUBIKEY_5_SERIES_NFC_AAGUID,
  YUBIKEY_5_USB_A_AAGUID,
  YUBIKEY_5_USB_C_AAGUID,
  YUBIKEY_5_NFC_AAGUID,
  YUBIKEY_5_SERIES_AAGUID,
  ...YUBICO_AAGUIDS,
])

// ── Field moduli ─────────────────────────────────────────────────────

/** BN254 (alt_bn128) scalar field order: the modulus every wallet master key reduces into. */
export const BN254_FR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n

// ── Account wire contracts ───────────────────────────────────────────

/**
 * Label the secp256k1 bootstrap EOA is derived from the master secret under. The L1 account is
 * CREATE2-predicted from that EOA and the claim server keys reservations by it, so a different
 * label silently derives a different account for the same passkey.
 */
export const OXIDE_L1_BOOTSTRAP_KEY_LABEL = "oxide:l1-bootstrap"

/**
 * Label the self-SIPA key is derived from the master secret under. The salts of the wallet's own
 * SIPAs hash from that key, so a different label derives different deposit addresses for the same
 * passkey.
 */
export const OXIDE_SELF_SIPA_KEY_LABEL = "oxide:self-sipa"

/**
 * Label the account's Aztec secret key is derived from the master secret under. The suffix counts
 * rotations of this derivation, not releases (see docs/account/README.md, "Key and address
 * derivation"); a different label silently derives a different account for the same passkey.
 */
export const ACCOUNT_SECRET_KEY_LABEL = "obsidion.wallet.account.secret.v1"

/** Header carrying the bootstrap key's request-auth signature for the claim server's `/domain/sign`. */
export const BOOTSTRAP_SIGNATURE_HEADER = "x-obsidion-bootstrap-signature"

/**
 * Headers a trusted server-side caller uses to name the viewer it acts for, so the claim server's
 * rate limiter budgets per viewer rather than per proxy.
 */
export const VIEWER_IP_HEADER = "x-obsidion-viewer-ip"
export const PROXY_TOKEN_HEADER = "x-obsidion-proxy-token"

/**
 * Prefix of the timestamped preimage the wallet personal-signs to prove bootstrap-key possession to
 * the campaign's admission check.
 */
export const CAMPAIGN_ADMISSION_PREIMAGE_PREFIX = "OBSIDION_CAMPAIGN_AUTH_V1:ADMISSION:"

/**
 * Prefix of the timestamped preimage the wallet personal-signs to tell the campaign a reserved tag
 * was claimed (the reminder-email stop signal).
 */
export const CAMPAIGN_TAG_CLAIMED_PREIMAGE_PREFIX = "OBSIDION_CAMPAIGN_AUTH_V1:TAG_CLAIMED:"

/** The bytes the wallet signs and the campaign's `POST /api/registration/claimed` verifies. */
export function campaignTagClaimedPreimage(
  address: string,
  handle: string,
  timestamp: number,
): string {
  return `${CAMPAIGN_TAG_CLAIMED_PREIMAGE_PREFIX}${address.toLowerCase()}:${handle.toLowerCase()}:${timestamp}`
}

// ── Cross-cutting transaction/UI enums ───────────────────────────────

export enum TokenActionEnum {
  SEND = "send",
  RECEIVE = "receive",
}

// PaylinkActionEnum (formerly EmailPaymentActionEnum) — stored string values
// kept unchanged for back-compat with persisted activity rows. The literal
// "Pay To Email" / "Claim With Email" predate the addition of direct paylinks;
// new direct paylinks use the same PAY value plus a flavor: "direct"
// discriminator on the row.
export enum PaylinkActionEnum {
  PAY = "Pay To Email",
  CLAIM = "Claim With Email",
  CLAIM_BACK = "Claim Back",
  REFUNDED = "Refunded",
  CLAIMED = "Claimed",
}

export enum TransactionStatusEnum {
  PENDING = "pending",
  SUCCESS = "success",
  FAILED = "failed",
}

export enum QueueStatus {
  PENDING = "pending",
  INITIALIZING = "initializing",
  SIGNING = "signing",
  PROVING = "proving",
  SIMULATING = "simulating",
  PROVING_AND_SENDING = "proving and sending",
  CONSTRUCTING = "constructing",
  CHECKING = "checking",
  MINING = "mining",
  SENDING = "sending",
  SUCCESS = "success",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum TransactionProgress {
  PENDING = 0,
  INITIALIZING = 10,
  SIGNING = 15,
  SIMULATING = 20,
  CONSTRUCTING = 30,
  PROVING_AND_SENDING = 40,
  MINING = 80,
  SUCCESS = 100,
  FAILED = 100,
}

export enum OtherActionEnum {
  FAUCET = "faucet",
  CONTRACT_CALL = "contract_call",
}

export enum Visibility {
  PUBLIC = "public",
  PRIVATE = "private",
}

// ── Numeric constants ────────────────────────────────────────────────

export const TESTNET_TIMEOUT = 300000
export const FEE_MULTIPLIER = 2
export const DEFAULT_DECIMALS = 18
/** Unix-time day length. Paylink claim windows and the circuit `day` are both this unit. */
export const SECONDS_IN_A_DAY = 86400n

/**
 * Seconds after deposit before a paylink becomes claimable. Create sites pass
 * `chainNow + PAYLINK_GRACE_PERIOD_SECONDS` as `from_claimable`. `0` = claimable immediately. The
 * creator's refund window is independent of this and opens at creation.
 */
export const PAYLINK_GRACE_PERIOD_SECONDS = 100n

/**
 * Seconds before `refundable_until` at which the wallet stops offering Cancel. The refund tx expires
 * at `refundable_until`, so a cancel proven late is refused at send or never included. Roughly one
 * web proof plus one slot; tune against measured prove time.
 */
export const PAYLINK_CANCEL_MARGIN_SECONDS = 30n

/**
 * Length of the `meta` passthrough on the oxide token's `transfer` (aztec-nr's
 * `MAX_EVENT_SERIALIZED_LEN - 3`, mirrored by `TestToken` so both tokens share one selector). The
 * wallet fills it with a versioned TLV byte stream (sdk `transferMeta.ts`); other sends are all-zero. The
 * sdk's `transferMetaLen` test asserts this against the built artifact — a drift means an SDK bump moved
 * the event capacity and the tokens must be recompiled.
 */
export const TRANSFER_META_LEN = 7

/**
 * Longest claimable tag. Load-bearing in two places that must agree: front-core's `validateTag`
 * decides whether a tag can be claimed at all, and the sdk's `Transfer.meta` encoder sizes the tag
 * lane and the memo budget around it. If they ever drifted apart, a legitimately claimed tag would
 * be silently dropped from the wire.
 *
 * X caps handles at 15 chars; the headroom is for tags claimed off the X rail.
 */
export const MAX_TAG_LENGTH = 32

/** The all-zero `meta` argument. A fresh array per call, since the ABI encoder takes a mutable one. */
export const emptyTransferMeta = (): number[] => new Array<number>(TRANSFER_META_LEN).fill(0)

/**
 * Pending-record TTL ceiling. A record is expired once `Date.now()` is past
 * `min(record.expiresAtMs, record.submittedAt + MAX_TX_LIFETIME_MS) + CLOCK_SKEW_MARGIN_MS`.
 * The 24h ceiling matches the kernel's `MAX_TX_LIFETIME` and holds regardless of `expiresAtMs`, so a
 * pathologically large kernel expiry cannot pin a record. The skew margin sits on the read side so a
 * record dipping briefly past expiry is not yanked from a coordinator that just observed it live. Every
 * `IPendingTxStore` uses this one formula.
 */
export const MAX_TX_LIFETIME_MS = 86_400 * 1000
export const CLOCK_SKEW_MARGIN_MS = 30_000

/** ClaimFPC fee juice per network (wei). The deploy bridges `initial` into a ClaimFPC below
 * `refuelBelow`; after that, wallets top it up with a skim `refuel` tx whenever it is below
 * `refuelBelow`. Testnet's is small so the refuel race runs on staging; sandbox has no skim pool, so
 * its e2e suites spend the initial balance. */
export const CLAIM_FPC_FUNDING: Record<Network, { initial: bigint; refuelBelow: bigint }> = {
  [Network.SANDBOX]: { initial: 1000n * 10n ** 18n, refuelBelow: 100n * 10n ** 18n },
  [Network.TESTNET]: { initial: 100n * 10n ** 18n, refuelBelow: 100n * 10n ** 18n },
  [Network.MAINNET]: { initial: 5000n * 10n ** 18n, refuelBelow: 1500n * 10n ** 18n },
}

/** Fixed sandbox configure-password (sandbox chains are disposable). Other tiers keep theirs secret. */
export const SANDBOX_CLAIM_FPC_PASSWORD = "sandbox-claim-fpc-password-4"

/** Fixed sandbox PasswordFPC password, so the self-funded bootstrap can be exercised on a sandbox
 * chain without an operator secret. Same disposable-chain reasoning as the ClaimFPC one above. */
export const SANDBOX_FPC_PASSWORD = "sandbox-password-fpc-pw"

/**
 * ClaimFPC flat per-batch gas caps, per dimension — the budget an OPEN sponsorship policy runs on.
 * The deploy prices them (at its fee-per-gas knob) into the `ByAny` policy entry's per-batch
 * `max_fee`, and a sponsored tx under such a policy declares exactly these as its gas limits — the
 * circuit bounds declared gas x declared fee-per-gas against that budget, so the two sides must
 * share one number. (A per-call policy budgets each committed call instead, and its clients declare
 * the per-call inventory: sdk `claimFpcBatchGas.ts`.)
 *
 * Sized to the largest measured shape (a golden-ticket claim with a burn carrying a two-operation
 * registration broadcast, l2 ~2.40M) and the largest per-call inventory sum (paylink deposit plus
 * gift, da ~14.3k), so a per-call policy can replace the open one without moving them. `claimFpcGasInventory.test.ts`
 * asserts they dominate every measured shape and every per-call inventory sum, so a
 * re-measurement that outgrows them fails there instead of in a sponsored send. Worst case per
 * sponsored tx is caps x the config's fee-per-gas ceilings.
 */
export const CLAIM_FPC_MAX_BATCH_DA_GAS = 16_000
export const CLAIM_FPC_MAX_BATCH_L2_GAS = 2_450_000
/** The fee-per-gas the deployed ClaimFPC sponsors at, in both dimensions. Above it every sponsored tx
 * fails the FPC's fee cap. */
export const CLAIM_FPC_MAX_FEE_PER_GAS = 10n ** 13n

// Every network runs an 18-dec stablecoin (a mintable mock on sandbox/testnet, DAI on
// mainnet). The resolver + fail-loud guard are retained so a future token with
// different decimals is a single-entry change. Nothing here reads env or ambient
// network, so this stays outside the eager-evaluation ordering contract for the
// URL block below.
export const TOKEN_DECIMALS_BY_NETWORK: Record<Network, number> = {
  [Network.SANDBOX]: 18,
  [Network.TESTNET]: 18,
  [Network.MAINNET]: 18,
}

export function tokenDecimalsForNetwork(network: Network): number {
  const decimals = TOKEN_DECIMALS_BY_NETWORK[network]
  // Guard the `NETWORK as Network` casts at the call sites: an unrecognized env value would
  // otherwise return undefined and mis-scale every amount as NaN deep in the math. Fail loud instead.
  if (decimals === undefined) throw new Error(`tokenDecimalsForNetwork: unknown network ${network}`)
  return decimals
}

/** Display symbol for the wallet's single asset. Never a `ContractName` — that is `oxideToken`. */
export const WALLET_TOKEN_SYMBOL = "DAI"

/** What the UI calls the wallet balance; the asset itself stays `WALLET_TOKEN_SYMBOL`. */
export const WALLET_DISPLAY_CURRENCY = "USD"

/**
 * The published per-operation limit, in whole US dollars. A deposit counts the value sent and a
 * withdrawal the amount taken from the balance, fees included in both. It is product policy, kept
 * apart from each portal's `TX_AMOUNT_CAP()`, which caps settlement-token units and sits above it.
 */
export const PUBLIC_TX_LIMIT_USD = 5_000

/**
 * What every withdrawal offers the relayer that settles it on L1, in the 18-dec token above.
 *
 * It rides the withdrawal's user payload. The portal takes the prover tip, then the plain
 * withdrawal executor pays this tip out of the rest, so the recipient lands `amount - tips`. A tip
 * above what reaches the executor makes the L1 release revert, so the wallet checks it before the
 * burn. Flat rather than proportional at oxide's request.
 */
export const WITHDRAW_RELAYER_TIP = 100_000_000_000_000_000n

/**
 * The gas price a withdrawal's prover tip is quoted at, as a share of the price read now, in basis
 * points: 1.5x. The prover decides minutes after the burn, and gas can rise in between.
 */
export const PROVER_TIP_GAS_PRICE_BUFFER_BPS = 15_000n

/** "GOLD": separator for the golden ticket nullifier, so it never matches a note's own nullifier. */
export const DOM_SEP__GOLDEN_TICKET = 0x474f4c44

/**
 * Dust a golden-ticket SIPA burn keeps above the signed floor, the relayer tip and the prover tip.
 * The SIPA sweeps only above the fee, so this is the slice that actually bridges back to the
 * recipient.
 */
export const GOLDEN_TICKET_BRIDGE_REMAINDER = 10n ** 16n

/** UltraHonk verification key of `circuits/golden_ticket`, pinned so the account-service verifies without the circuit. */
// GOLDEN_TICKET_VK_BASE64_START
export const GOLDEN_TICKET_VK_BASE64 =
  "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"
// GOLDEN_TICKET_VK_BASE64_END

/** The message a past zk.money user signs; `circuits/eligibility` pins its EIP-191 digest. */
export const ELIGIBILITY_SIGN_MESSAGE =
  "Verify address ownership for the new zk.money. This does not authorise access to any funds."

/** UltraHonk verification key of `circuits/eligibility`, pinned so the account-service verifies without the circuit. */
// ELIGIBILITY_VK_BASE64_START
export const ELIGIBILITY_VK_BASE64 =
  "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"
// ELIGIBILITY_VK_BASE64_END

/** Root of the past-user tree, cut from `zkmoney-addresses.txt`; the campaign's committed anchor. */
export const ELIGIBILITY_ROOT = "0x1593dd7edddda73cac8f9442017e6ad99bccca8bd1f662f0c8f0da7df01845f0"

// ── Registration by deposit ──────────────────────────────────────────

// ./registration.ts prices a registration: the schedule the chain enforces, the deposit each kind
// is asked for, and the floor rule relating them. Every consumer reads it from there.
export * from "./registration.js"

/**
 * The fee beneficiary (FPC funder) the client selects by default, an index into the Registry's
 * add-only `beneficiaries` allowlist. Id 0 is the domain owner seeded at construction; id 1 is the
 * first real funder the operator adds via `addBeneficiary`. Committed into the SIPA address and the
 * consent signature, so it cannot be swapped by a relayer. Overridable per deployment.
 */
export const SANDBOX_REGISTRATION_BENEFICIARY_ID = 1n

/** The L1 assets a swap-on-withdraw can deliver in place of DAI. */
export const SWAP_ON_WITHDRAW_OUTPUTS = ["USDC", "USDT", "ETH"] as const

/**
 * A relayer tip committed before its L1 operation is broadcast, as a share of the relayer's `minPayout` for
 * the operation now, in basis points. The relayer prices the operation later,
 * when gas may be higher; a tip that does not clear its floor then is deferred, not lost.
 */
export const L1_OPERATION_TIP_MARGIN_BPS = 11_000n

/** A frozen refund's proof commits its tip long before the send, so gas has longer to rise. */
export const FROZEN_REFUND_TIP_MARGIN_BPS = 15_000n

// ── Local config ─────────────────────────────────────────────────────

// Declared here (not in ./types) so the defaults object and the shape stay one
// declaration; ./types re-exports the type, mirroring the Network enum pattern.
export interface LocalConfig {
  devMode: boolean
  /** Opt-in analytics: false (the default) sends nothing. */
  analyticsConsent: boolean
  /** Whether the consent prompt has been answered — a decline is a persisted `false` consent. */
  analyticsAsked: boolean
  /** Off: payment requests from people outside the contact book are dropped on receive and hidden. */
  allowNonContactRequests: boolean
}

export const LOCAL_CONFIG_DEFAULTS: LocalConfig = {
  devMode: false,
  analyticsConsent: false,
  analyticsAsked: false,
  allowNonContactRequests: true,
}

/** Every setting persists under its own storage key: `obsidion_config:<key>`. */
export const CONFIG_STORAGE_KEY_PREFIX = "obsidion_config:"

// ── Chain ────────────────────────────────────────────────────────────

export const L1_CHAIN_ID = {
  LOCAL: 31337,
  SEPOLIA: 11155111,
  MAINNET: 1,
}

/** Network → L1 chain id. The only per-network PXE/L1 axis. */
export const L1_CHAIN_ID_BY_NETWORK: Record<Network, number> = {
  [Network.SANDBOX]: L1_CHAIN_ID.LOCAL,
  [Network.TESTNET]: L1_CHAIN_ID.SEPOLIA,
  [Network.MAINNET]: L1_CHAIN_ID.MAINNET,
}

export function l1ChainIdForNetwork(network: Network): number {
  const id = L1_CHAIN_ID_BY_NETWORK[network]
  if (id === undefined) throw new Error(`l1ChainIdForNetwork: unknown network ${network}`)
  return id
}

/**
 * Prefix of the bootstrap key's L2 binding message,
 * keccak(L2_BINDING_MESSAGE_PREFIX || l2_address_be32). Must match ClaimFPC's
 * in-circuit BINDING_PREFIX (claim_fpc/src/eligibility.nr).
 */
export const L2_BINDING_MESSAGE_PREFIX = "OBSIDION_L2_BINDING_V1"

// Keyless public endpoints, used only as the last-resort default when no build supplies its own
// (VITE_L1_RPC_URL). They are rate-limited — a deployment that reads L1 in
// anger points at a keyed provider.
export const L1_RPC_URL = {
  LOCAL: "http://localhost:8545",
  SEPOLIA: "https://ethereum-sepolia-rpc.publicnode.com",
  MAINNET: "https://ethereum-rpc.publicnode.com",
}

// ── URLs ─────────────────────────────────────────────────────────────
// Preserve eager `process.env || fallback` evaluation timing so consumers
// that write to process.env at module-load time keep working. Do not memoize; do not lazy-getter; do not consolidate.
//
// The `typeof process` guard makes pure-enum imports (Visibility,
// TransactionStatusEnum, etc.) safe in browser/worker contexts that lack a
// `process` polyfill — without it, importing any symbol from this module
// would throw `ReferenceError: process is not defined` at module evaluation.
// `_env(name)` returns undefined when no process global exists, which falls
// through to the literal fallback exactly as the old code path did on Node.
const _env = (name: string): string | undefined =>
  typeof process !== "undefined" ? process.env[name] : undefined

// TODO: unify these per-network node URLs.
export const TESTNET_NODE_URL = "https://testnet-v5-archive.rpc2.aztec-labs.com"

export const AZTEC_NODE_URL = _env("AZTEC_NODE_URL") || "http://localhost:8080"

// Auth header an API-gateway-fronted node requires. AWS API Gateway keys off `x-api-key`; any
// other header name comes back `403 {"message":"Forbidden"}`, indistinguishable from sending no
// key at all. Applied by `createNode` in @obsidion/sdk.
export const AZTEC_API_KEY_HEADER = "x-api-key"

// Key for a node behind an API gateway (the gateway 403s unauthenticated calls). Node-side
// consumers -- backend services, deploy scripts, tests -- read it from the environment; the
// browser build bakes its own build-time value instead. Unset means the target
// node is open, which is what sandbox is.
export const AZTEC_NODE_API_KEY = _env("AZTEC_NODE_API_KEY") || undefined

// ── Oxide env-registry ───────────────────────────────────────────────

// Mainnet a1 values the app supplies itself — the prod.v4.json entry leaves them zero/empty by
// design. entryPoint is the canonical ERC-4337 v0.8 singleton (same address on
// every chain); ensDomain is the naming domain the wallet composes tags under.
// Deployment-invariant, so safe to pin here; the tradeoff is one-way — a change
// only ships via an app release, not a manifest rotation.
export const MAINNET_ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"
export const MAINNET_ENS_DOMAIN = "zk.money"

// ── Service ports ────────────────────────────────────────────────────
// Default ports for backend services. Each service composes
// `process.env.PORT || SERVICE_PORTS.<service>` at use site; the env
// override stays authoritative. `as const` gives consumers literal
// types (e.g. `8060` not `number`).
//
// accountService avoids 5060/5061 (SIP): those are on the WHATWG "bad ports"
// blocklist, so browsers AND undici `fetch` refuse them outright.

export const SERVICE_PORTS = {
  accountService: 8060,
  zkmoneyApi: 5070,
  configService: 8083,
} as const

// ── BEGIN AUTO-GEN: zkjwt vkey hash ──
// AUTO-GENERATED by packages/contracts/scripts/paylinkCodegen.ts (refreshZkJwtVkeyHash). The zkJWT
// circuit's verifying-key hash: plain Poseidon2 of the `bb write_vk` fields. PaylinkEmail
// .deposit binds it per paylink; the SDK reads it to supply the deposit
// `vkey_hash` arg. Kept in lockstep with circuits/zkJWT/target/vk/vk by Check D in
// packages/contracts/scripts/check-paylink-freshness.ts. Do NOT edit by hand.
export const ZKJWT_VKEY_HASH = "0x22b90b825bbda7021efbbd846741127975d7d92fcaff6dd90d251fb66c59b905"
// The vk itself (base64 of the committed circuits/zkJWT/target/vk/vk bytes): the [Field; 115]
// PaylinkEmail.claim takes; hashing it must reproduce ZKJWT_VKEY_HASH (sdk getZkJwtVkey asserts).
// prettier-ignore
export const ZKJWT_VK_BASE64 = "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"
// ── END AUTO-GEN: zkjwt vkey hash ──

/** UltraHonk vk field count for the zkJWT circuit (`bb write_vk` output). */
export const VKEY_FIELD_COUNT = 115
/** UltraHonk proof field count for the zkJWT circuit. */
export const PROOF_FIELD_COUNT = 458
/** Public input count emitted by the zkJWT circuit. */
export const ZKJWT_PUBLIC_INPUT_COUNT = 7

// ── Test fixtures ────────────────────────────────────────────────────
// Industry-standard Anvil/Hardhat dev seed. Used by both backend
// (deploy) and wallet (front-core, sdk fixtures) streams as the
// canonical test mnemonic. Centralizing eliminates 9 duplicate copies.

export const ANVIL_TEST_MNEMONIC = "test test test test test test test test test test test junk"

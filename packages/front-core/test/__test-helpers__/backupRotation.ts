import {
  fundingLocalId,
  type BackupFunding,
  type BackupRotationRecord,
  type BackupRotationStored,
} from "../../src/core/storages/BackupRotationStore"

export const OWNER = "0xAbCdEf0000000000000000000000000000001234"
export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
export const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`
export const SIPA = addr(20)
export const TWO_KEY = word(0x2b)

export const storedRotation = (over: Partial<BackupRotationStored> = {}): BackupRotationStored => ({
  owner: addr(1),
  intent: {
    rollupVersion: "6",
    precondition: { target: addr(2), data: "0x1234", resultHash: word(3) },
    postcondition: { target: addr(2), data: "0x1234", resultHash: word(4) },
    recipientCommitment: word(5),
    owner: addr(1),
    nonce: "7",
    callData: "0xabcd",
    accountGasLimits: word(8),
  },
  sharedSecretSalt: word(9),
  nonce: "7",
  builtOver: {
    l2Address: word(10),
    rollupVersion: "6",
    publicKey: { x: "11", y: "12" },
    resolverOperator: addr(13),
  },
  expectedKeys: [{ key: { qx: word(14), qy: word(15) }, metadata: "0x" }],
  implementation: addr(16),
  deployArgs: {
    implementation: addr(16),
    intentHash: word(17),
    recoveryCommitment: word(18),
    rollupVersion: "6",
    resweepable: false,
    forwardingTable: addr(19),
  },
  sipa: SIPA,
  add: { pubkey: { qx: word(21), qy: word(22) }, credentialId: "0x2324", envelope: "0x25" },
  signature: "0x26",
  ...over,
})

export const funding = (over: Partial<BackupFunding> = {}): BackupFunding => ({
  attemptId: "attempt-1",
  localId: fundingLocalId("attempt-1"),
  sentAt: 5,
  session: "life-1",
  txHash: word(30),
  expiresAtMs: 99,
  outcome: "pending",
  ...over,
})

export const PLAN = {
  address: TWO_KEY,
  fundingAmount: "2000",
  credited: "1400",
  approvals: 1,
  moves: 2,
}

/** A `created` record, with a signed rotation and plan added by the overrides when a later phase needs them. */
export const rotationRecord = (over: Partial<BackupRotationRecord> = {}): BackupRotationRecord => ({
  owner: OWNER,
  attemptId: "attempt-1",
  phase: "created",
  backup: {
    credentialId: "backup-credential",
    pubkeyHex: "ab".repeat(64),
    envelopeHex: "01".repeat(62),
    userHandle: "YnJhdmUtb3R0ZXI",
    prfSlot: "first",
    securityKey: false,
  },
  fundings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

/** A record at `phase` with everything a signed record carries. */
export const signedRecord = (
  phase: BackupRotationRecord["phase"],
  over: Partial<BackupRotationRecord> = {},
): BackupRotationRecord =>
  rotationRecord({ phase, plan: PLAN, rotation: storedRotation(), fromBlock: 50, ...over })

import { describe, it, expect, beforeEach, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"

// ---------------------------------------------------------------------------
// The no-backup warning gate is the single fund-safety seam
// between a declined warning and an irreversible on-chain deploy + committed
// MSK. This test pins the ordering invariant: a security-key create must await
// the acknowledgement, and a DECLINE must abort BEFORE createObsidionAccount /
// recordRecoveryMetadata / commitSecret / storeAccount run.
// ---------------------------------------------------------------------------

const order: string[] = []

const obsidionAccountStub = {
  getAddress: () => ({ toString: () => "0xacct" }),
  getCompleteAddress: () => ({ toString: () => "0xcomplete" }),
} as never

const createObsidionAccountMock = vi.fn(async () => {
  order.push("createObsidionAccount")
  return obsidionAccountStub
})
const obsidionWalletStub = {
  createObsidionAccount: createObsidionAccountMock,
  getObsidionAccountWallet: vi.fn(),
  deriveAccountAddress: vi.fn(),
}

vi.mock("src/contexts", () => ({
  useAztecContext: () => ({ obsidionWallet: obsidionWalletStub }),
}))

const addWebauthnAccountMock = vi.fn(async () => undefined)
const hasAccountMock = vi.fn(async () => false)
const isProdMock = vi.fn(async () => false)
vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    AccountStorage: {
      get: () => ({ addWebauthnAccount: addWebauthnAccountMock, hasAccount: hasAccountMock }),
    },
    NetworkStorage: { get: () => ({ isProd: isProdMock }) },
  }
})

import { useAccount } from "src/hooks/useAccount"
import { AUTH_TYPE } from "@obsidion/sdk"

const recordRecoveryMetadataMock = vi.fn(async () => undefined)
const commitSecretMock = vi.fn(async () => undefined)

function makeAuthService(authenticatorType: "platform" | "security-key") {
  return {
    createPasskey: vi.fn(async () => ({
      authProvider: {},
      credentialId: "cred-1",
      pubkey: "aa".repeat(64),
      secretKey: { toBuffer: () => Buffer.alloc(32) },
      prfSlot: "first",
      prfAaguid: "00000000-0000-0000-0000-000000000000",
      authenticatorType,
    })),
    recordRecoveryMetadata: recordRecoveryMetadataMock,
    commitSecret: commitSecretMock,
  } as never
}

function renderCreate(authService: never) {
  return renderHook(() => useAccount(() => ({ showUnlockModal: false, authService })))
}

describe("useAccount — no-backup warning gate", () => {
  beforeEach(() => {
    order.length = 0
    createObsidionAccountMock.mockClear()
    recordRecoveryMetadataMock.mockClear()
    commitSecretMock.mockClear()
    addWebauthnAccountMock.mockClear()
  })

  it("DECLINE: aborts with zero on-chain/committed state (no deploy, record, commit, or storeAccount)", async () => {
    const { result } = renderCreate(makeAuthService("security-key"))

    await act(async () => {
      await expect(
        result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
          mode: "combined",
          onSecurityKeyDetected: async () => false,
        }),
      ).rejects.toMatchObject({ name: "SecurityKeyWarningDeclined" })
    })

    expect(createObsidionAccountMock).not.toHaveBeenCalled()
    expect(recordRecoveryMetadataMock).not.toHaveBeenCalled()
    expect(commitSecretMock).not.toHaveBeenCalled()
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })

  it("ACCEPT: the warning is acknowledged STRICTLY BEFORE the on-chain deploy, then the flow commits", async () => {
    const { result } = renderCreate(makeAuthService("security-key"))
    const onSecurityKeyDetected = vi.fn(async () => {
      order.push("ack")
      return true
    })

    await act(async () => {
      await result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
        mode: "combined",
        onSecurityKeyDetected,
      })
    })

    expect(onSecurityKeyDetected).toHaveBeenCalledTimes(1)
    // The gate strictly precedes the irreversible deploy.
    expect(order).toEqual(["ack", "createObsidionAccount"])
    expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
    expect(commitSecretMock).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccountMock).toHaveBeenCalledTimes(1)
  })

  it("PLATFORM: a platform-class create never invokes the warning gate", async () => {
    const { result } = renderCreate(makeAuthService("platform"))
    const onSecurityKeyDetected = vi.fn(async () => true)

    await act(async () => {
      await result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "@x", undefined, {
        mode: "platform",
        onSecurityKeyDetected,
      })
    })

    expect(onSecurityKeyDetected).not.toHaveBeenCalled()
    expect(createObsidionAccountMock).toHaveBeenCalledTimes(1)
  })
})

describe("useAccount — caller recovery checkpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("saves the credential and account before committing the session", async () => {
    const { result } = renderCreate(makeAuthService("platform"))
    let saved = false
    commitSecretMock.mockImplementationOnce(async () => {
      expect(saved).toBe(true)
    })
    const checkpoint = vi.fn(async (account) => {
      expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
      expect(commitSecretMock).not.toHaveBeenCalled()
      expect(addWebauthnAccountMock).not.toHaveBeenCalled()
      expect(account).toEqual({ credentialId: "cred-1", l2Address: "0xacct" })
      saved = true
    })
    await act(async () => {
      await result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
        onAccountCreated: checkpoint,
      })
    })
    expect(checkpoint).toHaveBeenCalledTimes(1)
    expect(addWebauthnAccountMock).toHaveBeenCalledTimes(1)
  })

  it("a failed checkpoint prevents session commit and account persistence", async () => {
    const { result } = renderCreate(makeAuthService("platform"))
    await act(async () => {
      await expect(
        result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
          onAccountCreated: () => {
            throw new Error("storage refused")
          },
        }),
      ).rejects.toThrow("storage refused")
    })
    expect(recordRecoveryMetadataMock).toHaveBeenCalledTimes(1)
    expect(commitSecretMock).not.toHaveBeenCalled()
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })

  it("preserves the checkpoint when the later session commit fails", async () => {
    const { result } = renderCreate(makeAuthService("platform"))
    const checkpoint = vi.fn()
    commitSecretMock.mockRejectedValueOnce(new Error("commit refused"))
    await act(async () => {
      await expect(
        result.current.createAccount(false, AUTH_TYPE.WEB_AUTHN, () => {}, "alice", undefined, {
          onAccountCreated: checkpoint,
        }),
      ).rejects.toThrow("commit refused")
    })
    expect(checkpoint).toHaveBeenCalledWith({ credentialId: "cred-1", l2Address: "0xacct" })
    expect(addWebauthnAccountMock).not.toHaveBeenCalled()
  })
})

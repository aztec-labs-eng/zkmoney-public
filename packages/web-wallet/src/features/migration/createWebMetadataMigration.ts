import {
  createMetadataMigrationSession,
  pubkeyToR1KeyArg,
  UpgradeActivity,
} from "@obsidion/front-core"
import {
  createLocalMetadataMigrationSource,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { getActiveStorageId } from "../../platform/storage/activeStorage"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { SessionChangedError } from "../../platform/auth/sessionErrors"
import { collectOnboardingKeys } from "../onboarding/oxideOnboarding"
import { claimSponsorContext } from "../onboarding/claimSponsorship"
import { RAIL_REGISTERED } from "../onboarding/rails"
import { historicChain, historicTokenContext } from "./historicTokenContext"
import { sourceSweptDeposits } from "./sourceSipaSources"

export const webMetadataMigrationKey = (
  current: OxideEnvTuple,
  historic: OxideEnvTuple,
  account: ObsidionAccount,
) =>
  `metadata-migration/${current.portal.toLowerCase()}/${historic.portal.toLowerCase()}/${account.getAddress()}`

/** Browser signing and storage adapters around the shared durable migration session. */
export async function createWebMetadataMigration(params: {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  toTokenService: TokenService
  historic: OxideEnvTuple
  current: OxideEnvTuple
}) {
  const config = getConfig()
  const client = l1PublicClient(config)
  const keys = await collectOnboardingKeys(params.account)
  const storageId = getActiveStorageId()
  if (!storageId) throw new SessionChangedError()
  const checkSession = () => {
    if (getActiveStorageId() !== storageId) throw new SessionChangedError()
  }
  const key = webMetadataMigrationKey(params.current, params.historic, params.account)
  const hasSource = params.historic.portal.toLowerCase() !== params.current.portal.toLowerCase()
  const sourceChain = hasSource
    ? await historicChain(params.account, params.current, params.historic)
    : undefined
  const sourceContext = hasSource
    ? await historicTokenContext(
        sourceChain?.wallet ?? params.wallet,
        sourceChain?.account ?? params.account,
        params.historic,
      )
    : undefined
  const sourceToken = sourceContext?.tokenService
  return createMetadataMigrationSession({
    wallet: params.wallet,
    account: params.account,
    contracts: params.contractService,
    tokenService: params.toTokenService,
    current: params.current,
    network: config.network,
    client,
    secretKey: keys.secretKey,
    key,
    activity: UpgradeActivity.get(webStorage),
    storage: {
      getItem: async (key) => {
        checkSession()
        return webStorage.getItem(key)
      },
      setItem: async (key, value) => {
        checkSession()
        await webStorage.setItem(key, value)
      },
    },
    lock: (fn) =>
      navigator.locks.request(`${storageId}/${key}`, async () => {
        checkSession()
        return fn()
      }),
    passkey: {
      publicKey: pubkeyToR1KeyArg(keys.pubkeyHex),
      signChallenge: (digest, opts) => {
        checkSession()
        return getAuthService().signMetadataChallenge(digest, opts)
      },
    },
    source: async (context, batches, savedRefundSigner) => {
      if (!sourceToken)
        return {
          identity: "no-source-deployment",
          state: async () => "empty" as const,
          prepare: async () => {
            throw new Error("This upgrade requires external funding")
          },
          restore: async () => {
            throw new Error("This upgrade has no source refund")
          },
          fund: async () => {},
          recoverRemaining: async () => {},
          remainingComplete: async () => true,
        }
      return createLocalMetadataMigrationSource({
        ...context,
        client,
        wallet: params.wallet,
        teeSigner: sourceContext!.teeSigner,
        account: params.account,
        batches,
        wrapRefundSigner: savedRefundSigner,
        source: { tuple: params.historic, tokenService: sourceToken },
        sourceChain,
        depositDescriptors: async () =>
          (
            await sourceSweptDeposits({
              chain: sourceChain ?? { wallet: params.wallet, account: params.account },
              tuple: params.historic,
              current: params.current,
              publicClient: client,
              masterSecret: keys.secretKey,
              scanHead: await client.getBlockNumber({ cacheTime: 0 }),
            })
          ).descriptors,
        sourceSponsor: () =>
          claimSponsorContext(
            {
              wallet: params.wallet,
              account: params.account,
              contractService: params.contractService,
            },
            RAIL_REGISTERED,
            { tuple: params.historic },
          ),
      })
    },
  })
}

import { getWebBroadcasterArtifact, getWebOxideToken } from "../../config/classArtifacts"
/**
 * D3a: publish a registration SIPA to relayers (registration-fee.md §Relayers). It rides the
 * one-shot `registration-broadcast` rail, so the tx that subscribes against the NameClaim also pays
 * for itself and spends the rail's only use.
 *
 * The batch carries no account call and needs no signature: the account has no setup step, and
 * the subscribe leg's eligibility is the NameClaim.
 *
 * The plain-SIPA analogue is `sipaGateway.broadcastSipa`; registration rides the same `SIPA` event
 * and sweep broadcast — it is just one more intent (the registration record + its
 * consent/domain/waiver proofs) — and caches the fresh claim here so the subscribe leg can find it
 * (it can't be recovered from the `NameClaimed` log before registration).
 */
import type { Address } from "viem"
import { NO_FROM } from "@aztec/aztec.js/account"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { Fr } from "@aztec/aztec.js/fields"
import {
  assertSubsidySweepsSipa,
  buildClaimSponsorPayload,
  buildClaimSubscribePayload,
  buildSipaSweepBroadcasts,
  claimFpcSponsoredFee,
  encodeRegistrationProofs,
  encodeLegacyRegistrationProofs,
  BroadcasterContract,
  OxideSipaIntent,
  ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
} from "@obsidion/sdk"
import {
  canonicalGenerationStack,
  composeWireNameHash,
  NameClaimStore,
  type RegistrationBroadcaster,
  type RegistrationBroadcastPayload,
} from "@obsidion/front-core"

import { claimSponsorContext } from "./claimSponsorship"
import { RAIL_REGISTRATION_BROADCAST } from "./rails"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { readSipaDeployed } from "../deposit/sipaSweep"
import type { WebWalletConfig } from "../../config/env"

export interface WebRegistrationBroadcasterDeps {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contractService: ContractService
  config: WebWalletConfig
  /** The bare tag being registered — names the cached NameClaim so the subscribe leg resolves it. */
  handle: string
}

/**
 * A {@link RegistrationBroadcaster} bound to this session's wallet + account. Resolves with the tx
 * hash once the node took it; a throw is the ledger's to retry, so this never swallows failures.
 */
export function createWebRegistrationBroadcaster(
  deps: WebRegistrationBroadcasterDeps,
): RegistrationBroadcaster {
  const { wallet, account, contractService, config, handle } = deps
  return async (payload: RegistrationBroadcastPayload, attempt = {}) => {
    const tuple = await getOxideTuple(config)
    const address = account.getAddress()
    const deployed = await readSipaDeployed(l1PublicClient(config), payload.sipaAddress)
    if (!deployed && !("recoveryAddress" in payload.sipaArgs)) {
      await assertSubsidySweepsSipa(l1PublicClient(config), {
        depositSubsidy: requireTupleField(tuple, "depositSubsidy") as Address,
        portal: requireTupleField(tuple, "portal") as Address,
        sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
        intent: OxideSipaIntent.Registration,
        deployArgs: payload.sipaArgs,
        intentData: payload.registrationData,
        sipa: payload.sipaAddress,
      })
    }

    // Cache the fresh claim so `claimSponsorContext`'s subscribe leg finds it: the name is not yet
    // registered, so it cannot be recovered from the Registry's NameClaimed log.
    await NameClaimStore.get().put({
      address: address.toString(),
      handle,
      nameHash: composeWireNameHash(handle, requireTupleField(tuple, "ensDomain")),
      nonce: String(payload.domainAuth.nonce),
      deadline: String(payload.domainAuth.deadline),
      signature: payload.domainAuth.signature,
      // The signed terms ride the record so a later manual sweep prices the same floor.
      ...(payload.signedTerms.signature !== "0x"
        ? {
            terms: {
              fee: String(payload.signedTerms.fee),
              minDeposit: String(payload.signedTerms.minDeposit),
              nonce: String(payload.signedTerms.nonce),
              deadline: String(payload.signedTerms.deadline),
              signature: payload.signedTerms.signature,
            },
          }
        : {}),
    })

    const sponsor = await claimSponsorContext(
      { wallet, account, contractService },
      RAIL_REGISTRATION_BROADCAST,
    )
    const { fpcAddress, fpcArtifact, railId, policy, subscribe } = sponsor

    // The PXE only simulates calls into contracts it holds an instance + artifact for, and at
    // onboarding nothing else has registered the broadcaster yet (the deposit-discovery mount does,
    // but only once the wallet is open). Upserts, so a repeat is free.
    const broadcasterAddress = AztecAddress.fromStringUnsafe(
      requireTupleField(tuple, "l2Broadcaster"),
    )
    const artifact = await getWebBroadcasterArtifact(
      wallet,
      requireTupleField(tuple, "l2Broadcaster"),
    )
    const instance = await wallet.node.getContract(broadcasterAddress)
    if (!instance) throw new Error(`Broadcaster instance not found at ${broadcasterAddress}`)
    const pxe = wallet.pxe as never as {
      registerContractClass: (a: unknown) => Promise<unknown>
      registerContract: (c: unknown) => Promise<unknown>
    }
    if (canonicalGenerationStack() === "v4") {
      await pxe.registerContract({ instance, artifact })
    } else {
      await pxe.registerContractClass(artifact)
      await pxe.registerContract(instance)
    }
    const broadcaster = BroadcasterContract.at(broadcasterAddress, artifact, wallet as never)
    const token = await getWebOxideToken(
      wallet,
      contractService,
      requireTupleField(tuple, "l2Token"),
    )
    const interactions = buildSipaSweepBroadcasts(token, broadcaster, {
      recipient: AztecAddress.fromStringUnsafe(payload.recipient),
      sharedSecretSalt: Fr.fromString(payload.sharedSecretSalt),
      resweepable: payload.sipaArgs.resweepable,
      intentHash: payload.sipaArgs.intentHash,
      sipa: payload.sipaAddress,
      deployed,
      sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
      intent: OxideSipaIntent.Registration,
      deployArgs: payload.sipaArgs,
      intentData: payload.registrationData,
      proofs: ("recoveryAddress" in payload.sipaArgs
        ? encodeLegacyRegistrationProofs
        : encodeRegistrationProofs)({
        consentSig: payload.consentSig,
        bootstrap: payload.bootstrap,
        domainAuth: payload.domainAuth,
        signedTerms: payload.signedTerms,
        r1Install: payload.r1Install,
      }),
      operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
      depositSubsidy: requireTupleField(tuple, "depositSubsidy") as Address,
      chainId: BigInt(config.l1ChainId),
      // TODO(benesjan): the relayer copies this sweep for each other token it accepts.
      // https://linear.app/aztec-labs/issue/OX-1877/for-v6-handle-multi-token-balance-condition-l1-operations-properly
      tokens: [requireTupleField(tuple, "token") as Address],
    })
    const broadcastCalls = (await Promise.all(interactions.map((call) => call.request()))).flatMap(
      (payload) => payload.calls,
    )

    const common = {
      fpcAddress,
      fpcArtifact,
      railId,
      policy,
      user: address,
      innerCalls: broadcastCalls,
      classWitnesses: [],
    }
    const txPayload = subscribe
      ? await buildClaimSubscribePayload({ ...common, gate: subscribe.gate })
      : await buildClaimSponsorPayload(common)

    const { operationId, onTxHash } = attempt
    // NO_FROM: eligibility is the entrypoint's subscription, not a user signature over the
    // broadcast. The subscribe leg reads this account's notes, and the `SIPA` event is sent to it.
    // Resolves once mined, so the next scheduler step finds it included.
    const { receipt } = await wallet.sendTx(txPayload, {
      ...(operationId ? { operationId } : {}),
      ...(onTxHash ? { onTxHash } : {}),
      from: NO_FROM,
      sendMessagesAs: address,
      additionalScopes: [address],
      fee: claimFpcSponsoredFee(policy, common.innerCalls),
    })
    return receipt.txHash.toString()
  }
}

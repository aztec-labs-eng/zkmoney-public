import { ObsidionWallet, type ObsidionWalletOptions } from "./ObsidionWallet.js"
import { DEFAULT_CONTRACTS, ContractName } from "@obsidion/contracts"
import { getPXEConfig, type PXEConfig } from "@aztec/pxe/config"
import { createPXE as createPXELazy, PXE, PXECreationOptions } from "@aztec/pxe/client/lazy"
import { AztecNode } from "@aztec/aztec.js/node"

/**
 * Test wallet variant that uses the obsidionAccountAlphaTest contract
 * (ECDSA K256 signing instead of WebAuthn/passkeys).
 *
 * Use this for E2E testing where biometric prompts can't be automated.
 */
export class ObsidionAlphaTestWallet extends ObsidionWallet {
  protected getAccountContractName(): ContractName {
    return DEFAULT_CONTRACTS.obsidionAccountAlphaTest
  }

  static override async create(
    node: AztecNode,
    overridePXEConfig?: Partial<PXEConfig>,
    options: PXECreationOptions = { loggers: {} },
    walletOpts?: ObsidionWalletOptions,
  ): Promise<ObsidionAlphaTestWallet> {
    const pxeConfig = Object.assign(getPXEConfig(), {
      proverEnabled: overridePXEConfig?.proverEnabled ?? false,
      autoSync: overridePXEConfig?.autoSync ?? false,
      ...overridePXEConfig,
    })
    const l1Contracts = await node.getL1ContractAddresses()
    const rollupAddress = l1Contracts.rollupAddress
    pxeConfig.dataDirectory = `pxe-${rollupAddress}`

    const pxe = await createPXELazy(node, pxeConfig, options)
    return new ObsidionAlphaTestWallet(pxe, node, walletOpts)
  }

  static override async createWithPXE(
    pxe: PXE,
    node: AztecNode,
    walletOpts?: ObsidionWalletOptions,
  ): Promise<ObsidionAlphaTestWallet> {
    return new ObsidionAlphaTestWallet(pxe, node, walletOpts)
  }
}

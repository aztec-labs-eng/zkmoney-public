/**
 * The build path of `initializePXE` with a boot-verified `chainIdentity`: the wallet is built with
 * the pin and the active network id is the pinned rollup address, whatever the node reports.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import React from "react"
import { act, render, waitFor } from "@testing-library/react"
import { EthAddress } from "@aztec/foundation/eth-address"
import type { AztecNode } from "@aztec/aztec.js/node"

const { network } = vi.hoisted(() => ({
  network: {
    name: "testnet",
    displayName: "Testnet",
    description: "",
    id: "testnet",
    type: "testnet",
    nodeUrl: "http://node.invalid",
    l1RpcUrl: "http://l1.invalid",
    current: true,
  },
}))

vi.mock("src/core", async () => {
  const actual = await vi.importActual<typeof import("src/core")>("src/core")
  return {
    ...actual,
    NetworkStorage: { get: () => ({ getAllNetworkConfigs: async () => ({ testnet: network }) }) },
  }
})

import { ObsidionWallet } from "@obsidion/sdk"
import { AztecProvider, useAztecContext } from "../../src/contexts/useAztecContext"
import { getActiveNetworkId, setActiveNetworkId } from "../../src/core/activeNetworkId"

const PINNED_ROLLUP = "0x" + "ab".repeat(20)
const NODE_ROLLUP = "0x" + "ee".repeat(20)
const INBOX = "0x" + "cd".repeat(20)

const chainIdentity = {
  l1ChainId: 11155111,
  rollupVersion: "1821665230",
  rollupAddress: PINNED_ROLLUP,
  inboxAddress: INBOX,
}

function stubNode() {
  const getNodeInfo = vi.fn(async () => ({
    l1ChainId: 31337,
    rollupVersion: 4127419662,
    l1ContractAddresses: {
      rollupAddress: EthAddress.fromString(NODE_ROLLUP),
      inboxAddress: EthAddress.fromString(INBOX),
    },
  }))
  return { node: { getNodeInfo } as unknown as AztecNode, getNodeInfo }
}

/** `ObsidionWallet.create` without a PXE: the real class over a stub, so `getNodeIdentity` is the real one. */
function stubCreate() {
  return vi
    .spyOn(ObsidionWallet, "create")
    .mockImplementation(
      async (node, _pxeConfig, _options, walletOpts) =>
        new ObsidionWallet({} as never, node, walletOpts),
    )
}

type Ctx = ReturnType<typeof useAztecContext>

async function mountProvider() {
  const latest: { current: Ctx | null } = { current: null }
  const Probe = () => {
    latest.current = useAztecContext()
    return null
  }
  render(
    <AztecProvider>
      <Probe />
    </AztecProvider>,
  )
  await waitFor(() => expect(latest.current?.currentNetwork).not.toBeNull())
  return latest as { current: Ctx }
}

afterEach(() => {
  vi.restoreAllMocks()
  setActiveNetworkId(undefined)
})

describe("initializePXE build path", () => {
  it("with chainIdentity: pins the wallet and publishes the pinned rollup address", async () => {
    const create = stubCreate()
    const { node, getNodeInfo } = stubNode()
    const ctx = await mountProvider()

    await act(async () => {
      await ctx.current.initializePXE({ node, chainIdentity })
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][3]).toMatchObject({
      chainInfo: { l1ChainId: 11155111, rollupVersion: 1821665230 },
    })
    expect(getActiveNetworkId()).toBe(PINNED_ROLLUP)
    await waitFor(() => expect(ctx.current.rollupAddress).toBe(PINNED_ROLLUP))
    expect(getNodeInfo).not.toHaveBeenCalled()
    await expect(ctx.current.obsidionWallet!.getNodeIdentity()).resolves.toEqual({
      l1ChainId: 11155111,
      rollupVersion: 1821665230,
    })
  })

  it("without chainIdentity: the node's answer is stamped, as before", async () => {
    const create = stubCreate()
    const { node, getNodeInfo } = stubNode()
    const ctx = await mountProvider()

    await act(async () => {
      await ctx.current.initializePXE({ node })
    })

    expect(create.mock.calls[0][3]).toMatchObject({ chainInfo: undefined })
    expect(getNodeInfo).toHaveBeenCalled()
    expect(getActiveNetworkId()).toBe(NODE_ROLLUP)
    await expect(ctx.current.obsidionWallet!.getNodeIdentity()).resolves.toEqual({
      l1ChainId: 31337,
      rollupVersion: 4127419662,
    })
  })
})

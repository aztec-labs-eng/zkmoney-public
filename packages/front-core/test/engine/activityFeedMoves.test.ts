// @vitest-environment node
import { describe, expect, it } from "vitest"
import type { Hash, Hex } from "viem"
import type { MoveRecord } from "../../src/engine/moveTransition"
import { findMoveItem } from "../../src/engine/activityFeed"
import { bridgeDetailTarget, findBridgeItem } from "../../src/engine/feedRules"
import { burn, feedOf, HOUR, kinds, NOW } from "./feedFixtures"

const move = (over: Partial<MoveRecord> = {}): MoveRecord =>
  ({
    id: "m1",
    holdingId: "fea-sky",
    rail: "executor",
    direction: "in",
    amount: 100n,
    withdrawalLocalId: "w-move",
    nonce: `0x${"01".repeat(32)}` as Hex,
    recipientCommitment: `0x${"0c".repeat(32)}` as Hex,
    scanFrom: 7n,
    phase: "burned",
    startTime: NOW - HOUR,
    ...over,
  } as MoveRecord)

describe("selectFeed: holding moves", () => {
  it("shows each move as one item with its burn, which leaves the withdrawals", () => {
    const own = burn({
      localId: "w-move",
      phase: "finalizing_l1",
      minedAt: NOW - HOUR,
      startTime: NOW - HOUR,
      endTime: undefined,
    })
    const replayedBurn = burn({
      localId: "w-rebuilt",
      l2TxHash: `0x${"0b".repeat(32)}` as Hash,
      endTime: NOW - 2 * HOUR,
    })
    const plain = burn({ localId: "w-plain" })
    const feed = feedOf({
      withdrawals: [own, replayedBurn, plain],
      moves: [
        move(),
        move({
          id: "m2",
          direction: "out",
          phase: "claimed",
          withdrawalLocalId: undefined,
          replayedFrom: `0x${"0B".repeat(32)}`,
          startTime: NOW - 2 * HOUR,
        }),
        move({ id: "m3", phase: "dropped", startTime: NOW }),
      ],
    })
    expect(kinds(feed.items)).toEqual(["move:move:m1", "move:move:m2", "withdrawal:w-plain"])
    expect(feed.items[0]).toMatchObject({
      direction: "out",
      pending: true,
      burn: own,
      state: { kind: "pending" },
    })
    expect(feed.items[1]).toMatchObject({
      direction: "in",
      pending: false,
      burn: replayedBurn,
      state: { kind: "done" },
    })
  })

  it("shows a bridging withdrawal and a move once each, neither as the other", () => {
    const own = burn({
      localId: "w-move",
      phase: "finalizing_l1",
      minedAt: NOW - HOUR,
      startTime: NOW - HOUR,
      endTime: undefined,
    })
    const bridged = burn({
      localId: "w-bridge",
      phase: "bridging",
      startTime: NOW - 2 * HOUR,
      endTime: undefined,
      l2TxHash: `0x${"0a".repeat(32)}` as Hash,
      swapExecuteTxHash: `0x${"0e".repeat(32)}` as Hash,
      bridgeOut: {
        provider: "across",
        chainId: 8453,
        chainName: "Base",
        minReceived: "98",
        acrossFee: "1",
        nonce: `0x${"02".repeat(32)}` as Hex,
        recoveryCommitment: `0x${"0d".repeat(32)}` as Hex,
        relayerTip: "1",
      },
    })
    const feed = feedOf({ withdrawals: [own, bridged], moves: [move()] })
    expect(kinds(feed.items)).toEqual(["move:move:m1", "withdrawal:w-bridge"])
    expect(feed.items[0]).toMatchObject({ burn: own, pending: true })
    expect(feed.items[1]).toMatchObject({ record: bridged, direction: "out", pending: true })
  })

  it("orders a move by when its burn's withdrawal ended, and one with no burn by its start", () => {
    const ended = burn({ localId: "w-move", startTime: NOW - 3 * HOUR, endTime: NOW - HOUR })
    const between = burn({ localId: "w-plain", startTime: NOW - 2 * HOUR, endTime: NOW - 2 * HOUR })
    const replayed = move({
      id: "m2",
      withdrawalLocalId: undefined,
      replayedFrom: `0x${"0b".repeat(32)}`,
      startTime: NOW - 4 * HOUR,
    })
    const feed = feedOf({
      withdrawals: [ended, between],
      moves: [move({ startTime: NOW - 3 * HOUR }), replayed],
    })
    expect(kinds(feed.items)).toEqual(["move:move:m1", "withdrawal:w-plain", "move:move:m2"])
  })

  it("lists Savings' moves as Savings sees them, and hides a move's burn no move carries yet", () => {
    const sky = move({ rail: "skyEscrow", escrow: { factory: "0xf", address: "0xe", tip: 1n } })
    const orphan = burn({
      localId: "w-orphan",
      skyMove: {
        direction: "in",
        factory: "0xf",
        recipientCommitment: "0x0c",
        recoveryCommitment: "0x0d",
        relayerTip: "1",
        nonce: "0x01",
      },
    })
    const vaultOrphan = burn({
      localId: "w-vault-orphan",
      vaultMove: { holdingId: "fea-vault", nonce: "0x02" },
    })
    const feed = feedOf({
      withdrawals: [orphan, vaultOrphan],
      moves: [sky, move({ id: "m-exec" })],
    })
    expect(kinds(feed.items)).toEqual(["move:move:m1", "move:move:m-exec"])
    expect(feed.savings).toMatchObject({
      hydrated: true,
      items: [{ id: "move:m1", direction: "in" }],
    })
    expect(feed.savings.items).toHaveLength(1)
  })

  it("holds Savings' history as loading on a device with no moves until the replay ran", () => {
    expect(feedOf({ movesReplayed: false }).savings.hydrated).toBe(false)
    expect(feedOf({ movesReplayed: true }).savings.hydrated).toBe(true)
    expect(feedOf({ moves: [move()], movesReplayed: false }).savings.hydrated).toBe(true)
  })

  it("opens a move from the notification of its burn", () => {
    const own = burn({ localId: "w-move", skyMove: { direction: "in" } as never })
    const feed = feedOf({ withdrawals: [own], moves: [move()] })
    const hit = findBridgeItem(feed.bridge, { openWithdrawalId: "w-move" })
    const target = hit && bridgeDetailTarget(hit)
    expect(target).toEqual({ kind: "savings", id: "w-move" })
    expect(findMoveItem(feed.items, "w-move")?.move.id).toBe("m1")
    expect(findMoveItem(feed.items, "move:m1")?.move.id).toBe("m1")
  })
})

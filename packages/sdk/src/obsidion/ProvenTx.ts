import { OffchainEffect, ProvingStats, Tx, TxHash, TxReceipt } from "@aztec/stdlib/tx"
import { AztecNode, waitForTx } from "@aztec/aztec.js/node"
import { NO_WAIT, NoWait, WaitOpts } from "@aztec/aztec.js/contracts"
import { SimulationError } from "@aztec/stdlib/errors"
import { ProvingStage, provingProgress } from "@obsidion/proving-progress"
import { inspect } from "util"

export type ProvenTxSendOpts = {
  wait?: NoWait | WaitOpts
}

export type ProvenTxSendReturn<T extends NoWait | WaitOpts | undefined> = T extends NoWait
  ? TxHash
  : TxReceipt

/**
 * A proven transaction that can be sent to the network. Returned by the `prove` method of the test wallet
 */
export class ProvenTx extends Tx {
  constructor(
    private node: AztecNode,
    tx: Tx,
    public offchainEffects: OffchainEffect[],
    public stats?: ProvingStats,
    private defaultWaitOpts: WaitOpts = {},
  ) {
    super(
      tx.getTxHash(),
      tx.data,
      tx.chonkProof,
      tx.contractClassLogFields,
      tx.publicFunctionCalldata,
    )
  }

  send(options?: Omit<ProvenTxSendOpts, "wait">): Promise<TxReceipt>
  send<W extends ProvenTxSendOpts["wait"]>(
    options: ProvenTxSendOpts & { wait: W },
  ): Promise<ProvenTxSendReturn<W>>
  async send(options?: ProvenTxSendOpts): Promise<TxHash | TxReceipt> {
    const txHash = this.getTxHash()
    provingProgress.emitStageStart(ProvingStage.Mining)
    try {
      await this.node.sendTx(this).catch((err) => {
        throw this.contextualizeError(err, inspect(this))
      })

      if (options?.wait === NO_WAIT) {
        return txHash
      }

      const waitOpts = typeof options?.wait === "object" ? options.wait : undefined
      const receipt = await waitForTx(this.node, txHash, { ...this.defaultWaitOpts, ...waitOpts })
      provingProgress.emitStageComplete(ProvingStage.Mining)
      return receipt
    } catch (err) {
      provingProgress.emitReset()
      throw err
    }
  }

  private contextualizeError(err: Error, ...context: string[]): Error {
    let contextStr = ""
    if (context.length > 0) {
      contextStr = `\nContext:\n${context.join("\n")}`
    }
    if (err instanceof SimulationError) {
      err.setAztecContext(contextStr)
    }
    return err
  }
}

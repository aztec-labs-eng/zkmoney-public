import {
  Transaction,
  TokenInTxService,
  TokenAction,
  FaucetAction,
  PaylinkAction,
  TokenTransaction,
  FaucetTransaction,
  PaylinkTransaction,
  AccountCreationTransaction,
  AccountCreationAction,
  AccountActions,
} from "src/types"
import { TOKEN_ACTIONS, TRANSACTION_ACTIONS, LOG_PREFIX } from "./constants"
import { logger } from "src/utils/logger"

// ACTION.paylink resolves to the persisted field name
// `emailPaymentAction`, kept unchanged for back-compat with rows persisted
// before the EmailPayment→Paylink rename.
export enum ACTION {
  action = "action",
  paylink = "emailPaymentAction",
}

// Define a discriminated union of all params variants
type TxParams =
  | ({ action: AccountCreationAction } & Partial<AccountCreationTransaction>)
  | ({ action: TokenAction } & Partial<TokenTransaction>)
  | ({ action: FaucetAction } & Partial<FaucetTransaction>)
  | ({ emailPaymentAction: PaylinkAction } & Partial<PaylinkTransaction>)

// Type guards and factories for each transaction type

// Account Creation
const isAccountCreation = (
  params: Partial<TxParams>,
): params is Partial<AccountCreationTransaction> => {
  return (
    ACTION.action in params &&
    (params.action === AccountActions.CREATE_ACCOUNT ||
      params.action === AccountActions.IMPORT_ACCOUNT)
  )
}

function makeAccountCreation(
  params: Partial<AccountCreationTransaction>,
): AccountCreationTransaction {
  return {
    ...params,
    action: params.action as AccountCreationAction,
  } as AccountCreationTransaction
}

// Token Transaction
const isTokenTx = (params: Partial<TxParams>): params is Partial<TokenTransaction> => {
  return (
    ACTION.action in params &&
    typeof params.action === "string" &&
    (params.action === TOKEN_ACTIONS.SEND || params.action === TOKEN_ACTIONS.RECEIVE)
  )
}

function makeTokenTx(params: Partial<TokenTransaction>): TokenTransaction {
  if (!params.token) {
    logger.error(`${LOG_PREFIX} Token transaction missing token object`)
    throw new Error("Token transaction requires a token object")
  }
  return {
    ...params,
    action: params.action as TokenAction,
    token: params.token as TokenInTxService,
  } as TokenTransaction
}

// Faucet Transaction
const isFaucetTx = (params: Partial<TxParams>): params is Partial<FaucetTransaction> => {
  return ACTION.action in params && params.action === TRANSACTION_ACTIONS.FAUCET
}

function makeFaucetTx(params: Partial<FaucetTransaction>): FaucetTransaction {
  if (!params.token) {
    logger.error(`${LOG_PREFIX} Faucet transaction missing token object`)
    throw new Error("Faucet transaction requires a token object")
  }
  return {
    ...params,
    action: TRANSACTION_ACTIONS.FAUCET as FaucetAction,
    token: params.token as TokenInTxService,
  } as FaucetTransaction
}

// Paylink Transaction (formerly EmailPayment) — discriminated by presence of
// the legacy-named `emailPaymentAction` field. Direct vs email flavor is
// carried on the row's `flavor` field, not the action enum.
const isPaylink = (params: Partial<TxParams>): params is Partial<PaylinkTransaction> => {
  return ACTION.paylink in params
}

function makePaylink(params: Partial<PaylinkTransaction>): PaylinkTransaction {
  // `flavor` is required on the type but the surrounding factory dispatch
  // accepts `Partial<PaylinkTransaction>` and the trailing `as PaylinkTransaction`
  // would otherwise let a row through with no discriminator. Producing such a
  // row would force the read-time recipient-shape projection to take a guess
  // it can't reliably make on a fresh write. Fail loudly at the boundary instead.
  if (params.flavor !== "direct" && params.flavor !== "email" && params.flavor !== "zk") {
    logger.error(`${LOG_PREFIX} Paylink transaction missing flavor discriminator`)
    throw new Error("Paylink transaction requires a flavor: 'direct' | 'email' | 'zk'")
  }
  return {
    ...params,
    action: params.emailPaymentAction as PaylinkAction,
    emailPaymentAction: params.emailPaymentAction,
  } as PaylinkTransaction
}

// Factory interface
interface TransactionFactory {
  guard: (params: Partial<TxParams>) => boolean
  maker: (params: any) => Transaction
}

// Collect all factories
export const transactionFactories: TransactionFactory[] = [
  { guard: isAccountCreation, maker: makeAccountCreation },
  { guard: isTokenTx, maker: makeTokenTx },
  { guard: isFaucetTx, maker: makeFaucetTx },
  { guard: isPaylink, maker: makePaylink },
]

// Main factory function
export function createTransactionObject(params: Partial<TxParams>): Transaction | undefined {
  for (const { guard, maker } of transactionFactories) {
    if (guard(params)) {
      return maker(params)
    }
  }

  logger.error(`${LOG_PREFIX} Could not classify transaction`, params)
  return undefined
}

/** Canonical lowercase tx-hash form; dedup and lookups compare on this. */
export function normalizeTxHash(txHash: string): string {
  return txHash.toLowerCase()
}

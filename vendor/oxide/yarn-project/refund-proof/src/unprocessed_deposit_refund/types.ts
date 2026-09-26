import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Fr } from '@aztec/aztec.js/fields';
import type { ARCHIVE_HEIGHT } from '@aztec/constants';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec/foundation/eth-address';
import type { Logger } from '@aztec/foundation/log';
import type { Tuple } from '@aztec/foundation/serialize';
import type { PublicKeys } from '@aztec/stdlib/keys';
import type { BlockHeader } from '@aztec/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import type { RefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';

export interface UnprocessedDepositRefundProofInput {
  chainId: bigint;
  rollupVersion: bigint;
  l1Portal: EthAddress;
  frozenArchiveRoot: Fr;
  amount: bigint;
  executor: EthAddress;
  userPayloadHash: Fr;
  messageHash: Fr;
  messageLeafIndex: Fr;
  l2Token: AztecAddress;
  frozenTip: BlockHeader;
  frozenTipSiblingPath: Tuple<Fr, typeof ARCHIVE_HEIGHT>;
  sharedSecretSalt: Fr;
  l2Recipient: AztecAddress;
  l2RecipientPublicKeys: PublicKeys;
  l2RecipientInstance: AccountInstancePreimage;
  l2RecipientNhkM: GrumpkinScalar;
  auth: RefundAuthorization;
}

export interface UnprocessedDepositRefundProofOptions {
  logger?: Logger;
}

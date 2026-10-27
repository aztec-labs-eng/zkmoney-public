import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Fr } from '@aztec-labs/aztec.js/fields';
import type { ARCHIVE_HEIGHT } from '@aztec-labs/constants';
import type { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';
import type { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';
import type { Tuple } from '@aztec-labs/foundation/serialize';
import type { PublicKeys } from '@aztec-labs/stdlib/keys';
import type { BlockHeader } from '@aztec-labs/stdlib/tx';

import type { AccountInstancePreimage } from '@oxide/oxide-lib/account_address.js';
import type { MigrationSignature } from '@oxide/oxide-lib/migration_signature.js';

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
  migrationSignature: MigrationSignature;
}

export interface UnprocessedDepositRefundProofOptions {
  logger?: Logger;
}

// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

// GENERATED from noir-projects/oxide_lib/src/constants.nr by yarn-project/oxide-lib/scripts/gen_constants.mjs.
// Do not edit by hand. Only the constants the Solidity sources reference are mirrored here.
library OxideConstants {
  uint8 internal constant TEE_SIG_DOMAIN_WITHDRAWAL_FINALIZED = 2;
  uint8 internal constant TEE_SIG_DOMAIN_FROZEN_NOTES_REFUND = 3;
  uint8 internal constant TEE_SIG_DOMAIN_FROZEN_DEPOSIT_REFUND = 4;
  uint8 internal constant TEE_SIG_DOMAIN_UNPROCESSED_DEPOSIT_REFUND = 5;
  bytes32 internal constant PORTAL_CONSTANT_SECRET_HASH = bytes32(0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250);
  uint128 internal constant TX_AMOUNT_CAP = 0x8c06536eadf1fc0000;
  uint128 internal constant MAX_PRIORITY_FEE_WEI = 100000000;
  uint32 internal constant MAX_FROZEN_NOTES_PER_REFUND = 10;
  uint32 internal constant FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT = 18;
  uint32 internal constant FROZEN_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT = 8;
  uint32 internal constant UNPROCESSED_DEPOSIT_REFUND_PUBLIC_INPUT_COUNT = 10;
  uint128 internal constant K1_N_HI = 0xfffffffffffffffffffffffffffffffe;
  uint128 internal constant K1_N_LO = 0xbaaedce6af48a03bbfd25e8cd0364141;
  uint128 internal constant K1_P_HI = 0xffffffffffffffffffffffffffffffff;
  uint128 internal constant K1_P_LO = 0xfffffffffffffffffffffffefffffc2f;
}

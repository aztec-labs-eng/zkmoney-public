// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

// solhint-disable oxide/no-comments
// An intent is an open id, not an enum. An enum makes the ABI decoder reject each value above its last member, so a
// deployed factory or table could not accept an intent that a later release adds.
// solhint-enable oxide/no-comments
type Intent is uint8;

using {eq as ==, neq as !=} for Intent global;

library Intents {
  Intent internal constant NONE = Intent.wrap(0);
  Intent internal constant DEPOSIT = Intent.wrap(1);
  Intent internal constant REGISTRATION = Intent.wrap(2);
  Intent internal constant ADD_PASSKEY = Intent.wrap(4);
}

function eq(Intent a, Intent b) pure returns (bool) {
  return Intent.unwrap(a) == Intent.unwrap(b);
}

function neq(Intent a, Intent b) pure returns (bool) {
  return Intent.unwrap(a) != Intent.unwrap(b);
}

// `as const` ABIs for the OxidePortal events tooling needs to decode. viem's `parseEventLogs` /
// `decodeEventLog` only narrow `args` when the abi argument is `as const`; the JSON import in
// `./artifacts.js` isn't, so use these slim copies at decode sites and the full one for
// `getContract`. Keep these signatures byte-for-byte aligned with `OxidePortal.sol::event …`.

export const OxidePortalEventsAbi = [
  {
    type: 'event',
    name: 'TEEAdded',
    inputs: [
      { name: 'tee', type: 'address', indexed: true },
      { name: 'pubKeyX', type: 'bytes32', indexed: false },
      { name: 'pubKeyY', type: 'bytes32', indexed: false },
      { name: 'encPubKeyX', type: 'bytes32', indexed: false },
      { name: 'encPubKeyY', type: 'bytes32', indexed: false },
      { name: 'messageKey', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'TEEPcr0Approved',
    inputs: [{ name: 'pcr0Hash', type: 'bytes32', indexed: true }],
  },
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      { name: 'recipientCommitment', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'key', type: 'bytes32', indexed: false },
      { name: 'index', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WithdrawalOrRefund',
    inputs: [
      { name: 'flow', type: 'uint8', indexed: true },
      { name: 'nullifier', type: 'bytes32', indexed: true },
      { name: 'executor', type: 'address', indexed: true },
      { name: 'executionAmount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Initialized',
    inputs: [{ name: 'l2Portal', type: 'bytes32', indexed: false }],
  },
  {
    type: 'event',
    name: 'Frozen',
    inputs: [
      { name: 'checkpointNumber', type: 'uint256', indexed: true },
      { name: 'epochNumber', type: 'uint256', indexed: true },
      { name: 'archive', type: 'bytes32', indexed: false },
      { name: 'freezeCheckpointCount', type: 'uint256', indexed: false },
    ],
  },
] as const;

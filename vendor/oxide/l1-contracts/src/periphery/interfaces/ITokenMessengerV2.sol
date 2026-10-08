// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

// solhint-disable-next-line oxide/no-comments
// Circle CCTP V2 contract that burns USDC on this chain so that Circle mints it on the destination domain.
interface ITokenMessengerV2 {
  function depositForBurnWithHook(
    uint256 _amount,
    uint32 _destinationDomain,
    bytes32 _mintRecipient,
    address _burnToken,
    bytes32 _destinationCaller,
    uint256 _maxFee,
    uint32 _minFinalityThreshold,
    bytes calldata _hookData
  ) external;
}

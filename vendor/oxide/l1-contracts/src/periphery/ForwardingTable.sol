// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {Errors} from "@periphery/Errors.sol";

// solhint-disable oxide/no-comments
/**
 * @notice Routes SIPA funds to the correct token portal. With multi-token support, a SIPA commits to a table instead
 * of a portal, allowing the SIPA address to accept any token on that table's list. Each row on ForwardingTable maps to
 * the portal that holds it. Each token row also sets a sweep tip for relayers and a fee for a 'beneficiary', as fixed
 * amounts of the token. When a SIPA is swept, it reads the row. If the token or the intent are don't have a row,
 * the sweep reverts and the funds stay in the SIPA to be recovered.
 *
 * @notice The table owner can list a new token, an intent to a listed token, and change the fee beneficiary. The table
 * is append-only, meaning the values of a row that already exists cannot change after a SIPA has already been funded
 * and is waiting to be swept. A new portal or a change in fees for a listed row would need a new table, and therefore
 * new SIPA addresses would be generated.
 * NOTE: The owner fully controls the beneficiary address and fee terms for new tokens that don't yet have a row
 * on the table. Anyone can deploy a table, but a SIPA can commit only to a table that the SIPAFactory approves.
 */
// solhint-enable oxide/no-comments

contract ForwardingTable is IForwardingTable, Ownable {
  struct Fees {
    uint128 beneficiaryFee;
    uint128 sweepTip;
  }

  struct Row {
    IOxidePortal portal;
    mapping(SIPABase.Intent intent => Fees fees) intents;
  }

  uint256 public immutable ROLLUP_VERSION;

  address public $beneficiary;

  mapping(address token => Row row) public $rows;

  constructor(ConstructorArgs memory _args) Ownable(_args.owner) {
    ROLLUP_VERSION = _args.rollupVersion;
    _setBeneficiary(_args.beneficiary);
    for (uint256 i = 0; i < _args.rows.length; i++) {
      _addRow(_args.rows[i].token, _args.rows[i].portal, _args.rows[i].intents);
    }
  }

  function rowFor(address _token, SIPABase.Intent _intent)
    external
    view
    returns (IOxidePortal portal, address beneficiary, uint128 beneficiaryFee, uint128 sweepTip)
  {
    Row storage row = $rows[_token];
    portal = row.portal;
    require(address(portal) != address(0), Errors.ForwardingTable__TokenNotListed(_token));
    Fees memory fees = row.intents[_intent];
    require(fees.sweepTip > 0, Errors.ForwardingTable__IntentNotListed(_token, uint8(_intent)));
    return (portal, $beneficiary, fees.beneficiaryFee, fees.sweepTip);
  }

  function addRow(address _token, IOxidePortal _portal, IntentFees[] calldata _intents) external onlyOwner {
    _addRow(_token, _portal, _intents);
  }

  function addIntents(address _token, IntentFees[] calldata _intents) external onlyOwner {
    require(address($rows[_token].portal) != address(0), Errors.ForwardingTable__TokenNotListed(_token));
    _writeIntents(_token, _intents);
    emit IntentsAdded(_token, _intents);
  }

  function setBeneficiary(address _beneficiary) external onlyOwner {
    _setBeneficiary(_beneficiary);
  }

  function _addRow(address _token, IOxidePortal _portal, IntentFees[] memory _intents) private {
    require(address($rows[_token].portal) == address(0), Errors.ForwardingTable__TokenAlreadyListed(_token));
    _checkPortal(_token, _portal);
    $rows[_token].portal = _portal;
    _writeIntents(_token, _intents);
    emit RowAdded(_token, address(_portal), _intents);
  }

  function _checkPortal(address _token, IOxidePortal _portal) private view {
    require(address(_portal) != address(0), Errors.ForwardingTable__ZeroPortal());
    address underlying = address(_portal.UNDERLYING());
    require(underlying == _token, Errors.ForwardingTable__TokenNotPortalUnderlying(_token, underlying));
    uint256 portalVersion = _portal.ROLLUP_VERSION();
    require(
      portalVersion == ROLLUP_VERSION, Errors.ForwardingTable__RollupVersionMismatch(portalVersion, ROLLUP_VERSION)
    );
  }

  function _writeIntents(address _token, IntentFees[] memory _intents) private {
    require(_intents.length > 0, Errors.ForwardingTable__NoIntents());
    mapping(SIPABase.Intent intent => Fees fees) storage intents = $rows[_token].intents;
    for (uint256 i = 0; i < _intents.length; i++) {
      IntentFees memory entry = _intents[i];
      require(entry.intent != SIPABase.Intent.None, Errors.ForwardingTable__NoneIntent());
      require(
        intents[entry.intent].sweepTip == 0, Errors.ForwardingTable__IntentAlreadyListed(_token, uint8(entry.intent))
      );
      require(entry.sweepTip > 0, Errors.ForwardingTable__ZeroSweepTip());
      intents[entry.intent] = Fees({beneficiaryFee: entry.beneficiaryFee, sweepTip: entry.sweepTip});
    }
  }

  function _setBeneficiary(address _beneficiary) private {
    require(_beneficiary != address(0), Errors.ForwardingTable__ZeroBeneficiary());
    emit BeneficiaryUpdated($beneficiary, _beneficiary);
    $beneficiary = _beneficiary;
  }
}

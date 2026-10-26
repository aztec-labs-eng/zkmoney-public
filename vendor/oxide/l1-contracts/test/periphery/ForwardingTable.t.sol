// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {IForwardingTable} from "@periphery/interfaces/IForwardingTable.sol";
import {SIPABase} from "@periphery/SIPABase.sol";
import {Errors} from "@periphery/Errors.sol";
import {MockPortal} from "@test/mocks/MockPortal.sol";

contract ForwardingTableTest is Test {
  uint256 internal constant ROLLUP_VERSION = 7;
  uint128 internal constant SWEEP_TIP = 25e16;
  uint128 internal constant BENEFICIARY_FEE = 1e18;

  SIPABase.Intent internal constant DEPOSIT = SIPABase.Intent.Deposit;
  SIPABase.Intent internal constant REGISTRATION = SIPABase.Intent.Registration;
  SIPABase.Intent internal constant USER_OP = SIPABase.Intent.UserOp;

  address internal owner = makeAddr("owner");
  address internal funder = makeAddr("funder");
  address internal dai = makeAddr("dai");
  address internal usdc = makeAddr("usdc");

  ForwardingTable internal table;
  IOxidePortal internal daiPortal;
  IOxidePortal internal usdcPortal;

  function setUp() public {
    table = _deploy(owner, funder, _noRows());
    daiPortal = _portal(dai, ROLLUP_VERSION);
    usdcPortal = _portal(usdc, ROLLUP_VERSION);
  }

  function test_constructorListsTheInitialRows() public {
    IForwardingTable.IntentFees[] memory daiIntents = new IForwardingTable.IntentFees[](2);
    daiIntents[0] = IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    daiIntents[1] = IForwardingTable.IntentFees({intent: REGISTRATION, beneficiaryFee: 0, sweepTip: 2 * SWEEP_TIP});
    IForwardingTable.IntentFees[] memory usdcIntents = _one(DEPOSIT, 0, 1);
    IForwardingTable.InitialRow[] memory rows = new IForwardingTable.InitialRow[](2);
    rows[0] = IForwardingTable.InitialRow({token: dai, portal: daiPortal, intents: daiIntents});
    rows[1] = IForwardingTable.InitialRow({token: usdc, portal: usdcPortal, intents: usdcIntents});

    vm.expectEmit();
    emit IForwardingTable.RowAdded(dai, address(daiPortal), daiIntents);
    vm.expectEmit();
    emit IForwardingTable.RowAdded(usdc, address(usdcPortal), usdcIntents);
    ForwardingTable listed = _deploy(owner, funder, rows);

    (IOxidePortal portal, address beneficiary, uint128 beneficiaryFee, uint128 sweepTip) = listed.rowFor(dai, DEPOSIT);
    assertEq(address(portal), address(daiPortal));
    assertEq(beneficiary, funder);
    assertEq(beneficiaryFee, BENEFICIARY_FEE);
    assertEq(sweepTip, SWEEP_TIP);
    (,, beneficiaryFee, sweepTip) = listed.rowFor(dai, REGISTRATION);
    assertEq(beneficiaryFee, 0);
    assertEq(sweepTip, 2 * SWEEP_TIP);
    (portal,, beneficiaryFee, sweepTip) = listed.rowFor(usdc, DEPOSIT);
    assertEq(address(portal), address(usdcPortal));
    assertEq(beneficiaryFee, 0);
    assertEq(sweepTip, 1);
    assertEq(listed.owner(), owner, "the owner is set at deploy, with no transfer");
  }

  function test_constructorRejectsAnInvalidInitialRow() public {
    IForwardingTable.InitialRow[] memory rows = new IForwardingTable.InitialRow[](2);
    rows[0] =
      IForwardingTable.InitialRow({token: dai, portal: daiPortal, intents: _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP)});
    rows[1] =
      IForwardingTable.InitialRow({token: usdc, portal: daiPortal, intents: _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP)});

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotPortalUnderlying.selector, usdc, dai));
    _deploy(owner, funder, rows);
  }

  function test_constructorRejectsAnInitialRowWithAnInvalidIntent() public {
    IForwardingTable.InitialRow[] memory rows = new IForwardingTable.InitialRow[](1);
    rows[0] = IForwardingTable.InitialRow({token: dai, portal: daiPortal, intents: _one(DEPOSIT, BENEFICIARY_FEE, 0)});

    vm.expectRevert(Errors.ForwardingTable__ZeroSweepTip.selector);
    _deploy(owner, funder, rows);
  }

  function test_constructorPinsRollupVersionOwnerAndBeneficiary() public view {
    assertEq(table.ROLLUP_VERSION(), ROLLUP_VERSION);
    assertEq(table.owner(), owner);
    assertEq(table.$beneficiary(), funder);
  }

  function test_constructorEmitsBeneficiaryUpdated() public {
    vm.expectEmit();
    emit IForwardingTable.BeneficiaryUpdated(address(0), funder);
    _deploy(owner, funder, _noRows());
  }

  function test_constructorRejectsZeroBeneficiary() public {
    vm.expectRevert(Errors.ForwardingTable__ZeroBeneficiary.selector);
    _deploy(owner, address(0), _noRows());
  }

  function test_constructorRejectsZeroOwner() public {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    _deploy(address(0), funder, _noRows());
  }

  function test_addRowListsAToken() public {
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.expectEmit();
    emit IForwardingTable.RowAdded(dai, address(daiPortal), intents);
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);

    (IOxidePortal portal, address beneficiary, uint128 beneficiaryFee, uint128 sweepTip) = table.rowFor(dai, DEPOSIT);
    assertEq(address(portal), address(daiPortal));
    assertEq(beneficiary, funder);
    assertEq(beneficiaryFee, BENEFICIARY_FEE);
    assertEq(sweepTip, SWEEP_TIP);
    assertEq(address(table.$rows(dai)), address(daiPortal));
  }

  function test_rowsAreIndependentPerToken() public {
    vm.startPrank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));
    table.addRow(usdc, usdcPortal, _one(DEPOSIT, 0, 1));
    vm.stopPrank();

    (IOxidePortal portal,,, uint128 sweepTip) = table.rowFor(dai, DEPOSIT);
    assertEq(address(portal), address(daiPortal));
    assertEq(sweepTip, SWEEP_TIP);
    (portal,,, sweepTip) = table.rowFor(usdc, DEPOSIT);
    assertEq(address(portal), address(usdcPortal));
    assertEq(sweepTip, 1);
  }

  function test_intentsAreIndependentInARow() public {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](3);
    intents[0] = IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    intents[1] = IForwardingTable.IntentFees({intent: REGISTRATION, beneficiaryFee: 0, sweepTip: 2 * SWEEP_TIP});
    intents[2] =
      IForwardingTable.IntentFees({intent: USER_OP, beneficiaryFee: 3 * BENEFICIARY_FEE, sweepTip: 3 * SWEEP_TIP});
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);

    for (uint256 i = 0; i < intents.length; i++) {
      (IOxidePortal portal,, uint128 beneficiaryFee, uint128 sweepTip) = table.rowFor(dai, intents[i].intent);
      assertEq(address(portal), address(daiPortal));
      assertEq(beneficiaryFee, intents[i].beneficiaryFee);
      assertEq(sweepTip, intents[i].sweepTip);
    }
  }

  function test_addRowRejectsAListedToken() public {
    IOxidePortal newPortal = _portal(dai, ROLLUP_VERSION);
    vm.startPrank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenAlreadyListed.selector, dai));
    table.addRow(dai, newPortal, _one(REGISTRATION, 0, SWEEP_TIP));
    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenAlreadyListed.selector, dai));
    table.addRow(dai, daiPortal, _one(REGISTRATION, 0, SWEEP_TIP));
    vm.stopPrank();

    assertEq(address(table.$rows(dai)), address(daiPortal));
  }

  function test_addRowRejectsADuplicateIntent() public {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](3);
    intents[0] = IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    intents[1] =
      IForwardingTable.IntentFees({intent: REGISTRATION, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    intents[2] =
      IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: 2 * BENEFICIARY_FEE, sweepTip: 2 * SWEEP_TIP});
    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__IntentAlreadyListed.selector, dai, uint8(DEPOSIT)));
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);
  }

  function test_addRowRejectsAnEmptyIntentList() public {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](0);
    vm.expectRevert(Errors.ForwardingTable__NoIntents.selector);
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);
  }

  function test_constructorRejectsAnInitialRowWithNoIntents() public {
    IForwardingTable.InitialRow[] memory rows = new IForwardingTable.InitialRow[](1);
    rows[0] =
      IForwardingTable.InitialRow({token: dai, portal: daiPortal, intents: new IForwardingTable.IntentFees[](0)});

    vm.expectRevert(Errors.ForwardingTable__NoIntents.selector);
    _deploy(owner, funder, rows);
  }

  function testFuzz_addRowStoresAnyAmounts(uint8 _intent, uint128 _beneficiaryFee, uint128 _sweepTip) public {
    SIPABase.Intent intent = SIPABase.Intent(bound(_intent, 1, uint256(type(SIPABase.Intent).max)));
    _sweepTip = uint128(bound(_sweepTip, 1, type(uint128).max));
    vm.prank(owner);
    table.addRow(dai, daiPortal, _one(intent, _beneficiaryFee, _sweepTip));

    (,, uint128 beneficiaryFee, uint128 sweepTip) = table.rowFor(dai, intent);
    assertEq(beneficiaryFee, _beneficiaryFee);
    assertEq(sweepTip, _sweepTip);
  }

  function testFuzz_addRowRejectsNonOwner(address _caller) public {
    vm.assume(_caller != owner);
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, _caller));
    vm.prank(_caller);
    table.addRow(dai, daiPortal, intents);
  }

  function test_addRowRejectsZeroPortal() public {
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.expectRevert(Errors.ForwardingTable__ZeroPortal.selector);
    vm.prank(owner);
    table.addRow(dai, IOxidePortal(address(0)), intents);
  }

  function test_addRowRejectsZeroSweepTip() public {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](2);
    intents[0] = IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    intents[1] = IForwardingTable.IntentFees({intent: REGISTRATION, beneficiaryFee: BENEFICIARY_FEE, sweepTip: 0});
    vm.expectRevert(Errors.ForwardingTable__ZeroSweepTip.selector);
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);
  }

  function test_addRowRejectsTheNoneIntent() public {
    IForwardingTable.IntentFees[] memory intents = new IForwardingTable.IntentFees[](2);
    intents[0] = IForwardingTable.IntentFees({intent: DEPOSIT, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    intents[1] =
      IForwardingTable.IntentFees({intent: SIPABase.Intent.None, beneficiaryFee: BENEFICIARY_FEE, sweepTip: SWEEP_TIP});
    vm.expectRevert(Errors.ForwardingTable__NoneIntent.selector);
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);
  }

  function test_addRowRejectsAPortalForAnotherToken() public {
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotPortalUnderlying.selector, dai, usdc));
    vm.prank(owner);
    table.addRow(dai, usdcPortal, intents);
  }

  function test_addRowRejectsAPortalOnAnotherRollupVersion() public {
    IOxidePortal stale = _portal(dai, ROLLUP_VERSION - 1);
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ForwardingTable__RollupVersionMismatch.selector, ROLLUP_VERSION - 1, ROLLUP_VERSION)
    );
    vm.prank(owner);
    table.addRow(dai, stale, intents);
  }

  function testFuzz_addIntentsRejectsAChangeToAListedIntent(uint128 _beneficiaryFee, uint128 _sweepTip) public {
    _sweepTip = uint128(bound(_sweepTip, 1, type(uint128).max));
    vm.startPrank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__IntentAlreadyListed.selector, dai, uint8(DEPOSIT)));
    table.addIntents(dai, _one(DEPOSIT, _beneficiaryFee, _sweepTip));
    vm.stopPrank();

    (,, uint128 beneficiaryFee, uint128 sweepTip) = table.rowFor(dai, DEPOSIT);
    assertEq(beneficiaryFee, BENEFICIARY_FEE);
    assertEq(sweepTip, SWEEP_TIP);
  }

  function test_addIntentsAddsAnIntentToAListedToken() public {
    vm.startPrank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));

    IForwardingTable.IntentFees[] memory intents = _one(REGISTRATION, 0, 2 * SWEEP_TIP);
    vm.expectEmit();
    emit IForwardingTable.IntentsAdded(dai, intents);
    table.addIntents(dai, intents);
    vm.stopPrank();

    (IOxidePortal portal,, uint128 beneficiaryFee, uint128 sweepTip) = table.rowFor(dai, DEPOSIT);
    assertEq(address(portal), address(daiPortal));
    assertEq(beneficiaryFee, BENEFICIARY_FEE);
    assertEq(sweepTip, SWEEP_TIP);
    (,, beneficiaryFee, sweepTip) = table.rowFor(dai, REGISTRATION);
    assertEq(beneficiaryFee, 0);
    assertEq(sweepTip, 2 * SWEEP_TIP);
  }

  function test_addIntentsRejectsAnUnlistedToken() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, dai));
    vm.prank(owner);
    table.addIntents(dai, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));
  }

  function testFuzz_addIntentsRejectsNonOwner(address _caller) public {
    vm.assume(_caller != owner);
    vm.prank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, _caller));
    vm.prank(_caller);
    table.addIntents(dai, _one(REGISTRATION, 0, SWEEP_TIP));
  }

  function test_rowForRejectsAnUnlistedToken() public {
    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__TokenNotListed.selector, dai));
    table.rowFor(dai, DEPOSIT);
  }

  function test_rowForRejectsAnIntentThatIsNotConfigured() public {
    vm.prank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));

    vm.expectRevert(abi.encodeWithSelector(Errors.ForwardingTable__IntentNotListed.selector, dai, uint8(REGISTRATION)));
    table.rowFor(dai, REGISTRATION);
  }

  function test_setBeneficiaryAppliesToEveryRow() public {
    address pool = makeAddr("pool");
    vm.startPrank(owner);
    table.addRow(dai, daiPortal, _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP));
    table.addRow(usdc, usdcPortal, _one(REGISTRATION, BENEFICIARY_FEE, SWEEP_TIP));

    vm.expectEmit();
    emit IForwardingTable.BeneficiaryUpdated(funder, pool);
    table.setBeneficiary(pool);
    vm.stopPrank();

    assertEq(table.$beneficiary(), pool);
    (, address beneficiary,,) = table.rowFor(dai, DEPOSIT);
    assertEq(beneficiary, pool);
    (, beneficiary,,) = table.rowFor(usdc, REGISTRATION);
    assertEq(beneficiary, pool);
  }

  function test_setBeneficiaryRejectsZero() public {
    vm.expectRevert(Errors.ForwardingTable__ZeroBeneficiary.selector);
    vm.prank(owner);
    table.setBeneficiary(address(0));
  }

  function testFuzz_setBeneficiaryRejectsNonOwner(address _caller) public {
    vm.assume(_caller != owner);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, _caller));
    vm.prank(_caller);
    table.setBeneficiary(_caller);
  }

  function test_transferOwnershipHandsOverTheWrites() public {
    address multisig = makeAddr("multisig");
    IForwardingTable.IntentFees[] memory intents = _one(DEPOSIT, BENEFICIARY_FEE, SWEEP_TIP);
    vm.prank(owner);
    table.transferOwnership(multisig);

    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
    vm.prank(owner);
    table.addRow(dai, daiPortal, intents);

    vm.prank(multisig);
    table.addRow(dai, daiPortal, intents);
    (IOxidePortal portal,,,) = table.rowFor(dai, DEPOSIT);
    assertEq(address(portal), address(daiPortal));
  }

  function _deploy(address _owner, address _beneficiary, IForwardingTable.InitialRow[] memory _rows)
    internal
    returns (ForwardingTable)
  {
    return new ForwardingTable(
      IForwardingTable.ConstructorArgs({
        owner: _owner, rollupVersion: ROLLUP_VERSION, beneficiary: _beneficiary, rows: _rows
      })
    );
  }

  function _noRows() internal pure returns (IForwardingTable.InitialRow[] memory) {
    return new IForwardingTable.InitialRow[](0);
  }

  function _one(SIPABase.Intent _intent, uint128 _beneficiaryFee, uint128 _sweepTip)
    internal
    pure
    returns (IForwardingTable.IntentFees[] memory intents)
  {
    intents = new IForwardingTable.IntentFees[](1);
    intents[0] = IForwardingTable.IntentFees({intent: _intent, beneficiaryFee: _beneficiaryFee, sweepTip: _sweepTip});
  }

  function _portal(address _token, uint256 _version) internal returns (IOxidePortal) {
    return IOxidePortal(address(new MockPortal(IERC20(_token), _version)));
  }
}

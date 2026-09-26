// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;
import {Ownable} from "@oz/access/Ownable.sol";

import {ProverSubsidy} from "@periphery/ProverSubsidy.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {Errors} from "@periphery/Errors.sol";

contract ProverSubsidyTest is OxidePortalBase {
  ProverSubsidy internal ps;

  uint256 internal constant SUBSIDY_PER_PROVER_CLAIM = 0.05 ether;

  function setUp() public virtual override {
    super.setUp();
    ps = new ProverSubsidy(OWNER, address(portal));
    underlying.mint(address(ps), 1_000_000 ether);
  }

  function test_GivenConstructed_ThenImmutablesDerivedFromPortal() external view {
    assertEq(ps.PORTAL(), address(portal));
    assertEq(address(ps.TOKEN()), address(underlying));
    assertEq(ps.owner(), OWNER);
  }

  function test_GivenZeroOwner_WhenConstructed_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new ProverSubsidy(address(0), address(portal));
  }

  function test_GivenNonOwner_WhenSetProverClaimSubsidy_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    ps.setSubsidy(1 ether);
  }

  function test_GivenOwner_WhenSetProverClaimSubsidy_ThenRoundTrips() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    assertEq(ps.$subsidyPerProverClaim(), SUBSIDY_PER_PROVER_CLAIM);
  }

  function test_GivenProverBatch_ThenQuoteIsCountTimesFlatSubsidy() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    assertEq(ps.quoteSubsidy(3), 3 * SUBSIDY_PER_PROVER_CLAIM);
  }

  function test_GivenEmptyProverBatch_ThenZero() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    assertEq(ps.quoteSubsidy(0), 0);
  }

  function test_GivenZeroProverSubsidy_ThenZero() external {
    _setProverPricing(0);
    assertEq(ps.quoteSubsidy(3), 0);
  }

  function test_GivenInsufficientBudget_WhenProverBatchQuoted_ThenCappedToReserve() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    deal(address(underlying), address(ps), 2 * SUBSIDY_PER_PROVER_CLAIM);
    assertEq(ps.quoteSubsidy(2), 2 * SUBSIDY_PER_PROVER_CLAIM);
    assertEq(ps.quoteSubsidy(3), 2 * SUBSIDY_PER_PROVER_CLAIM);
  }

  function test_GivenAnyGasPrice_ThenProverQuoteDoesNotMove() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    _setGasPrice(1);
    uint256 atCheapGas = ps.quoteSubsidy(2);
    _setGasPrice(50 gwei);
    assertEq(ps.quoteSubsidy(2), atCheapGas);
    assertEq(atCheapGas, 2 * SUBSIDY_PER_PROVER_CLAIM);
  }

  function test_GivenNonPortalCaller_WhenPaySubsidyCalled_ThenReverts() external {
    vm.expectRevert(Errors.ProverSubsidy__UnauthorizedPortal.selector);
    ps.paySubsidy(1, address(this));
  }

  function test_GivenPortalCaller_WhenPaySubsidyCalled_ThenTransfersQuote() external {
    _setProverPricing(SUBSIDY_PER_PROVER_CLAIM);
    vm.prank(address(portal));
    uint256 paid = ps.paySubsidy(2, address(this));
    assertEq(paid, 2 * SUBSIDY_PER_PROVER_CLAIM);
    assertEq(underlying.balanceOf(address(this)), 2 * SUBSIDY_PER_PROVER_CLAIM);
  }

  function test_GivenZeroQuote_WhenPaySubsidyCalled_ThenNoTransfer() external {
    _setProverPricing(0);
    vm.prank(address(portal));
    uint256 paid = ps.paySubsidy(2, address(this));
    assertEq(paid, 0);
    assertEq(underlying.balanceOf(address(this)), 0);
  }

  function test_GivenNonOwner_WhenDefund_ThenReverts() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    ps.defund();
  }

  function test_GivenOwner_WhenDefund_ThenSweepsFullBalanceToOwner() external {
    uint256 reserve = underlying.balanceOf(address(ps));
    assertGt(reserve, 0, "the prover subsidy should start funded");
    uint256 ownerBefore = underlying.balanceOf(OWNER);

    vm.prank(OWNER);
    ps.defund();

    assertEq(underlying.balanceOf(address(ps)), 0, "reserve drained");
    assertEq(underlying.balanceOf(OWNER), ownerBefore + reserve, "reserve moved to owner");
  }

  function test_GivenEmptyReserve_WhenDefund_ThenNoop() external {
    vm.prank(OWNER);
    ps.defund();
    uint256 ownerBefore = underlying.balanceOf(OWNER);

    vm.prank(OWNER);
    ps.defund();

    assertEq(underlying.balanceOf(address(ps)), 0);
    assertEq(underlying.balanceOf(OWNER), ownerBefore);
  }

  function _setProverPricing(uint256 _subsidyPerProverClaim) internal {
    vm.prank(OWNER);
    ps.setSubsidy(_subsidyPerProverClaim);
  }

  function _setGasPrice(uint256 _gasPriceWei) internal {
    vm.fee(_gasPriceWei);
    vm.txGasPrice(_gasPriceWei);
  }
}

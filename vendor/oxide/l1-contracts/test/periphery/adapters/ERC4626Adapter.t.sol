// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC4626} from "@oz/interfaces/IERC4626.sol";
import {ERC4626Mock} from "@oz/mocks/token/ERC4626Mock.sol";
import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {Errors} from "@periphery/Errors.sol";
import {ERC4626Adapter} from "@periphery/adapters/ERC4626Adapter.sol";

contract ERC4626AdapterTest is Test {
  uint256 internal constant MAX = type(uint256).max;
  uint256 internal constant AMOUNT = 1000e18;
  uint256 internal constant FIXED_AMOUNT = 400e18;
  uint256 internal constant SEED_ASSETS = 1000e18;
  uint256 internal constant DONATED_ASSETS = 500e18;

  TestERC20 internal asset;
  ERC4626Mock internal vault;
  ERC4626Adapter internal adapter;
  address internal recipient = makeAddr("recipient");

  function setUp() external {
    asset = new TestERC20("Asset", "AST", address(this));
    vault = new ERC4626Mock(address(asset));
    adapter = new ERC4626Adapter();
    asset.mint(address(this), SEED_ASSETS);
    asset.approve(address(vault), SEED_ASSETS);
    vault.deposit(SEED_ASSETS, address(this));
    asset.mint(address(vault), DONATED_ASSETS);
  }

  function test_DepositOfMaxSendsSharesForTheWholeBalance() external {
    asset.mint(address(adapter), AMOUNT);
    uint256 shares = vault.previewDeposit(AMOUNT);

    adapter.erc4626Deposit(IERC4626(address(vault)), MAX, shares, recipient);

    assertEq(vault.balanceOf(recipient), shares);
    assertEq(asset.balanceOf(address(adapter)), 0);
  }

  function test_DepositOfAFixedAmountLeavesTheRestInTheAdapter() external {
    asset.mint(address(adapter), AMOUNT);
    uint256 shares = vault.previewDeposit(FIXED_AMOUNT);

    adapter.erc4626Deposit(IERC4626(address(vault)), FIXED_AMOUNT, 0, recipient);

    assertEq(vault.balanceOf(recipient), shares);
    assertEq(asset.balanceOf(address(adapter)), AMOUNT - FIXED_AMOUNT);
  }

  function test_RedeemOfMaxSendsTheAssetsForTheWholeShareBalance() external {
    uint256 shares = _fundAdapterWithShares(AMOUNT);
    uint256 assets = vault.previewRedeem(shares);

    adapter.erc4626Redeem(IERC4626(address(vault)), MAX, assets, recipient);

    assertEq(asset.balanceOf(recipient), assets);
    assertEq(vault.balanceOf(address(adapter)), 0);
  }

  function test_RedeemOfAFixedAmountLeavesTheRestInTheAdapter() external {
    uint256 shares = _fundAdapterWithShares(AMOUNT);
    uint256 assets = vault.previewRedeem(FIXED_AMOUNT);

    adapter.erc4626Redeem(IERC4626(address(vault)), FIXED_AMOUNT, 0, recipient);

    assertEq(asset.balanceOf(recipient), assets);
    assertEq(vault.balanceOf(address(adapter)), shares - FIXED_AMOUNT);
  }

  function test_AnOutputBelowTheMinReverts() external {
    asset.mint(address(adapter), AMOUNT);
    uint256 depositShares = vault.previewDeposit(AMOUNT);

    vm.expectRevert(
      abi.encodeWithSelector(Errors.ERC4626Adapter__InsufficientOutput.selector, depositShares, depositShares + 1)
    );
    adapter.erc4626Deposit(IERC4626(address(vault)), MAX, depositShares + 1, recipient);

    uint256 redeemAssets = vault.previewRedeem(_fundAdapterWithShares(AMOUNT));
    vm.expectRevert(
      abi.encodeWithSelector(Errors.ERC4626Adapter__InsufficientOutput.selector, redeemAssets, redeemAssets + 1)
    );
    adapter.erc4626Redeem(IERC4626(address(vault)), MAX, redeemAssets + 1, recipient);
  }

  function test_AZeroRecipientReverts() external {
    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.erc4626Deposit(IERC4626(address(vault)), MAX, 0, address(0));

    vm.expectRevert(Errors.CoreAdapter__ZeroRecipient.selector);
    adapter.erc4626Redeem(IERC4626(address(vault)), MAX, 0, address(0));
  }

  function _fundAdapterWithShares(uint256 _assets) internal returns (uint256 shares) {
    asset.mint(address(this), _assets);
    asset.approve(address(vault), _assets);
    shares = vault.deposit(_assets, address(adapter));
  }
}

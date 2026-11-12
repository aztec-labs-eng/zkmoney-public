// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {SweepGasCeilings} from "@test/helpers/SweepGasCeilings.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {DepositSIPA} from "@periphery/DepositSIPA.sol";
import {DepositSubsidy} from "@periphery/DepositSubsidy.sol";
import {ForwardingTable} from "@periphery/ForwardingTable.sol";
import {IOperationExecutor} from "@periphery/interfaces/IOperationExecutor.sol";
import {OperationExecutor} from "@periphery/OperationExecutor.sol";
import {SIPAFactory} from "@periphery/SIPAFactory.sol";
import {DAI, USDC, THREE_POOL} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";

import {StablecoinMocks} from "@test/helpers/StablecoinMocks.sol";
import {MintableToken} from "@test/mocks/MintableToken.sol";
import {MockCurve3Pool} from "@test/mocks/MockCurve3Pool.sol";
import {MockV3Aggregator} from "@test/mocks/MockV3Aggregator.sol";
import {ForwardingTableFixture, DEPOSIT_SWEEP_TIP} from "@test/helpers/ForwardingTableFixture.sol";
import {RelayerTransaction} from "@test/periphery/RelayerTransaction.sol";
import {Intents} from "@periphery/Intent.sol";

contract EscrowPortal {
  IERC20 public immutable UNDERLYING;
  uint256 public immutable ROLLUP_VERSION;

  uint256 internal nextIndex;

  constructor(IERC20 _underlying, uint256 _rollupVersion) {
    UNDERLYING = _underlying;
    ROLLUP_VERSION = _rollupVersion;
  }

  function deposit(bytes32 _recipientCommitment, uint256 _amount)
    external
    returns (bytes32 key, uint256 index, uint256 creditedAmount)
  {
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    index = nextIndex++;
    key = keccak256(abi.encode(_recipientCommitment, _amount, index));
    creditedAmount = _amount;
  }
}

contract DepositSubsidyMinCreditedAmountUsdcTest is Test {
  uint256 internal constant ROLLUP_VERSION = 7;
  uint256 internal constant AMOUNT_6DEC = 1000e6;
  uint256 internal constant CREDITED = AMOUNT_6DEC * 1e12 - DEPOSIT_SWEEP_TIP;
  bytes32 internal constant RECOVERY = bytes32(uint256(1));

  address internal owner = makeAddr("owner");
  address internal relayer = makeAddr("relayer");

  EscrowPortal internal daiPortal;
  ForwardingTable internal table;
  SIPAFactory internal sipaFactory;
  DepositSubsidy internal sm;

  function setUp() public {
    vm.chainId(1);
    MockCurve3Pool threePool = StablecoinMocks.install();
    vm.etch(address(DAI), address(new MintableToken("Dai Stablecoin", "DAI", 18)).code);
    threePool.setRate(address(DAI), 1e30);
    MintableToken(address(DAI)).mint(address(THREE_POOL), 1_000_000e18);

    daiPortal = new EscrowPortal(DAI, ROLLUP_VERSION);
    table = ForwardingTableFixture.deploy(owner, IOxidePortal(address(daiPortal)), makeAddr("tableBeneficiary"));
    sipaFactory = new SIPAFactory(owner);
    DepositSIPA implementation = new DepositSIPA();
    vm.startPrank(owner);
    sipaFactory.blessImplementation(address(implementation));
    sipaFactory.blessTable(table);
    vm.stopPrank();

    vm.fee(4e9);
    vm.txGasPrice(4e9);
    MockV3Aggregator feed = new MockV3Aggregator(8, 2500e8);
    sm = new DepositSubsidy(
      owner,
      address(daiPortal),
      IOperationExecutor(address(new OperationExecutor())),
      AggregatorV3Interface(address(feed)),
      sipaFactory,
      SweepGasCeilings.initial()
    );
    MintableToken(address(DAI)).mint(address(sm), 1_000_000e18);
  }

  function test_GivenAUsdcCreditBelowTheMinimum_ThenTheSweepLandsWithoutASubsidy() external {
    _setMinCreditedAmount(CREDITED + 1);
    uint256 relayerBefore = DAI.balanceOf(relayer);

    uint256 subsidy = _deployAndSweepUsdc();

    assertEq(subsidy, 0, "a swapped credit under the minimum must not be subsidized");
    assertEq(DAI.balanceOf(address(daiPortal)), CREDITED, "the swapped deposit still bridged");
    assertEq(DAI.balanceOf(relayer) - relayerBefore, DEPOSIT_SWEEP_TIP, "the relayer keeps the fee");
  }

  function test_GivenAUsdcCreditAtTheMinimum_ThenItIsPaid() external {
    _setMinCreditedAmount(CREDITED);

    uint256 subsidy = _deployAndSweepUsdc();

    assertGt(subsidy, 0, "a swapped credit that meets the minimum must be paid");
    assertEq(DAI.balanceOf(address(daiPortal)), CREDITED, "the credit is measured in the portal token");
  }

  function _deployAndSweepUsdc() internal returns (uint256) {
    bytes memory intent = abi.encode(bytes32(uint256(2)));
    address sipa = sipaFactory.predictSIPA(
      sipaFactory.implementationFor(Intents.DEPOSIT), keccak256(intent), RECOVERY, ROLLUP_VERSION, true, table
    );
    MintableToken(address(USDC)).mint(sipa, AMOUNT_6DEC);
    (uint256 subsidy,) = RelayerTransaction.send(
      relayer,
      sm,
      abi.encodeCall(
        DepositSubsidy.deployAndSweepForSubsidy,
        (table, Intents.DEPOSIT, RECOVERY, true, address(USDC), address(sm.EXECUTOR()), intent, "")
      )
    );
    return subsidy;
  }

  function _setMinCreditedAmount(uint256 _minCreditedAmount) internal {
    vm.prank(owner);
    sm.setDepositConfig(uint128(DEPOSIT_SWEEP_TIP), type(uint128).max, uint128(_minCreditedAmount));
  }
}

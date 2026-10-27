// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DAI} from "@periphery/ThreePoolLib.sol";
import {AggregatorV3Interface} from "@periphery/interfaces/AggregatorV3Interface.sol";
import {IOxideAccountFactory} from "@periphery/interfaces/IOxideAccountFactory.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";

import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MainnetForkFixture} from "@test/fork/MainnetForkFixture.sol";
import {SweepGasFixture} from "@test/periphery/SweepGasFixture.sol";
import {RegistrationTestBase} from "@test/periphery/registration/RegistrationTestBase.sol";
import {ForwardingTableFixture} from "@test/helpers/ForwardingTableFixture.sol";

interface IChainlinkProxy {
  function aggregator() external view returns (address);
}

abstract contract DaiRelayForkFixture is MainnetForkFixture, SweepGasFixture {
  AggregatorV3Interface internal constant CHAINLINK_ETH_USD =
    AggregatorV3Interface(0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419);
  IERC20 internal constant DAI_TOKEN = IERC20(address(DAI));

  address internal chainlinkAggregator;

  function setUp() public virtual override(OxidePortalBase, RegistrationTestBase) {
    _selectMainnetFork();
    super.setUp();

    portal = _buildPortal(address(DAI));
    forwardingTable = ForwardingTableFixture.deploy(OWNER, IOxidePortal(address(portal)), TABLE_BENEFICIARY);
    vm.prank(OWNER);
    sipaFactory.blessTable(forwardingTable);

    ethUsdFeed = CHAINLINK_ETH_USD;
    chainlinkAggregator = IChainlinkProxy(address(CHAINLINK_ETH_USD)).aggregator();
  }

  function _setupInbox() internal virtual override(OxidePortalBase, SweepGasFixture) {
    SweepGasFixture._setupInbox();
  }

  function _deployAccountFactory()
    internal
    virtual
    override(OxidePortalBase, RegistrationTestBase)
    returns (IOxideAccountFactory)
  {
    return RegistrationTestBase._deployAccountFactory();
  }

  function _dealDai(address _to, uint256 _amount) internal {
    deal(address(DAI), _to, DAI_TOKEN.balanceOf(_to) + _amount);
  }

  function _chainlinkTokenWeiPerEth() internal view returns (uint256) {
    (, int256 usdPerEth,,,) = CHAINLINK_ETH_USD.latestRoundData();
    return (uint256(usdPerEth) * 1e18) / 10 ** CHAINLINK_ETH_USD.decimals();
  }
}

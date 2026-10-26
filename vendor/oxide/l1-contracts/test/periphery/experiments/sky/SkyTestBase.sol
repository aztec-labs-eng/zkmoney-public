// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.27;

import {TestERC20} from "@aztec/mock/TestERC20.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {IVerifier} from "@aztec/core/interfaces/IVerifier.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {OxideConstants} from "@generated/OxideConstants.gen.sol";
import {OxidePortal} from "@core/OxidePortal.sol";
import {IOxidePortal} from "@core/interfaces/IOxidePortal.sol";
import {IExecutor} from "@core/interfaces/IExecutor.sol";
import {PlainWithdrawalSubsidy} from "@periphery/PlainWithdrawalSubsidy.sol";
import {SkyWithdrawalExecutor} from "@periphery/experiments/sky/SkyWithdrawalExecutor.sol";
import {SkyEscrowFactory} from "@periphery/experiments/sky/SkyEscrowFactory.sol";
import {SkyRoute} from "@periphery/experiments/sky/SkyTypes.sol";
import {IDaiUsds} from "@periphery/experiments/sky/interfaces/IDaiUsds.sol";
import {ISUsds} from "@periphery/experiments/sky/interfaces/ISUsds.sol";
import {OxidePortalBase} from "@test/core/OxidePortalBase.t.sol";
import {MockDaiUsds} from "@test/periphery/experiments/sky/mocks/MockDaiUsds.sol";
import {MockSUsds} from "@test/periphery/experiments/sky/mocks/MockSUsds.sol";

abstract contract SkyHelpers is OxidePortalBase {
  bytes32 internal constant SUSDS_L2_TOKEN = bytes32(uint256(0x5005D5));

  uint256 internal withdrawalCount;

  function _newPortal(address _underlying, bytes32 _l2Token) internal returns (OxidePortal portal_) {
    pendingL2Token = _l2Token;
    portal_ = new OxidePortal(
      teeRegistry,
      IERC20(_underlying),
      IRegistry(address(registry)),
      ROLLUP_VERSION,
      OxidePortal.RefundVerifiers({
        frozenNotes: IVerifier(address(frozenNotesRefundVerifier)),
        frozenDeposits: IVerifier(address(frozenDepositsRefundVerifier)),
        unprocessedDeposit: IVerifier(address(unprocessedDepositRefundVerifier))
      }),
      TX_AMOUNT_CAP,
      RATE,
      GLOBAL_LIMIT
    );
    pendingL2Token = L2_TOKEN;
  }

  function _withdrawArgs(
    OxidePortal _portal,
    address _executor,
    uint256 _amount,
    bytes memory _userPayload,
    bytes memory _relayerPayload
  ) internal returns (IOxidePortal.WithdrawArgs memory args) {
    bytes32 withdrawalId = keccak256(abi.encode("sky-withdrawal", withdrawalCount++));
    IOxidePortal.WithdrawContent memory content = IOxidePortal.WithdrawContent({
      executor: _executor,
      userPayloadHash: Hash.sha256ToField(_userPayload),
      amount: _amount,
      proverTip: 0,
      randomness: uint256(withdrawalId)
    });
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor({actor: _portal.L2_TOKEN(), version: ROLLUP_VERSION}),
      recipient: DataStructures.L1Actor({actor: address(_portal), chainId: block.chainid}),
      content: Hash.sha256ToField(
        abi.encodeWithSignature(
          "withdraw(address,bytes32,uint256,uint256,uint256)",
          content.executor,
          content.userPayloadHash,
          content.amount,
          content.proverTip,
          content.randomness
        )
      )
    });
    bytes32 digest = _teeWithdrawalFinalDigest(DEFAULT_ARCHIVE_ROOT, withdrawalId, Hash.sha256ToField(message));
    args = IOxidePortal.WithdrawArgs({
      content: content,
      userPayload: _userPayload,
      relayerPayload: _relayerPayload,
      epochNumber: 2,
      numCheckpointsInEpoch: 1,
      leafIndex: 0,
      path: _dummyPath(),
      checkpointNumber: DEFAULT_CHECKPOINT_NUMBER,
      withdrawalId: withdrawalId,
      teeSignature: _signTee(TEST_TEE_PK, digest)
    });
  }

  function _frozenNotesRefundArgs(OxidePortal _portal, address _executor, uint256 _amount, bytes memory _userPayload)
    internal
    returns (IOxidePortal.RefundFrozenNotesArgs memory args)
  {
    bytes32[] memory nullifiers = new bytes32[](1);
    nullifiers[0] = keccak256(abi.encode("sky-refund", withdrawalCount++));

    bytes32[] memory publicInputs = new bytes32[](OxideConstants.FROZEN_NOTES_REFUND_PUBLIC_INPUT_COUNT);
    publicInputs[0] = bytes32(block.chainid);
    publicInputs[1] = bytes32(_portal.ROLLUP_VERSION());
    publicInputs[2] = bytes32(uint256(uint160(address(_portal))));
    publicInputs[3] = _portal.L2_TOKEN();
    publicInputs[4] = _portal.$freezeArchive();
    publicInputs[5] = bytes32(_amount);
    publicInputs[6] = bytes32(uint256(uint160(_executor)));
    publicInputs[7] = Hash.sha256ToField(_userPayload);
    publicInputs[8] = nullifiers[0];

    args = IOxidePortal.RefundFrozenNotesArgs({
      executor: _executor,
      userPayload: _userPayload,
      relayerPayload: abi.encodePacked(address(0)),
      amount: _amount,
      nullifiers: nullifiers,
      proof: hex"c0ffee",
      teeSignature: _signTee(TEST_TEE_PK, _teeFrozenNotesRefundFinalDigest(publicInputs))
    });
  }
}

abstract contract SkyTestBase is SkyHelpers {
  address internal constant RECIPIENT = address(0xBEEF);
  address internal constant RELAYER = address(0xCAFE);

  TestERC20 internal dai;
  TestERC20 internal usds;
  MockSUsds internal sUsds;
  MockDaiUsds internal converter;

  OxidePortal internal sUsdsPortal;
  SkyWithdrawalExecutor internal skyExecutor;
  PlainWithdrawalSubsidy internal skySubsidy;
  SkyEscrowFactory internal escrowFactory;

  function setUp() public virtual override {
    super.setUp();

    dai = underlying;
    usds = new TestERC20("USDS Stablecoin", "USDS", address(this));
    sUsds = new MockSUsds(usds, address(this));
    converter = new MockDaiUsds(dai, usds, address(this));
    dai.addMinter(address(converter));
    usds.addMinter(address(converter));
    usds.addMinter(address(sUsds));

    _registerSigner();

    sUsdsPortal = _newPortal(address(sUsds), SUSDS_L2_TOKEN);

    skyExecutor = new SkyWithdrawalExecutor(sUsdsPortal, _skyRoute(), OWNER, ethUsdFeed);
    skySubsidy = skyExecutor.SUBSIDY();
    escrowFactory = new SkyEscrowFactory(_skyRoute(), portal, sUsdsPortal, skyExecutor);
  }

  function _skyRoute() internal view returns (SkyRoute memory) {
    return SkyRoute({
      dai: IERC20(address(dai)),
      usds: IERC20(address(usds)),
      sUsds: ISUsds(address(sUsds)),
      daiUsds: IDaiUsds(address(converter))
    });
  }

  function _mintShares(address _to, uint256 _usdsAmount) internal returns (uint256 shares) {
    usds.mint(address(this), _usdsAmount);
    usds.approve(address(sUsds), _usdsAmount);
    shares = sUsds.deposit(_usdsAmount, _to);
  }

  function _fundSUsdsPortal(uint256 _shares) internal {
    deal(address(sUsds), address(sUsdsPortal), sUsds.balanceOf(address(sUsdsPortal)) + _shares, true);
  }

  function _skyWithdrawArgs(uint256 _shares, bytes memory _userPayload, bytes memory _relayerPayload)
    internal
    returns (IOxidePortal.WithdrawArgs memory)
  {
    return _withdrawArgs(sUsdsPortal, address(skyExecutor), _shares, _userPayload, _relayerPayload);
  }

  function _daiWithdrawArgs(uint256 _amount, bytes memory _userPayload, bytes memory _relayerPayload)
    internal
    returns (IOxidePortal.WithdrawArgs memory)
  {
    return _withdrawArgs(portal, address(plainWithdrawalExecutor), _amount, _userPayload, _relayerPayload);
  }

  function _configureSkySubsidy(uint256 _maxSubsidy) internal {
    vm.startPrank(OWNER);
    for (uint256 flow = 0; flow < 4; flow++) {
      skySubsidy.setFlowPricing(
        IExecutor.Flow(flow), PlainWithdrawalSubsidy.FlowPricing({startPriceWei: 0, maxSubsidy: _maxSubsidy})
      );
    }
    vm.stopPrank();
    dai.mint(address(skySubsidy), 100 * _maxSubsidy);
    vm.fee(10 gwei);
    vm.txGasPrice(10 gwei);
  }
}

contract MockERC1271Account is IERC1271 {
  address public immutable SIGNER;

  constructor(address _signer) {
    SIGNER = _signer;
  }

  function isValidSignature(bytes32 _hash, bytes calldata _signature) external view returns (bytes4) {
    (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(_hash, _signature);
    if (err == ECDSA.RecoverError.NoError && recovered == SIGNER) {
      return IERC1271.isValidSignature.selector;
    }
    return bytes4(0xffffffff);
  }
}

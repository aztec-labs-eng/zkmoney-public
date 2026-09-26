// SPDX-License-Identifier: MIT
// adapted from solarity's affine ECDSA384
// https://github.com/dl-solarity/solidity-lib/blob/b94757194de6436062c2d68118c0352be84ac4be/contracts/libs/crypto/ECDSA384.sol
pragma solidity ^0.8.27;

import {U384} from "@solarity/libs/crypto/ECDSA384.sol";
import {MemoryUtils} from "@solarity/libs/utils/MemoryUtils.sol";

library ECDSA384Jacobian {
  using U384 for *;
  using MemoryUtils for *;

  struct Parameters {
    bytes a;
    bytes b;
    bytes gx;
    bytes gy;
    bytes p;
    bytes n;
    bytes lowSmax;
  }

  struct _Parameters {
    uint256 a;
    uint256 b;
    uint256 gx;
    uint256 gy;
    uint256 p;
    uint256 n;
    uint256 lowSmax;
  }

  struct _Inputs {
    uint256 r;
    uint256 s;
    uint256 x;
    uint256 y;
  }

  struct Pt {
    uint256 X;
    uint256 Y;
    uint256 Z;
  }

  function verify(
    Parameters memory curveParams_,
    bytes memory hashedMessage_,
    bytes memory signature_,
    bytes memory pubKey_
  ) internal view returns (bool) {
    unchecked {
      _Inputs memory inputs_;
      (inputs_.r, inputs_.s) = U384.init2(signature_);
      (inputs_.x, inputs_.y) = U384.init2(pubKey_);

      _Parameters memory params_ = _Parameters({
        a: curveParams_.a.init(),
        b: curveParams_.b.init(),
        gx: curveParams_.gx.init(),
        gy: curveParams_.gy.init(),
        p: curveParams_.p.init(),
        n: curveParams_.n.init(),
        lowSmax: curveParams_.lowSmax.init()
      });

      uint256 callP = U384.initCall(params_.p);

      if (
        U384.eqInteger(inputs_.r, 0) || U384.cmp(inputs_.r, params_.n) >= 0 || U384.eqInteger(inputs_.s, 0)
          || U384.cmp(inputs_.s, params_.lowSmax) > 0
      ) {
        return false;
      }

      if (!_isOnCurve(callP, params_.p, params_.a, params_.b, inputs_.x, inputs_.y)) {
        return false;
      }

      {
        uint256 hLen = hashedMessage_.length;
        if (hLen < 48) {
          bytes memory tmp_ = new bytes(48);
          MemoryUtils.unsafeCopy(hashedMessage_.getDataPointer(), tmp_.getDataPointer() + 48 - hLen, hLen);
          hashedMessage_ = tmp_;
        }
      }

      uint256 callN = U384.initCall(params_.n);
      uint256 scalar1 = U384.moddiv(callN, hashedMessage_.init(), inputs_.s, params_.n);
      uint256 scalar2 = U384.moddiv(callN, inputs_.r, inputs_.s, params_.n);

      Pt memory R = _doubleScalarMul(callP, params_, inputs_, scalar1, scalar2);

      if (U384.eqInteger(R.Z, 0)) {
        return false;
      }

      uint256 zInv = U384.modinv(callP, R.Z, params_.p);
      uint256 zInv2 = U384.modexp(callP, zInv, 2);
      uint256 xAff = U384.modmul(callP, R.X, zInv2);

      U384.modAssign(callN, xAff, params_.n);
      return U384.eq(xAff, inputs_.r);
    }
  }

  function _isOnCurve(uint256 call, uint256 p, uint256 a, uint256 b, uint256 x, uint256 y) private view returns (bool) {
    unchecked {
      if (U384.eqInteger(x, 0) || U384.eq(x, p) || U384.eqInteger(y, 0) || U384.eq(y, p)) {
        return false;
      }

      uint256 LHS = U384.modexp(call, y, 2);
      uint256 RHS = U384.modexp(call, x, 3);

      if (!U384.eqInteger(a, 0)) {
        RHS = U384.modadd(RHS, U384.modmul(call, x, a), p);
      }

      if (!U384.eqInteger(b, 0)) {
        RHS = U384.modadd(RHS, b, p);
      }

      return U384.eq(LHS, RHS);
    }
  }

  function _doubleScalarMul(
    uint256 call,
    _Parameters memory params,
    _Inputs memory inputs,
    uint256 scalar1,
    uint256 scalar2
  ) private view returns (Pt memory R) {
    unchecked {
      uint256[2][64] memory points = _precomputeAffineTable(call, params.p, params.gx, params.gy, inputs.x, inputs.y);

      R = Pt({X: U384.init(0), Y: U384.init(1), Z: U384.init(0)});

      _scalarLoopHi(call, params.p, points, R, scalar1, scalar2);
      _scalarLoopLo(call, params.p, points, R, scalar1, scalar2);
    }
  }

  function _scalarLoopHi(
    uint256 call,
    uint256 p,
    uint256[2][64] memory points,
    Pt memory R,
    uint256 scalar1,
    uint256 scalar2
  ) private view {
    unchecked {
      uint256 s1;
      uint256 s2;
      assembly {
        s1 := mload(scalar1)
        s2 := mload(scalar2)
      }

      _doubleJ(call, p, R);

      uint256 mask = ((s1 >> 183) << 3) | (s2 >> 183);
      if (mask != 0) {
        _addMixedJ(call, p, R, points[mask][0], points[mask][1]);
      }

      for (uint256 word = 4; word <= 184; word += 3) {
        _doubleJ(call, p, R);
        _doubleJ(call, p, R);
        _doubleJ(call, p, R);

        mask = (((s1 >> (184 - word)) & 0x07) << 3) | ((s2 >> (184 - word)) & 0x07);

        if (mask != 0) {
          _addMixedJ(call, p, R, points[mask][0], points[mask][1]);
        }
      }
    }
  }

  function _scalarLoopLo(
    uint256 call,
    uint256 p,
    uint256[2][64] memory points,
    Pt memory R,
    uint256 scalar1,
    uint256 scalar2
  ) private view {
    unchecked {
      uint256 s1;
      uint256 s2;
      assembly {
        s1 := mload(add(scalar1, 0x20))
        s2 := mload(add(scalar2, 0x20))
      }

      _doubleJ(call, p, R);

      uint256 mask = ((s1 >> 255) << 3) | (s2 >> 255);
      if (mask != 0) {
        _addMixedJ(call, p, R, points[mask][0], points[mask][1]);
      }

      for (uint256 word = 4; word <= 256; word += 3) {
        _doubleJ(call, p, R);
        _doubleJ(call, p, R);
        _doubleJ(call, p, R);

        mask = (((s1 >> (256 - word)) & 0x07) << 3) | ((s2 >> (256 - word)) & 0x07);

        if (mask != 0) {
          _addMixedJ(call, p, R, points[mask][0], points[mask][1]);
        }
      }
    }
  }

  function _precomputeAffineTable(uint256 call, uint256 p, uint256 gx, uint256 gy, uint256 hx, uint256 hy)
    private
    view
    returns (uint256[2][64] memory points)
  {
    unchecked {
      Pt[64] memory jac;
      jac[0x01] = Pt({X: hx.copy(), Y: hy.copy(), Z: U384.init(1)});
      jac[0x08] = Pt({X: gx.copy(), Y: gy.copy(), Z: U384.init(1)});

      for (uint256 i = 0; i < 8; ++i) {
        for (uint256 j = 0; j < 8; ++j) {
          if (i + j < 2) continue;
          if ((i == 0 && j == 1) || (i == 1 && j == 0)) continue;

          uint256 maskTo = (i << 3) | j;
          uint256 maskFrom = i != 0 ? ((i - 1) << 3) | j : (i << 3) | (j - 1);

          jac[maskTo] = Pt({X: jac[maskFrom].X.copy(), Y: jac[maskFrom].Y.copy(), Z: jac[maskFrom].Z.copy()});

          if (i != 0) {
            _addMixedJ(call, p, jac[maskTo], gx, gy);
          } else {
            _addMixedJ(call, p, jac[maskTo], hx, hy);
          }
        }
      }

      uint256[64] memory prefix;
      prefix[0] = U384.init(1);
      for (uint256 mask = 1; mask < 64; ++mask) {
        prefix[mask] = U384.modmul(call, prefix[mask - 1], jac[mask].Z);
      }

      uint256 inv = U384.modinv(call, prefix[63], p);

      for (uint256 k = 0; k < 63; ++k) {
        uint256 mask = 63 - k;
        uint256 zInv = U384.modmul(call, inv, prefix[mask - 1]);
        inv = U384.modmul(call, inv, jac[mask].Z);

        uint256 zInv2 = U384.modexp(call, zInv, 2);
        points[mask][0] = U384.modmul(call, jac[mask].X, zInv2);
        uint256 zInv3 = U384.modmul(call, zInv, zInv2);
        points[mask][1] = U384.modmul(call, jac[mask].Y, zInv3);
      }
    }
  }

  function _addMixedJ(uint256 call, uint256 p, Pt memory A, uint256 Bx, uint256 By) private view {
    unchecked {
      if (U384.eqInteger(A.Z, 0)) {
        A.X = Bx.copy();
        A.Y = By.copy();
        A.Z = U384.init(1);
        return;
      }

      uint256[6] memory s;

      s[0] = U384.modexp(call, A.Z, 2);

      {
        uint256 U2 = U384.modmul(call, Bx, s[0]);
        uint256 S2 = U384.modmul(call, By, A.Z);
        S2 = U384.modmul(call, S2, s[0]);

        if (U384.eq(U2, A.X)) {
          if (U384.eq(S2, A.Y)) {
            _doubleJ(call, p, A);
            return;
          }
          A.X = U384.init(0);
          A.Y = U384.init(1);
          A.Z = U384.init(0);
          return;
        }

        s[1] = U384.modsub(U2, A.X, p);
        s[2] = U384.modsub(S2, A.Y, p);
        U384.modaddAssign(s[2], s[2].copy(), p);
      }

      uint256 HH = U384.modexp(call, s[1], 2);
      s[3] = U384.modshl1(U384.modshl1(HH, p), p);
      s[4] = U384.modmul(call, s[1], s[3]);
      s[5] = U384.modmul(call, A.X, s[3]);

      {
        uint256 newZ = U384.modexp(call, U384.modadd(A.Z, s[1], p), 2);
        U384.modsubAssign(newZ, s[0], p);
        U384.modsubAssign(newZ, HH, p);
        A.Z = newZ;
      }

      {
        uint256 rSq = U384.modexp(call, s[2], 2);
        A.X = U384.modsub(rSq, s[4], p);
        U384.modsubAssign(A.X, U384.modshl1(s[5], p), p);
      }

      {
        uint256 twoAyJ = U384.modshl1(U384.modmul(call, A.Y, s[4]), p);
        A.Y = U384.modmul(call, s[2], U384.modsub(s[5], A.X, p));
        U384.modsubAssign(A.Y, twoAyJ, p);
      }
    }
  }

  function _doubleJ(uint256 call, uint256 p, Pt memory P) private view {
    unchecked {
      if (U384.eqInteger(P.Z, 0)) {
        return;
      }
      if (U384.eqInteger(P.Y, 0)) {
        P.X = U384.init(0);
        P.Y = U384.init(1);
        P.Z = U384.init(0);
        return;
      }

      uint256[5] memory s;

      s[0] = U384.modexp(call, P.Z, 2);
      s[1] = U384.modexp(call, P.Y, 2);

      {
        uint256 yPlusZSq = U384.modexp(call, U384.modadd(P.Y, P.Z, p), 2);
        U384.modsubAssign(yPlusZSq, s[1], p);
        U384.modsubAssign(yPlusZSq, s[0], p);
        P.Z = yPlusZSq;
      }

      {
        uint256 t1 = U384.modsub(P.X, s[0], p);
        uint256 t2 = U384.modadd(P.X, s[0], p);
        s[2] = U384.modmul(call, t1, t2);
        uint256 alphaCopy = s[2].copy();
        U384.modaddAssign(s[2], alphaCopy, p);
        U384.modaddAssign(s[2], alphaCopy, p);
      }

      {
        uint256 beta = U384.modmul(call, P.X, s[1]);
        uint256 twoBeta = U384.modshl1(beta, p);
        s[3] = U384.modshl1(twoBeta, p);
        uint256 eightBeta = U384.modshl1(s[3], p);
        uint256 alphaSq = U384.modexp(call, s[2], 2);
        s[4] = U384.modsub(alphaSq, eightBeta, p);
      }

      {
        uint256 diff = U384.modsub(s[3], s[4], p);
        uint256 newY = U384.modmul(call, s[2], diff);
        uint256 gammaSq = U384.modexp(call, s[1], 2);
        uint256 eightGammaSq = U384.modshl1(U384.modshl1(U384.modshl1(gammaSq, p), p), p);
        U384.modsubAssign(newY, eightGammaSq, p);
        P.Y = newY;
      }

      P.X = s[4];
    }
  }

  function _addJ(uint256 call, uint256 p, Pt memory A, Pt memory B) private view {
    unchecked {
      if (U384.eqInteger(A.Z, 0)) {
        A.X = B.X.copy();
        A.Y = B.Y.copy();
        A.Z = B.Z.copy();
        return;
      }
      if (U384.eqInteger(B.Z, 0)) {
        return;
      }

      uint256[9] memory s;
      s[0] = U384.modexp(call, A.Z, 2);
      s[1] = U384.modexp(call, B.Z, 2);

      {
        uint256 U2 = U384.modmul(call, B.X, s[0]);
        s[2] = U384.modmul(call, A.X, s[1]);

        uint256 S2 = U384.modmul(call, B.Y, A.Z);
        S2 = U384.modmul(call, S2, s[0]);
        s[3] = U384.modmul(call, A.Y, B.Z);
        s[3] = U384.modmul(call, s[3], s[1]);

        if (U384.eq(s[2], U2)) {
          if (U384.eq(s[3], S2)) {
            _doubleJ(call, p, A);
            return;
          }
          A.X = U384.init(0);
          A.Y = U384.init(1);
          A.Z = U384.init(0);
          return;
        }

        s[4] = U384.modsub(U2, s[2], p);
        s[5] = U384.modsub(S2, s[3], p);
        U384.modaddAssign(s[5], s[5].copy(), p);
      }

      s[6] = U384.modexp(call, U384.modshl1(s[4], p), 2);
      s[7] = U384.modmul(call, s[4], s[6]);
      s[8] = U384.modmul(call, s[2], s[6]);

      {
        uint256 rrSq = U384.modexp(call, s[5], 2);
        A.X = U384.modsub(rrSq, s[7], p);
        U384.modsubAssign(A.X, U384.modshl1(s[8], p), p);
      }

      {
        A.Y = U384.modmul(call, s[5], U384.modsub(s[8], A.X, p));
        uint256 twoS1J = U384.modshl1(U384.modmul(call, s[3], s[7]), p);
        U384.modsubAssign(A.Y, twoS1J, p);
      }

      {
        uint256 zSumSq = U384.modexp(call, U384.modadd(A.Z, B.Z, p), 2);
        U384.modsubAssign(zSumSq, s[0], p);
        U384.modsubAssign(zSumSq, s[1], p);
        A.Z = U384.modmul(call, zSumSq, s[4]);
      }
    }
  }
}

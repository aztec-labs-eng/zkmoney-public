// NameClaim eligibility: replicates, byte-for-byte, the L1 artifacts the claim rests on --
// the Registry's EIP-712 NameClaim digest and the OxideAccountFactory's CREATE2 clone address --
// so the FPC can verify them in-circuit from public constants plus witnesses.

use aztec::protocol::{address::AztecAddress, traits::ToField};
use keccak256::keccak256;

global BINDING_PREFIX: str<22> = "OBSIDION_L2_BINDING_V1";
global NAME_CLAIM_TYPE: str<78> = "NameClaim(bytes32 nameHash,address userAddress,uint256 nonce,uint256 deadline)";

/// Ethereum address of an uncompressed secp256k1 pubkey: keccak(x || y)[12..32].
pub fn eth_address_from_pubkey(pub_key_x: [u8; 32], pub_key_y: [u8; 32]) -> [u8; 20] {
    let mut preimage: [u8; 64] = [0; 64];
    for i in 0..32 {
        preimage[i] = pub_key_x[i];
        preimage[32 + i] = pub_key_y[i];
    }
    let digest = keccak256(preimage, 64);
    let mut addr: [u8; 20] = [0; 20];
    for i in 0..20 {
        addr[i] = digest[12 + i];
    }
    addr
}

/// CREATE2 address of the OxideAccount for `bootstrap`: an OZ ERC-1167 clone of `implementation`
/// with `abi.encode(bootstrap)` as immutable args, salt 0, deployed by `factory`
/// (OxideAccountFactory.predictAccountAddress).
pub fn derive_oxide_account(
    factory: [u8; 20],
    implementation: [u8; 20],
    bootstrap: [u8; 20],
) -> [u8; 20] {
    // OZ Clones._cloneCodeWithImmutableArgs with 32-byte args:
    // 0x61 || uint16(0x2d + 32) || 3d81600a3d39f3363d3d373d3d3d363d73 || impl ||
    // 5af43d82803e903d91602b57fd5bf3 || abi.encode(bootstrap)
    let mut init_code: [u8; 87] = [0; 87];
    init_code[0] = 0x61;
    init_code[1] = 0x00;
    init_code[2] = 0x4d;
    let prefix: [u8; 17] = [
        0x3d, 0x81, 0x60, 0x0a, 0x3d, 0x39, 0xf3, 0x36, 0x3d, 0x3d, 0x37, 0x3d, 0x3d, 0x3d, 0x36,
        0x3d, 0x73,
    ];
    for i in 0..17 {
        init_code[3 + i] = prefix[i];
    }
    for i in 0..20 {
        init_code[20 + i] = implementation[i];
    }
    let suffix: [u8; 15] =
        [0x5a, 0xf4, 0x3d, 0x82, 0x80, 0x3e, 0x90, 0x3d, 0x91, 0x60, 0x2b, 0x57, 0xfd, 0x5b, 0xf3];
    for i in 0..15 {
        init_code[40 + i] = suffix[i];
    }
    // abi.encode(address): 12 zero bytes then the 20 address bytes.
    for i in 0..20 {
        init_code[67 + i] = bootstrap[i];
    }
    let init_code_hash = keccak256(init_code, 87);

    let mut create2: [u8; 85] = [0; 85];
    create2[0] = 0xff;
    for i in 0..20 {
        create2[1 + i] = factory[i];
    }
    // salt = bytes32(0): create2[21..53] stay zero.
    for i in 0..32 {
        create2[53 + i] = init_code_hash[i];
    }
    let digest = keccak256(create2, 85);
    let mut addr: [u8; 20] = [0; 20];
    for i in 0..20 {
        addr[i] = digest[12 + i];
    }
    addr
}

/// The EIP-712 digest the domain owner signed (Registry._consumeDomainAuth):
/// keccak(0x1901 || domainSeparator || keccak(typehash || nameHash || pad32(account) || nonce || deadline)).
pub fn name_claim_digest(
    domain_separator: [u8; 32],
    name_hash: [u8; 32],
    account: [u8; 20],
    nonce: [u8; 32],
    deadline: [u8; 32],
) -> [u8; 32] {
    let type_bytes = NAME_CLAIM_TYPE.as_bytes();
    let typehash = keccak256(type_bytes, 78);

    let mut struct_preimage: [u8; 160] = [0; 160];
    for i in 0..32 {
        struct_preimage[i] = typehash[i];
        struct_preimage[32 + i] = name_hash[i];
        struct_preimage[96 + i] = nonce[i];
        struct_preimage[128 + i] = deadline[i];
    }
    // address right-aligned in the [64..96] slot
    for i in 0..20 {
        struct_preimage[76 + i] = account[i];
    }
    let struct_hash = keccak256(struct_preimage, 160);

    let mut digest_preimage: [u8; 66] = [0; 66];
    digest_preimage[0] = 0x19;
    digest_preimage[1] = 0x01;
    for i in 0..32 {
        digest_preimage[2 + i] = domain_separator[i];
        digest_preimage[34 + i] = struct_hash[i];
    }
    keccak256(digest_preimage, 66)
}

/// The message the user's bootstrap key signs to bind their L2 account:
/// keccak("OBSIDION_L2_BINDING_V1" || l2_address_be32).
pub fn binding_digest(user: AztecAddress) -> [u8; 32] {
    let mut preimage: [u8; 54] = [0; 54];
    let prefix = BINDING_PREFIX.as_bytes();
    for i in 0..22 {
        preimage[i] = prefix[i];
    }
    let user_bytes: [u8; 32] = user.to_field().to_be_bytes();
    for i in 0..32 {
        preimage[22 + i] = user_bytes[i];
    }
    keccak256(preimage, 54)
}

/// A Field holding a 20-byte big-endian ETH address -> bytes.
pub fn field_to_eth_address(f: Field) -> [u8; 20] {
    let bytes: [u8; 32] = f.to_be_bytes();
    let mut addr: [u8; 20] = [0; 20];
    for i in 0..20 {
        addr[i] = bytes[12 + i];
    }
    addr
}

/// Two 16-byte halves -> bytes32.
pub fn fields_to_bytes32(hi: Field, lo: Field) -> [u8; 32] {
    let hi_bytes: [u8; 16] = hi.to_be_bytes();
    let lo_bytes: [u8; 16] = lo.to_be_bytes();
    let mut out: [u8; 32] = [0; 32];
    for i in 0..16 {
        out[i] = hi_bytes[i];
        out[16 + i] = lo_bytes[i];
    }
    out
}

/// 20 address bytes -> Field (big-endian).
pub fn eth_address_to_field(addr: [u8; 20]) -> Field {
    let mut f: Field = 0;
    for i in 0..20 {
        f = f * 256 + addr[i] as Field;
    }
    f
}

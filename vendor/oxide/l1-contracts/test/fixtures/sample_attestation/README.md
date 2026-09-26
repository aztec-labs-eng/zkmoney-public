# Sample Nitro attestation — oxide-tee enclave

This bundle is a single live attestation pulled from a running staging enclave
on 2026-05-28. It contains the raw COSE_Sign1
document plus the cabundle and signing certificate broken out as PEM/DER for
convenience.

## Files

| File                         | What it is                                                                |
| ---------------------------- | ------------------------------------------------------------------------- |
| `attestation.cose`           | Raw bytes of the AWS-Nitro COSE_Sign1 document — what NSM emits           |
| `attestation.b64`            | Same bytes, base64 (this is what the RPC returns in `result.attestation`) |
| `rpc_result.json`            | Full `getAttestation` JSON response (attestation + pubkeys + eth address) |
| `payload.json`               | The decoded inner payload of the COSE_Sign1 (PCRs, user_data, etc.)       |
| `cose_protected_header.json` | Decoded protected header (algorithm = ES384)                              |
| `certificate.{der,pem}`      | Leaf signing cert — what signs the COSE_Sign1                             |
| `cabundle/NN.{der,pem}`      | Cert chain in array order from the payload (root → instance CA)           |
| `cabundle.pem`               | Same cabundle, concatenated PEM, for `openssl verify -untrusted`          |
| `extract.mjs`                | The script used to produce all the above                                  |

## How to fetch a fresh one yourself

The proxy is plain HTTP. Wire format on `POST /rpc` is `[4-byte BE length][JSON]`,
where the JSON for this call is just `{"method":"getAttestation"}`. The response
is the same length-prefixed framing wrapping a JSON envelope.

The fastest way is just to run `node extract.mjs` in this directory (point it at
the right URL via `ENCLAVE_URL=...`). With curl + xxd it's also a one-liner; ask
if you'd like one.

## Cert chain sanity check

```
openssl verify -CAfile cabundle/00.pem -untrusted cabundle.pem certificate.pem
# → certificate.pem: OK
```

`cabundle/00.pem` is the AWS Nitro root (`CN=aws.nitro-enclaves`). It's
self-signed and matches the published root at
<https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip> — pin
that root, don't trust the one shipped in the document.

## What's in `user_data` (the custom commitment)

The `user_data` field of the attestation document is a **32-byte SHA-256** over
a deterministic preimage that binds the enclave's keys to the portal it serves.
Both the enclave (when calling NSM) and the verifier (when checking the
attestation) recompute the exact same preimage and compare.

### Preimage layout (140 bytes total, no separators)

| Field            | Size     | Notes                  |
| ---------------- | -------- | ---------------------- |
| Domain prefix    | 12 bytes | ASCII `"oxide-tee/v1"` |
| Signing pubkey X | 32 bytes | secp256k1, big-endian  |
| Signing pubkey Y | 32 bytes | secp256k1, big-endian  |
| Enc pubkey X     | 32 bytes | P-256, big-endian      |
| Enc pubkey Y     | 32 bytes | P-256, big-endian      |

Then `user_data = SHA-256(preimage)`.

### Reference implementation

```ts
// yarn-project/oxide-lib/src/attestation/user_data.ts
export const ATTESTATION_USER_DATA_DOMAIN = Buffer.from("oxide-tee/v1");

export function serializeUserData(userData: UserData): Buffer {
  return Buffer.concat([
    ATTESTATION_USER_DATA_DOMAIN,
    userData.publicKeyX.toBuffer(),
    userData.publicKeyY.toBuffer(),
    userData.encPubKeyX.toBuffer(),
    userData.encPubKeyY.toBuffer(),
  ]);
}

export function computeAttestationUserData(userData: UserData): Buffer {
  return sha256(serializeUserData(userData));
}
```

The `nonce` and `public_key` fields in the COSE payload are not used (the
"public key" the enclave cares about lives inside `user_data`). `nonce` is
`null` in this build but a verifier should treat it as caller-supplied if you
ever start providing one — keep it unconstrained or whitelisted.

## Live values in this sample

- Module ID: `i-0950004639725a21a-enc019e6e1d00c8d180`
- Timestamp: `2026-05-28T10:24:24.046Z`
- Signing eth address: `0x63cFD76CdA78c8b4b77541e6962343BC5c96c8AE`
- `user_data` (hex): `2b524bb4a746675d462c482e415f9dea60bc0e0c31ef85cc7207f890134c5fd1`

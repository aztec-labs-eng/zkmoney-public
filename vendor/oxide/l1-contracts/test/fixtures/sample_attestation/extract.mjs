import { decode } from '/mnt/user-data/alvaro/oxide_poc/aztec_packages/noir/noir-repo/node_modules/cbor2/lib/index.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const URL = process.env.ENCLAVE_URL ?? 'http://localhost:8080/rpc';
const OUT = process.env.OUT ?? '/tmp/sample-attestation';

mkdirSync(`${OUT}/cabundle`, { recursive: true });

// ---- 1. Frame and POST a getAttestation RPC ----
function frame(s) {
  const body = Buffer.from(s, 'utf8');
  const out = Buffer.alloc(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}
function unframe(buf) {
  const len = buf.readUInt32BE(0);
  return buf.subarray(4, 4 + len);
}

const reqBody = frame(JSON.stringify({ method: 'getAttestation' }));
const ab = new ArrayBuffer(reqBody.byteLength);
new Uint8Array(ab).set(reqBody);
const resp = await fetch(URL, {
  method: 'POST',
  headers: { 'content-type': 'application/octet-stream' },
  body: ab,
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
const respJson = JSON.parse(unframe(Buffer.from(await resp.arrayBuffer())).toString('utf8'));
if (!respJson.ok) throw new Error(`RPC error: ${JSON.stringify(respJson)}`);
const result = respJson.result;

// ---- 2. Save the rpc-level result and the raw COSE_Sign1 bytes ----
const cose = Buffer.from(result.attestation, 'base64');
writeFileSync(`${OUT}/attestation.cose`, cose);
writeFileSync(`${OUT}/attestation.b64`, result.attestation + '\n');
writeFileSync(`${OUT}/rpc_result.json`, JSON.stringify(result, null, 2));

// ---- 3. Decode COSE_Sign1 -> [protected, unprotected, payload, signature] ----
const coseArr = decode(cose);
if (!Array.isArray(coseArr) || coseArr.length !== 4) {
  throw new Error(`unexpected COSE_Sign1 shape: len=${coseArr?.length}`);
}
const [protectedHdr, , payloadBytes, signature] = coseArr;
const protectedDecoded = decode(protectedHdr);
const payload = decode(payloadBytes);

// ---- 4. Save payload fields ----
const pcrsObj = {};
for (const [k, v] of payload.pcrs.entries()) {
  pcrsObj[k] = Buffer.from(v).toString('hex');
}

const cabundle = payload.cabundle.map(b => Buffer.from(b));
const leafCert = Buffer.from(payload.certificate);

// Convert DER -> PEM via openssl (always available on the box) so the verifiers can `openssl
// verify` directly without re-encoding themselves.
function derToPem(der, label) {
  const tmp = `/tmp/.cert_${process.pid}_${Math.random()}.der`;
  writeFileSync(tmp, der);
  const pem = execFileSync('openssl', ['x509', '-inform', 'DER', '-in', tmp, '-outform', 'PEM']);
  return pem.toString('utf8');
}

writeFileSync(`${OUT}/certificate.der`, leafCert);
writeFileSync(`${OUT}/certificate.pem`, derToPem(leafCert, 'leaf'));

// AWS Nitro convention: cabundle is ordered root -> intermediates (root first).
cabundle.forEach((der, i) => {
  writeFileSync(`${OUT}/cabundle/${String(i).padStart(2, '0')}.der`, der);
  writeFileSync(`${OUT}/cabundle/${String(i).padStart(2, '0')}.pem`, derToPem(der));
});
// Concatenated PEM bundle for convenience
const concatPem = cabundle.map(d => derToPem(d)).join('');
writeFileSync(`${OUT}/cabundle.pem`, concatPem);

// ---- 5. Dump the decoded payload as JSON (binary fields as hex) ----
const payloadJson = {
  module_id: payload.module_id,
  timestamp_ms: Number(payload.timestamp),
  timestamp_iso: new Date(Number(payload.timestamp)).toISOString(),
  digest: payload.digest,
  pcrs: pcrsObj,
  user_data_hex: payload.user_data ? Buffer.from(payload.user_data).toString('hex') : null,
  user_data_b64: payload.user_data ? Buffer.from(payload.user_data).toString('base64') : null,
  nonce_hex: payload.nonce ? Buffer.from(payload.nonce).toString('hex') : null,
  public_key_hex: payload.public_key ? Buffer.from(payload.public_key).toString('hex') : null,
  certificate_subject: 'see certificate.pem',
  cabundle_count: cabundle.length,
};
writeFileSync(`${OUT}/payload.json`, JSON.stringify(payloadJson, null, 2));

writeFileSync(`${OUT}/cose_protected_header.json`, JSON.stringify(
  Object.fromEntries(protectedDecoded.entries()), null, 2));

console.log('user_data (hex)        =', payloadJson.user_data_hex);
console.log('module_id              =', payloadJson.module_id);
console.log('timestamp              =', payloadJson.timestamp_iso);
console.log('cabundle certs         =', cabundle.length);
console.log('saved to               =', OUT);

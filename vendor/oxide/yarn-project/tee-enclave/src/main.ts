// Enclave entry point. Uses `NsmAttestationProvider` — runs inside a Nitro enclave and shells
// out to /dev/nsm for attestation.
//
// Transport: this process always listens on plain TCP loopback (default 127.0.0.1:5001). The
// HTTP front end is the standalone proxy in `yarn-project/tee-proxy/`, run alongside this
// process: proxy (HTTP :8080) → TCP loopback → socat (oxide-tee-vsock-bridge.service) → VSOCK
// → this process inside the Nitro enclave. Node lacks native AF_VSOCK support, so socat handles
// the VSOCK leg in prod.
//
// The portal context (l1Portal, chainId, l2Portal, rollupVersion) is read from env at boot.
// In production these env vars are baked into the EIF via Dockerfile ARGs so they end up inside
// PCR0; the protocol-wide constant secret is hardcoded in `@oxide/oxide-lib/types.ts`.
import { NsmAttestationProvider } from './nsm_attestation_provider.js';
import { startEnclave } from './start.js';

startEnclave(new NsmAttestationProvider()).catch(err => {
  console.error('[oxide-tee enclave] fatal:', err);
  process.exit(1);
});

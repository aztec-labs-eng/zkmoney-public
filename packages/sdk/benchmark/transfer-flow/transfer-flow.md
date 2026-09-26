# Flow Benchmark Results

Generated: 2026-09-14 15:03:09

## Summary

| Flow | Function | Total Gates | Kernel Inner # | Largest Circuit | Circuit Gates | L2 Gas | DA Gas | Tx Fee | Nullifiers | Note Hashes | Private Logs | Public Writes |
|------|----------|-------------|----------------|-----------------|---------------|--------|--------|--------|------------|-------------|--------------|---------------|
| transfer | subscribe[authorize_intents,oxide_token.transfer,oxide_token.publish_da] | 841594 | 0 | ClaimFPC:_gate_name_claim | 210741 | 595300 | 4192 | 6072060000000 | 6 | 4 | 9 | 1 |
| transfer | sponsor[authorize_intents,oxide_token.transfer,oxide_token.publish_da] | 591760 | 0 | private_kernel_reset_tail | 138803 | 595300 | 4192 | 6072060000000 | 6 | 4 | 9 | 1 |
| transfer | sponsor[authorize_intents,test_token.transfer] | 646819 | 0 | private_kernel_inner_3 | 157585 | 677700 | 5568 | 6912540000000 | 10 | 6 | 9 | 1 |

## Gate Count Details

### transfer: subscribe[authorize_intents,oxide_token.transfer,oxide_token.publish_da]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:subscribe | 26969 |
| 2 | ClaimFPC:_gate_name_claim | 210741 |
| 3 | ObsidionAccountAlphaTest:authorize_intents | 52317 |
| 4 | private_kernel_init_3 | 116601 |
| 5 | OxideToken:transfer | 77929 |
| 6 | ObsidionAccountAlphaTest:verify_private_authwit | 5738 |
| 7 | OxideToken:publish_da | 11664 |
| 8 | private_kernel_inner_3 | 157585 |
| 9 | private_kernel_reset_tail | 138803 |
| 10 | hiding_kernel | 43247 |
| | **TOTAL** | **841594** |

### transfer: sponsor[authorize_intents,oxide_token.transfer,oxide_token.publish_da]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:sponsor | 29899 |
| 2 | ObsidionAccountAlphaTest:authorize_intents | 52317 |
| 3 | OxideToken:transfer | 77929 |
| 4 | private_kernel_init_3 | 116601 |
| 5 | ObsidionAccountAlphaTest:verify_private_authwit | 5738 |
| 6 | OxideToken:publish_da | 11664 |
| 7 | private_kernel_inner_2 | 115562 |
| 8 | private_kernel_reset_tail | 138803 |
| 9 | hiding_kernel | 43247 |
| | **TOTAL** | **591760** |

### transfer: sponsor[authorize_intents,test_token.transfer]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:sponsor | 29899 |
| 2 | ObsidionAccountAlphaTest:authorize_intents | 52317 |
| 3 | TestToken:transfer | 62465 |
| 4 | private_kernel_init_3 | 116601 |
| 5 | ObsidionAccountAlphaTest:verify_private_authwit | 5738 |
| 6 | HandshakeRegistry:non_interactive_handshake | 20082 |
| 7 | HandshakeRegistry:non_interactive_handshake | 20082 |
| 8 | private_kernel_inner_3 | 157585 |
| 9 | private_kernel_reset_tail | 138803 |
| 10 | hiding_kernel | 43247 |
| | **TOTAL** | **646819** |


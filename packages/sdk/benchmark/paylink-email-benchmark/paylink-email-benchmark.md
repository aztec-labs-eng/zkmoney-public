# Flow Benchmark Results

Generated: 2026-04-03 13:44:26

## Summary

| Flow | Function | Total Gates | Kernel Inner # | Largest Circuit | Circuit Gates | Tx Fee | Nullifiers | Note Hashes | Private Logs | Public Writes |
|------|----------|-------------|----------------|-----------------|---------------|--------|------------|-------------|--------------|---------------|
| paylink-email | deposit (google) | 890496 | 4 | ObsidionToken:transfer_private_to_private | 150929 | 5636520000000 | 5 | 3 | 2 | 1 |
| paylink-email | claim (google) | 1055546 | 3 | PaylinkEmail:claim | 254640 | 7516165800000 | 3 | 1 | 1 | 1 |
| paylink-email | deposit (apple) | 890496 | 4 | ObsidionToken:transfer_private_to_private | 150929 | 5636520000000 | 5 | 3 | 2 | 1 |
| paylink-email | claim (apple) | 1055546 | 3 | PaylinkEmail:claim | 254640 | 7516165800000 | 3 | 1 | 1 | 1 |
| paylink-email | deposit (refund_pre_claim) | 890496 | 4 | ObsidionToken:transfer_private_to_private | 150929 | 5636520000000 | 5 | 3 | 2 | 1 |
| paylink-email | refund_pre_claim | 808031 | 3 | ObsidionToken:transfer_private_to_private | 150929 | 6903268200000 | 3 | 1 | 1 | 1 |
| paylink-email | deposit (refund_post_claim) | 890496 | 4 | ObsidionToken:transfer_private_to_private | 150929 | 5636520000000 | 5 | 3 | 2 | 1 |
| paylink-email | refund_post_claim | 808031 | 3 | ObsidionToken:transfer_private_to_private | 150929 | 6905410200000 | 3 | 1 | 1 | 1 |

## Gate Count Details

### paylink-email: deposit (google)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:deposit | 10169 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | SchnorrAccount:verify_private_authwit | 14328 |
| 10 | private_kernel_inner | 101237 |
| 11 | private_kernel_reset | 122505 |
| 12 | private_kernel_tail | 44565 |
| 13 | hiding_kernel | 36388 |
| | **TOTAL** | **890496** |

### paylink-email: claim (google)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:claim | 254640 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | private_kernel_reset | 112535 |
| 10 | private_kernel_tail | 88998 |
| 11 | hiding_kernel | 38069 |
| | **TOTAL** | **1055546** |

### paylink-email: deposit (apple)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:deposit | 10169 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | SchnorrAccount:verify_private_authwit | 14328 |
| 10 | private_kernel_inner | 101237 |
| 11 | private_kernel_reset | 122505 |
| 12 | private_kernel_tail | 44565 |
| 13 | hiding_kernel | 36388 |
| | **TOTAL** | **890496** |

### paylink-email: claim (apple)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:claim | 254640 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | private_kernel_reset | 112535 |
| 10 | private_kernel_tail | 88998 |
| 11 | hiding_kernel | 38069 |
| | **TOTAL** | **1055546** |

### paylink-email: deposit (refund_pre_claim)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:deposit | 10169 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | SchnorrAccount:verify_private_authwit | 14328 |
| 10 | private_kernel_inner | 101237 |
| 11 | private_kernel_reset | 122505 |
| 12 | private_kernel_tail | 44565 |
| 13 | hiding_kernel | 36388 |
| | **TOTAL** | **890496** |

### paylink-email: refund_pre_claim

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:refund_pre_claim | 7125 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | private_kernel_reset | 112535 |
| 10 | private_kernel_tail | 88998 |
| 11 | hiding_kernel | 38069 |
| | **TOTAL** | **808031** |

### paylink-email: deposit (refund_post_claim)

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:deposit | 10169 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | SchnorrAccount:verify_private_authwit | 14328 |
| 10 | private_kernel_inner | 101237 |
| 11 | private_kernel_reset | 122505 |
| 12 | private_kernel_tail | 44565 |
| 13 | hiding_kernel | 36388 |
| | **TOTAL** | **890496** |

### paylink-email: refund_post_claim

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | SchnorrAccount:entrypoint | 54352 |
| 2 | private_kernel_init | 46811 |
| 3 | SponsoredFPC:sponsor_unconditionally | 5501 |
| 4 | private_kernel_inner | 101237 |
| 5 | PaylinkEmail:refund_post_claim | 7125 |
| 6 | private_kernel_inner | 101237 |
| 7 | ObsidionToken:transfer_private_to_private | 150929 |
| 8 | private_kernel_inner | 101237 |
| 9 | private_kernel_reset | 112535 |
| 10 | private_kernel_tail | 88998 |
| 11 | hiding_kernel | 38069 |
| | **TOTAL** | **808031** |


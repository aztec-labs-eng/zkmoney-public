# Flow Benchmark Results

Generated: 2026-08-10 08:20:24

## Summary

| Flow | Function | Total Gates | Kernel Inner # | Largest Circuit | Circuit Gates | L2 Gas | DA Gas | Tx Fee | Nullifiers | Note Hashes | Private Logs | Public Writes |
|------|----------|-------------|----------------|-----------------|---------------|--------|--------|--------|------------|-------------|--------------|---------------|
| claim-fpc | subscribe_with_name_claim[noop] | 428356 | 0 | ClaimFPC:subscribe_with_name_claim | 220193 | 483700 | 800 | 4933740000000 | 2 | 1 | 1 | 1 |
| claim-fpc | sponsor[noop] | 228178 | 0 | private_kernel_reset_tail | 83882 | 483700 | 800 | 4933740000000 | 2 | 1 | 1 | 1 |
| claim-fpc | sponsor[noop,noop] | 276487 | 0 | private_kernel_init_3 | 116601 | 483700 | 800 | 4933740000000 | 2 | 1 | 1 | 1 |
| claim-fpc | sponsor[noop,noop,noop,noop] | 404791 | 0 | private_kernel_init_3 | 116601 | 483700 | 800 | 4933740000000 | 2 | 1 | 1 | 1 |

## Gate Count Details

### claim-fpc: subscribe_with_name_claim[noop]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:subscribe_with_name_claim | 220193 |
| 2 | TestToken:noop | 6371 |
| 3 | private_kernel_init_2 | 74663 |
| 4 | private_kernel_reset_tail | 83882 |
| 5 | hiding_kernel | 43247 |
| | **TOTAL** | **428356** |

### claim-fpc: sponsor[noop]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:sponsor | 20015 |
| 2 | TestToken:noop | 6371 |
| 3 | private_kernel_init_2 | 74663 |
| 4 | private_kernel_reset_tail | 83882 |
| 5 | hiding_kernel | 43247 |
| | **TOTAL** | **228178** |

### claim-fpc: sponsor[noop,noop]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:sponsor | 20015 |
| 2 | TestToken:noop | 6371 |
| 3 | TestToken:noop | 6371 |
| 4 | private_kernel_init_3 | 116601 |
| 5 | private_kernel_reset_tail | 83882 |
| 6 | hiding_kernel | 43247 |
| | **TOTAL** | **276487** |

### claim-fpc: sponsor[noop,noop,noop,noop]

| ID | Method | Gate Count |
|----|--------|-----------|
| 1 | ClaimFPC:sponsor | 20015 |
| 2 | TestToken:noop | 6371 |
| 3 | TestToken:noop | 6371 |
| 4 | private_kernel_init_3 | 116601 |
| 5 | TestToken:noop | 6371 |
| 6 | TestToken:noop | 6371 |
| 7 | private_kernel_inner_2 | 115562 |
| 8 | private_kernel_reset_tail | 83882 |
| 9 | hiding_kernel | 43247 |
| | **TOTAL** | **404791** |

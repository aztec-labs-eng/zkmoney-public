# AWS Nitro Enclave

## Performance bottlenecks

- Poseidon2 sponge for ancestor effect proofs requires one BB call per permutation
- Worst case (64 spends all included in blocks that use 6 blobs) maxes out the enclave for 30s+
- In deposit proofs, membership checks are the bottleneck (poseidon again)


## Scalability issues

- No load balancing implemented: a TEE taken down will bring down the whole service
- No authentication implemented: a user can send as many requests as he wants to the tee and bring it down
- No autoscaling implemented: changes in user load requires manual intervention

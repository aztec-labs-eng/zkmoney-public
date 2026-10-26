# @oxide/oxide-lib-tee

This package contains only the code that the enclave (`@oxide/tee-enclave`) needs. The enclave image includes this package, so a change here changes the enclave PCR0.

Add a module here only if the enclave imports it. Put all other shared code in `@oxide/oxide-lib`. When a module holds both enclave code and client code, keep the client code in the `@oxide/oxide-lib` module with the same name. Exceptions are `encryption.ts`, which keeps both sides of the HPKE protocol together, and the generated `oxide_constants.gen.ts`. The tests and test helpers for this package are in `@oxide/oxide-lib`, so a change to a test does not change the enclave.

`@oxide/oxide-lib` re-exports each module of this package at the same path, so existing `@oxide/oxide-lib/<module>.js` imports continue to work.

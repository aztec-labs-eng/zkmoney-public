# string_search (vendored)

Verbatim copy of [noir-lang/noir_string_search](https://github.com/noir-lang/noir_string_search) at
`deef74101be0ce50cb7c611cd4d126428730df59` (`main`, unreleased). Apache-2.0; `LICENSE` is upstream's.

Vendored rather than pinned as a git dependency because the released tag `v0.3.3` calls `as_slice()`
on fixed-size arrays, which nargo `1.0.0-beta.25` (the Aztec `v5.2.0-nightly.20260814` toolchain)
removed — `zkJWT` will not compile against it. Upstream fixed this in `6fcc547` but has cut no
release since, and nargo git dependencies accept only a `tag`, not a `rev`, so there is nothing
taggable to point at.

Replace this directory with a normal git dependency once upstream tags a release containing
`6fcc547`. The `jwt` lib's `Nargo.toml` is the only consumer.

Editing the sources here changes the zkJWT verifying key, which moves `ZKJWT_VKEY_HASH`,
`ZKJWT_VK_BASE64`, and `PaylinkEmail`'s class id with it.

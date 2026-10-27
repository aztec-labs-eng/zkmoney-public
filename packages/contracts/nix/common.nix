# Pins and helpers shared by default.nix and lock.nix.
let
  pkgs =
    import
      (fetchTarball {
        # nixos-26.05, 2026-10-06. Left with the default name: Nix reuses a `source` tarball from the store, but
        # downloads one with any other name again on every run.
        url = "https://github.com/NixOS/nixpkgs/archive/b25309931cfda5f0b8805f462a29897eeae50168.tar.gz";
        sha256 = "1svxsx57g7x76cjsgpw5vvg0l194mshk57fdvdqqgd5xdy0ari58";
      })
      {
        # One system for every machine, so all of them share one set of cache keys. docker.sh runs the
        # container as linux/amd64 for the same reason.
        system = "x86_64-linux";
        config = { };
        overlays = [ ];
      };
  inherit (pkgs) lib;

  normalize =
    path:
    lib.concatStringsSep "/" (
      lib.foldl' (
        acc: part:
        if part == "" || part == "." then
          acc
        else if part == ".." then
          lib.init acc
        else
          acc ++ [ part ]
      ) [ ] (lib.splitString "/" path)
    );

  manifest =
    root: dir: builtins.fromTOML (builtins.readFile (root + "/${if dir == "" then "" else "${dir}/"}Nargo.toml"));
  dependencies = root: dir: lib.attrValues ((manifest root dir).dependencies or { });

  # Only the two manifests, so a stray node_modules or .DS_Store there never reaches a key.
  aztecToolchain = builtins.path {
    name = "aztec-toolchain";
    path = ./aztec-toolchain;
    filter = path: _: lib.elem (baseNameOf path) [ "package.json" "package-lock.json" ];
  };

  # A build's shell script names each git dependency's directory by its key, so a key from a third-party manifest
  # must be plain path segments.
  safeKey =
    key:
    lib.assertMsg (builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*" key != null)
      "nargo git dependency key ${key} is not plain path segments";
in
{
  inherit
    pkgs
    lib
    aztecToolchain
    manifest
    safeKey
    ;
  repo = ../../..;
  lock = lib.importJSON ./lock.json;

  # One fixed-output fetch for every tarball aztec-toolchain/package-lock.json names, so a cold build asks a cache
  # about one path rather than one per package. Named after the lockfile, so a hash recorded for an earlier one never
  # matches that one's fetch in the store.
  aztecNpmDeps =
    hash:
    pkgs.fetchNpmDeps {
      name = "aztec-toolchain-npm-deps-${builtins.hashFile "sha256" ./aztec-toolchain/package-lock.json}";
      src = aztecToolchain;
      inherit hash;
    };

  # The directory nargo clones a git dependency to under ~/nargo: the URL without its scheme or a trailing slash,
  # then the tag. Two spellings of one URL are two clones there, so they are two keys here.
  gitKey =
    dep:
    let
      key = "${lib.removeSuffix "/" (lib.last (lib.splitString "://" dep.git))}/${dep.tag}";
    in
    assert lib.assertMsg (dep ? tag) "nargo git dependency ${dep.git} has no tag";
    assert safeKey key;
    key;

  # The directories a package compiles from (itself and its `path` dependencies, transitively) under root, and the
  # git dependencies their manifests name.
  closure =
    root: dir:
    let
      dirs = map (x: x.key) (
        builtins.genericClosure {
          startSet = [ { key = normalize dir; } ];
          operator =
            { key }:
            map (d: { key = normalize "${key}/${d.path}"; }) (lib.filter (d: d ? path) (dependencies root key));
        }
      );
    in
    {
      inherit dirs;
      gits = lib.unique (lib.concatMap (d: lib.filter (dep: dep ? git) (dependencies root d)) dirs);
    };

  fetchGitDep =
    entry:
    pkgs.fetchFromGitHub {
      inherit (entry) owner repo hash;
      rev = entry.tag;
      sparseCheckout = entry.sparseCheckout or [ ];
    };
}

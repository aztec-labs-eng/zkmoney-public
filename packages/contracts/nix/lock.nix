# Derives lock.json's gitDeps for the given packages: every git dependency nargo clones for them, and for each one the
# git dependencies its own manifests name. Evaluated by update-lock.sh, never by a build.
{
  # JSON list of repo-relative package directories.
  dirs,
  # JSON list of the clones hashed since lock.json was read: entries of missing, each with its hash.
  found ? "[]",
}:
let
  common = import ./common.nix;
  inherit (common)
    lib
    repo
    gitKey
    closure
    fetchGitDep
    ;

  lock =
    common.lock.gitDeps
    // lib.listToAttrs (
      map (e: lib.nameValuePair e.gitKey (lib.removeAttrs e [ "gitKey" ] // { deps = [ ]; })) (builtins.fromJSON found)
    );

  coordinate =
    dep:
    let
      clone = gitKey dep;
      path = lib.splitString "/" clone;
      repoName = lib.removeSuffix ".git" (lib.elemAt path 2);
    in
    assert lib.assertMsg (lib.head path == "github.com") "nargo git dependency ${dep.git} is not on GitHub";
    {
      key = "${clone}:${dep.directory or ""}";
      gitKey = clone;
      directory = dep.directory or "";
      owner = lib.elemAt path 1;
      repo = repoName;
      inherit (dep) tag;
      # Every aztec-packages and aztec-node dependency lies under noir-projects/.
      sparseCheckout = lib.optional (lib.elem repoName [ "aztec-packages" "aztec-node" ]) "noir-projects";
    };

  # The git dependencies a node's directory names, read from its locked clone.
  gitsIn = node: (closure (fetchGitDep lock.${node.gitKey}) node.directory).gits;

  # One node per (clone, directory), since two directories of one clone can name different dependencies.
  reached = builtins.genericClosure {
    startSet = map coordinate (lib.unique (lib.concatMap (dir: (closure repo dir).gits) (builtins.fromJSON dirs)));
    operator = node: if lock ? ${node.gitKey} then map coordinate (gitsIn node) else [ ];
  };
  byClone = lib.groupBy (node: node.gitKey) reached;
in
{
  # The clones lock.json has no hash for yet.
  missing = lib.mapAttrsToList (_: nodes: lib.removeAttrs (lib.head nodes) [ "key" "directory" ]) (
    lib.filterAttrs (key: _: !(lock ? ${key})) byClone
  );

  gitDeps =
    lock
    // lib.mapAttrs (
      key: nodes:
      lock.${key}
      // {
        deps = lib.sort lib.lessThan (
          lib.unique (lock.${key}.deps or [ ] ++ lib.concatMap (node: map gitKey (gitsIn node)) nodes)
        );
      }
    ) byClone;
}

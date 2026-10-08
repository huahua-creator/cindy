# 2026-10-08 replacement installer repair

## Evidence

The existing replacement log records process stops at 18:01:29 CST (including
PID 83768), installer exit 0 at 18:01:41, and rollback at 18:01:43. The rollback
installer returned 0 at 18:01:51 but verification reported false. This explains
the coincident renderer termination reports and temporary missing executable;
the evidence does not establish a context-view rendering defect.

`Log` wrote to PowerShell's success stream. `InstallSetup` therefore returned
two log strings plus the exit code. Array comparisons caused both a false
installation failure and a false rollback-verification failure. A side-effect
free reproduction confirmed both. The expected source commit was also stale.

## Scope and validation

- Separate diagnostic output from the installer exit code.
- Pin the already-built bbc495b12 artifact and verify its hash, size and metadata
  before stopping processes. Do not infer approval from arbitrary build metadata.
- Add VerifyOnly, which skips log writes and returns before process operations.
- Mock regression tests cover scalar success/failure, restore comparison, and
  four preflight cases: valid, wrong commit, wrong hash, wrong size.
- Real-artifact VerifyOnly and git diff --check passed.
- No installation, process stop, application patch, or user-data change was run.
  The running installed source remained e0041fc08.

## Independent review

Reviewer Feynman (01a11919-9b3d-7772-87ad-7e3290eb2dad) reviewed the plan before
implementation and the actual script/test changes afterward. Both received GO
for this narrow repair. The reviewer independently reran the mock tests, real
VerifyOnly and diff-check successfully. Review required VerifyOnly to return
before all process operations and not append its log; both were implemented.

This is not a full installation/rollback acceptance or approval to replace the
running client. Before any real replacement, coordinate other running tasks and
address the existing broad name-based process stop, final process-stop checks,
and required installed-executable presence verification. No renderer crash fix
is claimed. Context-size optimization remains separate work.

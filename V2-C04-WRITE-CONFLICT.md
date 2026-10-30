# C04 follow-up: staging conflict checks

Baseline at `4e88fce`: a temporary-file probe scheduled an external edit after
the first lifecycle check. The second check observed that edit at the rename
boundary, yet final source bytes became `ours`. This reproduced the window
between the pre-write source read and asynchronous staging/fsync.

`writeGuardedInstruction` now rechecks a fixed expected source hash after staging
and immediately before its final lifecycle check/rename. Apply passes the locked
before hash; rollback passes its current hash. Migration passes original config
and destination hashes. The optional `beforeReplace` integration probe runs
before validation, enabling deterministic staged-write regressions without
global module mocks.

Rollback restoring absence rechecks after backup awaits before removal. Optional
rollback lifecycle guards flow through V1 and V2 managers. Conflicts preserve
external bytes and leave receipts available for explicit recovery; they do not
mark the original receipt rolled back.

Checks: six new regressions, **126 focused tests passed**, typecheck/build passed,
focused Biome and diff checks passed. No models, global config or root source
mutations. Participating writers retain cooperative locks; an external write
between the final read and the filesystem syscall remains outside atomic CAS
guarantees and is not claimed solved.

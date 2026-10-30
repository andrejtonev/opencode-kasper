# Migration and release checklist

This is a qualification checklist, not authorization to publish or change global
OpenCode configuration. Record results and artifacts; an unchecked item is not
verified compatibility. The current [native acceptance report](V2-NATIVE-ACCEPTANCE.md)
records the qualified fixture paths; repeat the relevant checks for a release.

## Local package checks

- [ ] Frozen dependency install; exact plugin/client/schema 2.2.2 and Effect 4.0.6.
- [ ] Typecheck, SDK contract compilation, build, focused source regressions and
      complete offline suite; record pass/skip counts separately from native tests.
- [ ] Lint results, distinguishing the two baseline unused-suppression warnings
      from new failures.
- [ ] Pack and install the actual archive in a clean consumer. Verify package
      bytes, `.` legacy function, native `./server`, and V1 import isolation.
- [ ] Qualify ordinary V1 package identity through the dual server legacy function.
      Host 1.18.23 selects the server export; a root function alone does not preserve
      that profile. Retain explicit compiled-file registration as an alternative.
- [ ] Version/release notes and registry status reviewed; no publication inferred
      from a successful local pack or test.

## Isolated native host checks

- [ ] Use temporary home/config/data/cache/workspace and a whitelisted environment;
      avoid global user settings and ambient provider credentials.
- [ ] Native 2.2.2 loads the packaged server and reports session-bound command/tool
      results without a chat/model dispatch for administrative commands.
- [ ] Legacy V1 packaged legacy entry/load independently verified on the named host
      version; record unresolved probing as unverified, not accepted/rejected.
- [ ] Deterministic generation fixture preserves real tools/errors, agent switches,
      child identity and completion boundaries through manual and automatic flows.
- [ ] Current-window scoring clearly differs from authenticated full archive
      pagination; mismatched provenance/missing checkpoints fail closed.
- [ ] Timeout/failure/reset/delete/dispose/reload leave no stale commits, overlapping
      unknown attempts or consumed-but-unapplied pending actions.
- [ ] Provider termination, retries and billing limits separately qualified before
      claiming more than local Effect/control cancellation.
- [ ] V1 auxiliary score/merge prompts serialize wildcard tool denial; a forced
      provider tool call cannot mutate the workspace or invoke plugin/MCP tools.

## Guidance and recovery checks

- [ ] Complete applicable instructions and effective agent text are verifiable;
      partial/truncated evidence and incomplete instructions cannot feed proposals.
- [ ] Agent canonical target/pointer opt-in validated across all ordered config
      layers; unknown origins remain read-only; overlays append to factory system.
- [ ] AGENTS writes remain project-owned; no implicit global or CLAUDE fallback.
- [ ] Backup exact bytes and source receipt retained; rollback preserves unrelated
      JSONC edits and rejects later whole-file edits.
- [ ] Migration refuses a differing destination; journal recovery tested without
      overwriting subsequent edits; old receiptless backups require manual review.
- [ ] Windows replacement failures preserve destination bytes; live/unknown lock
      owners are not reclaimed by age alone; abandoned guards documented.
- [ ] Refresh remains pending until an actual host reread confirms intended text;
      metadata expiry does not claim guidance deactivation.

## Final reconciliation

- [ ] README/install/options match actual C10 exports and schemas.
- [ ] Support matrix names exact qualified host/package versions and limitations.
- [ ] All C01–C12 agent commits, integration commits and final evidence appear in
      [V2-IMPLEMENTATION-PLAN.md](V2-IMPLEMENTATION-PLAN.md).
- [ ] Coordinator reviews the final combined diff and reports completed, pending
      and unverified work. Publication remains a separate explicit action.

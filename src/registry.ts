import type { KasperStateStore } from "./state.js"

// Internal registry for test-only state store access. Not part of the public plugin API.
export const _stateStoreRegistry = new Map<string, KasperStateStore>()

/** @internal Test-only helper — not part of the public plugin API. */
export async function flushKasperState(directory: string): Promise<void> {
  const store = _stateStoreRegistry.get(directory)
  if (store) {
    await store.flush()
  }
}

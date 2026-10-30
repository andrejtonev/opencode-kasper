# V1 auxiliary generation tool isolation

The V1 auxiliary generation port now sends the public prompt input `tools: { "*": false }` for both scoring and weakness merging. It does not select a fabricated agent or change host configuration. Exact session ownership/cleanup and the existing lifetime fence are preserved. V2 stateless generation is unchanged.

This is grounded in installed `@opencode-ai/sdk` 1.15.11 `SessionPromptData` (`dist/gen/types.gen.d.ts:2244`, tool map at 2254), and immutable OpenCode host 1.18.23 commit `ef2880f379129aa048be9e9353e30aa168d42c17`:

- [Public prompt compatibility implementation](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/prompt.ts#L1060): converts every tools map entry into a session rule; `"*": false` becomes `{ permission: "*", action: "deny", pattern: "*" }`, persisted before the model loop.
- [Permission matching](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/permission/index.ts#L28): matches permission and resource patterns with wildcards, taking the last applicable rule. Session permissions follow agent permissions.
- [Disabled tool filtering](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/permission/index.ts#L204): maps edit/read aliases and excludes every tool matching a final wildcard deny rule.
- [Actual outgoing model tool preparation](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/session/llm/request.ts#L208): computes disabled tools using merged agent/session permissions and filters them from the request.
- [MCP and CodeMode catalog filtering](https://github.com/anomalyco/opencode/blob/ef2880f379129aa048be9e9353e30aa168d42c17/packages/opencode/src/tool/registry.ts#L280): uses the same merged permissions to hide denied catalog entries.

The public SDK contract fixture compiles the exact deny map. One regression exercises both score/merge generation bodies with untrusted evidence requesting a workspace/plugin tool, requiring the fixed wildcard deny and no allowed entries. A second uses the real installed SDK with a local fetch stub and verifies the serialized public HTTP body without calling a provider. Focused generation/scorer validation: 49 pass, 0 fail, 137 assertions; typecheck and SDK contract typecheck pass. C11 separately attempts a forced write using the actual isolated native V1 host/provider fixture; that runtime qualification is not claimed by these offline tests.

Auxiliary V1 sessions still receive the host's normal system/config context and trusted plugin hooks. The supported deny map isolates model tool execution; it does not turn V1 generation into the sessionless native V2 API or prove provider cancellation/output limits.

# RFC 0049: Agents choose the model and effort of the child sessions they dispatch

Status: accepted (maintainer, 2026-11-13). Revises RFC 0014's "Agents cannot set model or effort" for child sessions only.

## Problem

An author tells a root Agent: "dispatch a Codex child on GPT-6.1 Sol at xhigh". The Agent cannot do it. `work.dispatch` takes only `agentKind`; `session.setAgentConfig` and `session.agentOptions` are UI-only (RFC 0014), and `WorkSessionView` does not show a session's model or effort. The Agent correctly answered that it could not set or confirm the setting and sent the author to the UI. The author's instruction was clear, and the mechanism was missing.

## Goals

- An Agent can dispatch a child with a model, effort and service tier, and change them for a direct child's session later.
- An Agent can list the valid choices before it dispatches, and read back what each child session runs.
- The gateway validates every value against the Agent's own model list; a wrong id fails loudly instead of silently falling back to defaults.

## Non-goals

- An Agent changing its own session's model or effort. That stays UI-only, as RFC 0014 decided.
- Children inheriting the parent's settings. A child without settings uses its Agent's defaults, as today.
- Global or per-Agent default models.

## Contract (`packages/protocol`)

- `WorkSessionView` gains `agentConfig: { model, effort, serviceTier }`, the same shape and defaults as `SessionSummary.agentConfig`. `work.get` and `work.list` therefore show what each session runs to both the UI and Agents.
- `work.dispatch` gains optional `agentConfig: { model?: string | null, effort?: string | null, serviceTier?: string | null }`. Omitted fields are `null` (Agent default). The child's session is created with it.
- New `work.agentOptions({ agentKind })`, callers `both`: returns `{ models: AgentModelOption[] }` from the same per-kind catalog and cache as `session.agentOptions`. Agents use it to find valid ids.
- New `work.setAgentConfig({ requestId, workItemId, model, effort, serviceTier })`, callers `agent`: sets the config of the target work item's main session (first unarchived session, RFC 0009 routing). It takes effect from that session's next turn, as in RFC 0014. The UI keeps using `session.setAgentConfig`.
- Capability descriptions for the three Agent-visible methods say: set model or effort only when the author asked for it or a skill or workflow the author wrote says so; otherwise omit `agentConfig`.

## Gateway rules

- `work.dispatch` with `agentConfig`: same caller rules as today (any session of a root work item). `work.setAgentConfig`: the caller's work item must be the target's parent. Its own work item, siblings and grandchildren return `forbidden`.
- Validation is RFC 0014's: a non-null `model` must be in the catalog for that `agentKind`; a non-null `effort` must be in the chosen model's efforts (the Agent's default model when `model` is null); `serviceTier` follows RFC 0014's rules. Invalid values return `invalid_params` naming the field and listing the valid ids.
- When `agentConfig` has a non-null value and the catalog cannot be read (Agent not installed, not signed in), the call returns `unavailable` with the reason and creates nothing. An explicit request never silently becomes a default.
- Both calls are idempotent by `requestId`, run in one transaction, and emit the session change event the UI already handles, so open windows update the child's model picker.
- No other permission changes: the author can still change any session's settings from the UI at any time, and that wins until the next change.

## Agent guidance

Update each Agent's developer instructions (`prompt.ts`) with one short paragraph: when the author names a model or effort for a child, call `work.agentOptions` for that Agent kind, pass the exact ids to `work.dispatch` (or `work.setAgentConfig` for a child that already exists), and confirm by reading `agentConfig` back from `work.get`. If the name is ambiguous or not listed, show the author the options instead of guessing. Do not pick a model on your own initiative.

## UI

No new controls. The child session's existing model picker shows the value the parent set. The work item drawer's session row shows the model label next to the Agent kind when its configuration is not the default (including effort-only and service-tier-only settings), through `messages.ts` in both languages.

## Tests

- Contract: new fields and methods in `protocol.test.ts` and `capabilities.test.ts`; old records without `agentConfig` on `WorkSessionView` parse with nulls.
- Gateway and service: dispatch with a valid config creates the child session with it. An invalid model or effort returns `invalid_params` and nothing is created. An unreadable catalog returns `unavailable`. `setAgentConfig` works for a direct child and is forbidden for self, sibling and grandchild. Repeated `requestId` returns the same result.
- Adapter: the child's first turn passes the model and effort (Codex `turn/start`, ACP config options), using the existing RFC 0014 paths.
- e2e (fake Codex with a fixed model list): a root Agent dispatches a child with a model and effort. The child's model picker shows them, and `work.get` returns them.

## Rollout

One step. The new `agentConfig` fields on the contract default to null, so older clients and stored results keep working.

## Implementation notes (2026-11-13)

The session and work-item paths share one validator and the existing ten-minute per-kind catalog cache. Catalog reads happen before writes. The work service requires a caller resolver for dispatch and child configuration: it resolves the caller before the probe, then unconditionally resolves it again inside the write transaction and uses that fresh actor for permission and relationship checks. The gateway supplies the resolver without eagerly evaluating it. The UI-only session.setAgentConfig path has no active-turn requirement. A changed main session returns `busy` so the caller can retry against the new session. Request replays validate the stored fingerprint before reading catalogs or resolving the current main session, preserving later author changes.

Only root workspaces receive the child-configuration guidance, through shared Codex/DeepSeek/ACP instructions or the Claude developer prompt. Cards and drawers use one shared label helper: the Agent kind and per-kind index stay separate from the model, effort and service-tier display. Any non-null setting shows configuration, including effort-only or tier-only settings with the default model label. Session-button accessible names retain only the Agent kind and index. A shared per-kind client cache deduplicates catalog reads; the drawer renders before those reads finish and updates labels afterwards, falling back to the exact id or localized default-model copy when unavailable. The existing model picker shows the saved settings. No new controls or storage migrations are needed.

## Review corrections (2026-11-13)

Dispatch normalizes an omitted config, an empty object and an all-null config to the same omitted value before fingerprinting. Authenticated successful replay has a dedicated lookup path before target-session/relationship or recall/delete guards; fingerprint conflicts still fail and caller authentication still applies to retries. Known VisErrors from catalog reads retain their original reason and details. If the catalog has no default model, an effort-only or tier-only request names that field and asks for an explicit model, listing the valid model ids.

The client catalog cache retains successful reads for ten minutes and failed reads for thirty seconds, sharing pending requests across card/drawer mounts and review reloads. Catalog failures do not delay review data or actions. Regression tests cover both replay orders, pending recall/delete, fresh actor resolution for both writes, root-only instructions, labels and accessible names, and a drawer opening while its shared catalog response is held.

## Claude session configuration (2026-11-15)

Claude now exposes the same session and direct-child model/effort configuration as the other Agents. Its descriptor advertises both capabilities. The existing picker uses each model's declared effort choices; models without declared support have no explicit effort choices. Claude's root developer instructions already cover discovering exact ids through `work.agentOptions`, setting a direct child only on author or author-written skill/workflow direction, and reading the saved settings through `work.get`; those instructions remain unchanged.

The Claude adapter reads `query.supportedModels()` using an ephemeral streaming query whose input stays open without yielding a user message, so catalog discovery never submits a model prompt. It uses the turn's spawn path, PATH, disabled settings sources and settings-authentication environment forwarding (RFC 0026), with a temporary working directory and `persistSession: false`. After the RFC 0026 §8 integration, catalog processes share the turn sandbox, owned `<dataDir>/agents/claude` config and environment-authentication fallback. Authentication is still read from the original user config; restricted fallback restores that config explicitly. They configure no vis MCP server because no active turn can authenticate their token. It issues a fresh token through the same issuer as turns but discards its hash without creating a session, turn or runtime instance; the gateway cannot authenticate that token. Success, failure, timeout and disposal close/abort the query, hard-stop its process tree, await process exit and remove the temporary directory.

Successful runtime catalogs are keyed by a SHA-256 hash of the merged, allowlisted authentication environment. Every runtime `agentOptions` call rereads settings, including cache hits, so changed credentials, provider routing or model mappings select a fresh probe. Only the digest, catalog data and pending read promise are retained in the cache, never the environment values. Concurrent reads share a probe only when their digests match, and callers wait for process cleanup. The shared gateway cache still retains successful catalogs for ten minutes across projects.

SDK alias ids, labels, descriptions and supported effort levels are preserved. An environment-configured default first matches an exact alias, then a row's `resolvedModel`; if neither exists, the adapter appends the configured id with that id as its label and no guessed effort support. Exactly one row is default when a runtime model is configured. A matching resolved row retains its declared efforts. The SDK does not declare a default effort, so it stays null.

Failed, malformed or timed-out catalog reads reject with a sanitized `unavailable` VisError. No fallback alias list is returned: otherwise the shared gateway would cache that incomplete list as a success and reject valid effort settings. Failures never expose authentication environment values in errors or logs, and neither cache retains rejected reads. The dedicated catalog timeout defaults to 15 seconds, includes fresh settings authentication, and is independent of the turn startup timeout. Turns continue using their existing configuration or defaults without requiring a catalog read.

Each turn passes an explicit session model before `VIS_CLAUDE_MODEL` (the runtime's `model` option), otherwise leaving the SDK default. The catalog's session model `default` is a pseudo-alias for no explicit selection: it falls back to the runtime model, then the SDK default, and is never forwarded as the session override. Only `low`, `medium`, `high`, `xhigh` and `max` are forwarded as effort. Claude ignores `serviceTier` and advertises no speed tiers. The same dispatch path applies to a child's first turn and later turns after `work.setAgentConfig`.

Disposal aborts turn startups and running turns and stops their process trees concurrently with catalog teardown; slow catalog cleanup cannot delay turn cancellation. Only catalog spawns synchronously reject after abort or closure. Turn spawns retain the SDK's lifecycle: they still spawn and the abort listener kills the process. An intentional startup interruption ends as interrupted, including when it lands between query creation and spawn, rather than being classified as a rejected delivery.

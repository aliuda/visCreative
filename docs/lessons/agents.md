# Agent lessons

## JavaScript realpath can erase symlink parent traversal

- **Symptom:** a path containing `link/..` appears to resolve to a registered project blob even though the operating system follows it outside the blob directory.
- **Cause:** Node's JavaScript `realpathSync` resolves the path lexically before following symlinks, removing the parent segment too early.
- **Instead:** use `realpathSync.native` for existing blob paths and the blob root, then check the exact canonical hash shard and file name. Test a symlink followed by `..` with an existing outside target as well as ordinary links into and out of the blob directory.
- **Found in:** [RFC 0051 path resolution](../rfc/0051-viewed-images-in-transcript.md#path-resolution-assetresolvepaths-caller-ui-only), `services/studiod/src/asset-paths.ts`.

## Redacting every environment value destroys diagnostics

- **Symptom:** Claude startup errors lose `code 1` and paths beneath HOME, making failures difficult to diagnose.
- **Cause:** replacing all runtime environment values treats flags such as `CLAUDE_CODE_USE_BEDROCK=1`, home paths and PATH as secrets.
- **Instead:** scrub an explicit list of secret-bearing keys and the agent token, plus only the userinfo segment of proxy URLs. Keep literal, JSON-escaped and URI-encoded secret representations covered without removing ordinary environment values or proxy hosts. Test failures both before and after SDK initialization.
- **Found in:** [RFC 0026 §8](../rfc/0026-agent-instructions.md#8-claude-code-implemented-2026-11-15), `packages/workbench/claude/src/adapter.ts`.

## Writable agent config can persist into an unsandboxed user CLI

- **Symptom:** a workspace-auto-approved command can modify the user's Claude hooks or MCP configuration and affect a later CLI run outside isolation.
- **Cause:** the writable runtime home was the same directory the user CLI and studiod authentication loader trusted.
- **Instead:** import only whitelisted authentication/connection environment from the original user config, then launch expanded Claude with `CLAUDE_CONFIG_DIR=<dataDir>/agents/claude`. Keep real user config read-denied, reject symlinks beneath the owned data path, and restore user config only for restricted fallback without Bash. Resume errors from the former location stay normal failures rather than triggering an unsafe config fallback.
- **Found in:** [RFC 0026 review correction](../rfc/0026-agent-instructions.md#review-correction-isolated-runtime-configuration-2026-11-15).

## Native permission shortcuts must still reach host checks

- **Symptom:** a safe-command shortcut can avoid the shared approval callback, while Claude provides no reliable shell cwd on Windows.
- **Cause:** default SDK tool permissions and shared auto-approval are separate decisions.
- **Instead:** force mapped native tools through host ask rules, allow sandboxed reads there, and check Windows read paths canonically. Block Bash auto approval without Seatbelt. Keep file approval details to canonical paths so content does not enter approval entries and session grants match the file rather than one version of its contents.
- **Found in:** [RFC 0026 §8](../rfc/0026-agent-instructions.md#8-claude-code-implemented-2026-11-15).

## Claude Keychain OAuth cannot cross the outer sandbox

- **Symptom:** a trivial sandboxed Claude turn fails authentication when no environment authentication is present, even though the same login works outside isolation.
- **Cause:** the shared profile denies securityd and Keychain access to protect provider keys; granting access to one Keychain item cannot preserve that boundary. S0 passed with settings-environment authentication (exit 0) and failed without it (exit 1, sanitized authentication error).
- **Instead:** forward only the approved authentication environment after settings override exports. On macOS without a usable token or cloud-authentication flag, preserve restricted unsandboxed tools and surface the environment-authentication notice. Keep full native tools behind isolation and approvals, except the disclosed Windows mode. Replace SDK spawn environments with the filtered turn environment: SDK errors and arguments can contain credentials, so preserve message text while scrubbing only secret-bearing authentication values, proxy URL userinfo and the agent token.
- **Found in:** [RFC 0026 §8](../rfc/0026-agent-instructions.md#8-claude-code-implemented-2026-11-15).

## Seatbelt write patterns must match only the intended runtime files

- **Symptom:** a backup-name write grant can also match a similarly named file under another agent's directory, while ordinary regex escaping fails to match some home paths in Seatbelt.
- **Cause:** a suffix regex plus `subpath(home)` also includes descendants, and Seatbelt's operator escaping differs from JavaScript regex escaping.
- **Instead:** anchor runtime write patterns to the canonical directory, represent literal operators with character classes, and test actual sandbox writes with dots, plus signs, brackets and a caret in a fake home. Keep future backup grants directly in that directory and deny a nested backup path. Preserve existing read-denial policies for other agents exactly.
- **Found in:** [RFC 0026 §8](../rfc/0026-agent-instructions.md#8-claude-code-implemented-2026-11-15), `packages/workbench/core/src/sandbox.ts`.

## Approval adapters must preserve symlink traversal segments

- **Symptom:** an adapter's workspace auto-approval can accept an outside path containing a symlink followed by `..`.
- **Cause:** `path.resolve` and `path.join` erase the segments before the shared canonical-path validator can follow the symlink.
- **Instead:** pass absolute tool paths unchanged, and prepend the working directory to relative paths without normalizing them. Let `auto-approval.ts` resolve each segment. Test both file targets and command working directories through a symlink followed by `..`.
- **Found in:** [RFC 0015 §2](../rfc/0015-session-experience.md#2-权限模式与自动审批), `packages/workbench/claude/src/adapter.ts`.

## Claude settings authentication needs an explicit environment fallback

- **Symptom:** Claude asks to log in inside visCreative even though Claude Code already authenticates on its own.
- **Cause:** `settingSources: []` intentionally excludes user settings, including authentication supplied through the `env` block of `settings.json`.
- **Instead:** asynchronously reread the user's settings at every turn and forward only string-valued `ANTHROPIC_*` keys plus `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `AWS_REGION`, `AWS_PROFILE` and `CLOUD_ML_REGION`, keeping settings sources disabled. On Windows, canonicalize exported authentication key names before applying settings so case differences cannot displace settings values. Settings values must override exports, including empty or undefined values, to match Claude Code and avoid exported credentials replacing settings credentials paired with a proxy URL. Keep model mappings under `ANTHROPIC_*`, expand `~` in the config directory, treat an empty config directory as unset, and resolve home from source `HOME`, then Windows `USERPROFILE`, then the system home. Ignore read and parse failures silently so credentials never enter errors or logs; tests must use temporary configuration directories.
- **Found in:** [RFC 0026 settings environment authentication](../rfc/0026-agent-instructions.md#implementation-note-settings-environment-authentication-2026-11-15), `packages/workbench/claude/src/adapter.ts`.

## Claude catalog discovery needs open streaming input without a prompt

- **Symptom:** a catalog probe using a string prompt can start model work, while an immediately exhausted stream closes stdin before initialization finishes.
- **Cause:** SDK control requests share query initialization with the input stream; string input is a user message and an exhausted stream calls `endInput()`.
- **Instead:** keep an asynchronous input stream open without yielding messages, then release it on abort. Disable session persistence, close and abort the query in `finally`, kill and await the tracked process tree, and remove the temporary working directory. Issue no stored token hash or turn instance for discovery, so even a probe that inherits the turn environment cannot authenticate to the gateway.
- **Found in:** [RFC 0049 Claude session configuration](../rfc/0049-child-agent-model.md#claude-session-configuration-2026-11-15), `packages/workbench/claude/src/adapter.ts`.

## Catalog fallbacks can become cached validation failures

- **Symptom:** a transient Claude catalog failure leaves effort configuration unavailable for ten minutes, even after authentication is repaired.
- **Cause:** returning fallback aliases resolves successfully, so the shared gateway caches rows with no efforts and the validator treats them as authoritative. A runtime cache without an authentication key can retain stale provider mappings after that outer cache expires.
- **Instead:** reject with a sanitized unavailable VisError and keep failures out of both caches. Reread the merged allowlisted authentication environment for each runtime catalog call and use only its hash as the cache key. Keep turn cancellation independent of catalog teardown, and apply synchronous late-spawn guards only to catalog processes; interrupted turn startup must retain its interrupted outcome.
- **Found in:** [RFC 0049 Claude session configuration](../rfc/0049-child-agent-model.md#claude-session-configuration-2026-11-15), `packages/workbench/claude/src/adapter.ts`.

## Reference chip numbers must match the vendor's media order

- **Symptom:** a mixed image/video prompt sent the first video as video 2, with spaces and no Seedance 2.5 reference prefix.
- **Cause:** submission shared the UI's global counter but treated its display label as vendor syntax. Ark groups media by type in `content`, and Seedance counts within each type.
- **Instead:** share per-type numbering between UI and submission, then resolve node markers through an optional model-specific adapter hook. Assert exact prompt text and media order in one fake-vendor HTTP test; preserve handwritten identifiers and do not infer syntax for unknown model IDs.
- **Found in:** [RFC 0043 reference-label correction](../rfc/0043-video-references-and-media-hosting.md#reference-label-correction-2026-11-11).

## Gateway error hints can disappear at the Agent transport

- **Symptom:** protected scene writes were refused with the right reason, but the Agent's MCP result and browser transcript omitted the `scene.propose` recovery hint.
- **Cause:** `VisError.details` and RPC `ErrorData` carried `hint`, while MCP rebuilt its error object with only code, message, conflicts, reason and params.
- **Instead:** forward the declared Agent-facing hint explicitly, without spreading arbitrary error data. Verify the entire fake-Agent-to-MCP-to-gateway-to-transcript path as well as the gateway response; whole-scene deletion needs its own guidance because only the author can delete a protected scene.
- **Found in:** [RFC 0037 refusal e2e](../rfc/0037-interactive-scene-nodes.md#as-built-steps-c-and-d-2026-11-10), `apps/cli/src/mcp.ts` and `apps/web/e2e/scene-protected-writes.e2e.ts`.

## A default-model probe can disrupt an ACP resumed session

- **Symptom:** the first CodeBuddy turn after a daemon restart stayed running without updates or a prompt response.
- **Cause:** the default-model cache was empty, so the runtime opened and closed a throwaway session after loading the real session. That lifecycle switched the Agent's active session and broke forwarding of its model reply.
- **Instead:** when a resumed turn needs an uncached default, probe and close before resume, then configure and prompt only the turn's session. Keep opaque model IDs unchanged. Bound post-admission silence generously, reset on updates and Agent requests, suspend while approvals await the author, and hard-stop a silent process with a failure notice.
- **Found in:** [RFC 0041 restart resume fix](../rfc/0041-acp-agents.md#as-built-restart-resume-and-inactivity-safeguard-2026-11-11).

## Literal vendor prompt identifiers can contain Han characters

- **Symptom:** adding the documented Seedance reference identifiers made the English-only guide test fail.
- **Cause:** the vendor's literal prompt syntax includes Han characters even when the surrounding guide is English.
- **Instead:** permit only backticked, numbered video, image and audio reference identifiers in the generation guide. Strip those exact tokens before checking its prose; every other Han character and all other guides keep the full check.
- **Found in:** [RFC 0043 §3](../rfc/0043-video-references-and-media-hosting.md#3-seedance-video-references-ark-adapter).

## An ACP Agent may advertise a configuration choice it then refuses

- **Symptom:** no MiniMax Code session could start, and the model list was empty.
- **Cause:** the Agent listed four model choices but refused one of them with a JSON-RPC error when it was selected. The shared runtime treated one refusal as a failed probe and dropped the whole list.
- **Instead:** treat an advertised list as a claim, not a guarantee. Probe each choice and leave out the ones refused with an error reply; a closed connection or a timeout still fails the probe, and refusing every choice fails with the Agent's last error.
- **Found in:** 05fb043, RFC 0041 step d findings.

## Tool identity can be wrapped: CodeBuddy calls MCP tools through `DeferExecuteTool`

- **Symptom:** vis tool calls from CodeBuddy asked for approval instead of being auto-accepted like in every other Agent.
- **Cause:** CodeBuddy loads MCP tools lazily. The model finds them with `ToolSearch` and invokes them through a wrapper; the permission request names the wrapper in its metadata and the real target in `rawInput.toolName`.
- **Instead:** take tool identity from the wrapped target only when the metadata names the known wrapper and the target matches `mcp__vis__*`. Any other wrapped target keeps asking. Check each new Agent's permission requests for wrappers before assuming the tool name is at the top level.
- **Found in:** 905f90f, RFC 0041 step d findings.

## Working media disappears after locating it

- **Symptom:** a generated video was visible only just after Locate, then disappeared from the canvas again.
- **Cause:** the Agent created the video with `purpose: 'working'`, which the canvas hides by default; Locate reveals only the selected node temporarily.
- **Instead:** reject agent media creation as `working` or metadata that changes media from `artifact` to `working` at the gateway, checking existing state and batch tempIds in the write transaction. Allow metadata that preserves an already-working purpose. Leave media purpose unset (`artifact`), allow text, script and timeline working documents, and preserve the author's ability to hide any node.
- **Found in:** [RFC 0016 agent media visibility](../rfc/0016-canvas-organization.md#agent-media-visibility), `services/studiod/src/canvas-permissions.ts`.

## New permission rules must not block successful request replays

- **Symptom:** an identical retry of a previously successful canvas request was rejected by a newly added media permission rule.
- **Cause:** the gateway ran the rule before canvas application's `runIdempotent` could return the saved result.
- **Instead:** pass server-only authorization into the canvas write callback, after replay lookup and fingerprint validation, so only new requests encounter the current rule and its reads still share the write transaction.
- **Found in:** [RFC 0016 agent media visibility](../rfc/0016-canvas-organization.md#agent-media-visibility), `packages/canvas/core/src/service.ts` and `services/studiod/src/gateway.ts`.

## Reviewable tool results must survive transcript truncation

- **Symptom:** a scene proposal with many changes cannot be reconstructed from a session's tool-result text.
- **Cause:** adapters truncate human-readable tool logs to 4,000 characters, which can cut a valid JSON result halfway through an item.
- **Instead:** parse the full successful output first and persist a validated structured receipt alongside the truncated text, in every adapter path. Scene changes also replace whole content objects: preserve only server-owned metadata and stills, so omitting an optional track really removes it.
- **Found in:** [RFC 0044 as built](../rfc/0044-scene-change-proposals.md#as-built--steps-a-and-c).


## A refresh failure must not become a permanent review decision

- **Symptom:** a transient query failure or corrupt scene could permanently stale every pending change, and mutations outside the gateway could skip review refreshes.
- **Cause:** a broad catch treated all source-read errors as deletion, while refresh calls were maintained separately in each service.
- **Instead:** distinguish missing or deleted sources from unexpected failures, propagate unexpected errors to roll back the mutation, and call one shared review refresher after each canvas write. Group proposals by slot before reading documents and coalesce resolution and refresh notifications for each row.
- **Found in:** [RFC 0044 review fixes](../rfc/0044-scene-change-proposals.md#review-fixes-for-steps-a-and-c).

## "Page unavailable" from an Agent needs evidence

- **Symptom:** a Codex session told the author the vendor's prompt guide could not be opened, but the page answered HTTP 200 to `curl` and the transcript showed no attempt to fetch it.
- **Cause:** the guide said "open the page" without saying how and allowed "say so and continue" without asking for a try; Codex ran with its default web search, which reads a cached index; and `webSearch` items were dropped from the transcript, so nobody could check.
- **Instead:** give Agents a concrete way to do a step (their web tool or `curl -sL`), ask for the URL and error when they report a failure, keep their native tools on, and show every native tool call in the transcript.
- **Found in:** [RFC 0048](../rfc/0048-agent-native-capabilities.md#background).


## Catalog validation yields before a child session write

- **Symptom:** a parent passes an early permission check, but the child is reparented or its main session changes while the model catalog is being read; an old retry can also overwrite a later author setting.
- **Cause:** catalog probes are asynchronous, while work-item relationships and main-session routing can change before the synchronous SQLite write transaction starts.
- **Instead:** look up successful request replays before probing, validate with the shared session validator and per-kind cache, then require a caller resolver at the work-service boundary and resolve it unconditionally again in the write transaction. Use that fresh actor to check the active turn, caller identity, direct-child relationship and main-session identity. A replay returns its saved result without applying it again. Tests that need several messages in one batch should dispatch inactive, then activate and enqueue the messages synchronously: awaiting an active dispatch lets dequeue begin.
- **Found in:** [RFC 0049](../rfc/0049-child-agent-model.md#implementation-notes-2026-11-13), `services/studiod/src/work-service.ts`.

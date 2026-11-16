# RFC 0051: Viewed images in the session transcript

Status: implemented (2026-11-16; accepted by the maintainer on the same date). Builds on the transcript tool groups (`packages/workbench/ui/src/toolGroups.ts`), media inspection (`asset_frames`, workbench guide `media.ts`) and RFC 0048 (agent-native capabilities).

## Problem

When an Agent inspects pictures (a generated image, frames sampled from a video, a reference) the author cannot see *which* pictures it looked at:

- Codex reports an `imageView` thread item with a `path`. `packages/workbench/codex/src/translate.ts` has no case for it, so the view is dropped from the transcript entirely.
- Claude Code views images with `Read`. The tool result's image block is flattened to the text `[图片]` (`packages/workbench/claude/src/translate.ts`, `resultText`).
- dsh and other ACP agents: image content in `tool_call_update` is flattened the same way (`packages/workbench/core/src/acp/translate.ts`, `contentText`).

The author sees, at best, "called Read" with a JSON path. They cannot tell whether the Agent's critique of "shot 3" was based on the right frame, which is exactly the moment they need to check its work.

## Goals

- Every image the model actually received appears in the transcript as a thumbnail, grouped like other tool calls: "Viewed 5 images" with a grid.
- One normalized payload field across Codex, Claude Code and ACP adapters; the UI does not learn adapter-specific tool names.
- Frames extracted from a video say where they came from (source video and timestamp) when that is known.
- No new file-serving surface: thumbnails are served only for paths that resolve to assets registered in the project.

## Non-goals

- Previewing images that are not project assets (scratch files the Agent made in its workDir, files elsewhere on disk). They render as a filename placeholder. Serving them would be a new file route; revisit only with a separate security review.
- Showing images that reached the model in other ways (user attachments are already shown; images inside MCP tool results such as `asset_frames` output are paths, not pixels).
- Judging or annotating what the Agent saw. The product shows the evidence; interpretation stays with the author.

## Contract

### Transcript payload (`packages/protocol`)

`tool_call` payloads gain an optional field, written by adapters:

```ts
// Images whose pixels were delivered to the model by this call. Paths are absolute local paths as the Agent supplied them.
viewedImages?: { path: string }[]   // max 32 entries, path max 4096 chars
```

It is set only when the model *received image content*. A failed read, a non-image file or a path that was only mentioned does not count. When this can only be known from the result (Claude `Read`, ACP), the adapter writes the field on the `tool_result` payload instead; `groupTranscript` merges call and result, so the UI reads it from either side of the pair.

Add the zod schema next to the existing tool payload schemas and cover it in `protocol.test.ts`.

### Path resolution: `asset.resolvePaths` (caller: `ui` only)

```ts
input:  { paths: string[] }               // 1..64, deduplicated by the client
output: { results: (ResolvedPath | null)[] }  // same order as input
ResolvedPath = {
  assetId: string                 // lets the UI invalidate cached entries from asset events without another request
  assetVersionId: string
  kind: 'image' | 'video'
  displayName?: string
  frameOf?: { assetVersionId: string; displayName?: string; atMs: number }  // when the asset is a frame extracted from a video
}
```

- Resolution happens in studiod. Blobs live at `<blobsDir>/<hash[0:2]>/<hash>` with no extension (`packages/assets/src/assets.ts`, `blobPath`). Canonicalize the input path (realpath; a missing file resolves to `null`), require that its parent is exactly `realpath(blobsDir)/<first two chars of the name>` and that the name matches `^[a-f0-9]{64}$`, then pick the newest non-archived asset version with that `blobHash`. Anything else returns `null`. Never read the file or return its contents, and never echo a path back.
- `frameOf` is **not filled in this step**. Frame extraction (`prepareFrameExtraction` in `services/studiod/src/media.ts`) records the source only in the default display name `<assetId>@<atMs>ms`, which the author can rename; parsing it is not acceptable. The field stays in the schema as optional so the follow-up needs no contract break.
- Thumbnails use the existing asset route (`/assets/<spaceId>/<assetVersionId>`), so no new HTTP surface.
- Not exposed to Agents (they already have the path); register it in `methods.ts` with callers `['ui']` and extend `capabilities.test.ts`.

## Adapters

| Adapter | Signal | Where the path comes from |
|---|---|---|
| Codex (`codex/src/translate.ts`) | `imageView` thread item | `item.path`. Emit a `tool_call` named `view_image` with `input: { path }` and `viewedImages: [{ path }]`, and on completion a successful `tool_result`. Confirm the item's field names against the installed Codex app-server schema (`codex app-server generate-ts`) and pin them in a translate test. |
| Claude Code (`claude/src/translate.ts`) | `tool_result` whose content contains an `image` block | `input.file_path` of the matching `Read` call. The translator sees call and result in different messages, so keep a small per-run map `toolUseId → file_path` for `Read` calls. |
| ACP / dsh (`core/src/acp/translate.ts`) | `tool_call_update` with `status: 'completed'` whose content contains an `image` block | First of `rawInput.path`, `rawInput.file_path`, `locations[0].path` recorded at `tool_call` time. |

The `[图片]` placeholder text in result summaries stays for now (it feeds the text preview). It is Agent-visible prose, not UI copy, so it does not need a dictionary.

Fake Codex (`apps/web/e2e`) gains an `imageView` emission so the browser test exercises the real adapter path (see `docs/lessons/ui.md`, "Fake CLI calls do not create transcript tool receipts").

## UI (`packages/workbench/ui`)

### Grouping

In `groupTranscript`, a run of consecutive tool pairs where every pair has `viewedImages` becomes its own group kind:

```ts
{ kind: 'images'; itemId: string; calls: ToolCall[]; paths: string[] }   // paths flattened, deduplicated, in order
```

A tool call without `viewedImages` ends the run, so the transcript order stays truthful. A run of one image is still an `images` group.

### Viewed-images block

- Summary row: image icon + "Viewed N images" / "已查看 N 张图像", a chevron, expanded by default while the turn is running and for the latest turn. Blocks in older turns start collapsed when the transcript loads; a block opened automatically while it was the latest turn stays open when a newer turn starts (the UI never collapses on its own), and the author's toggle always wins. Use `onToggle` for history scroll anchoring.
- Grid of 16:10 cards, `clamp(120px, 30%, 168px)` wide (about three per row in a normal panel), with `object-fit: contain` on a neutral background so letterboxed frames read correctly. Small mention-sized thumbnails were too small to tell frames apart.
- Each tile:
  - resolved image → `<img loading="lazy">` from the asset route; `aria-label` = display name or file name. (When `frameOf` lands, a caption "Frame of «video» · 0:03.2" formatted with `useFormat()`; not in this step.)
  - unresolved → placeholder card with the image icon, the file name (basename only, no full path on the face; full path in `title`) and a one-line "Not a project asset" label inside the card.
  - pending call (no result yet) → skeleton tile.
  - failed call → the existing error state; it does not count toward N.
- Click on a resolved tile: if a canvas node uses that asset version, locate it (`onLocateRef`); otherwise open the existing asset preview dialog. Unresolved tiles are not interactive.
- "Show details" inside the block opens the existing per-call JSON view, so nothing is lost compared to today.
- More than 12 tiles: show 11 + "+N" (same pattern as `RefThumbs`).
- Resolution goes through one batched `asset.resolvePaths` request per transcript render pass, chunked at 64, cached by path for the session; an `asset.updated` or `asset.versionAdded` event drops cached entries with that `assetId`, with no extra request.

When the adapter knows at call time that image content is being viewed (Codex), `activityText` while that call is running reads "Viewing images…" / "正在查看图像…" instead of the raw tool name. Claude and ACP learn this from the result, so they show the normal tool label until the result arrives.

All copy lives in `messages.ts` (zh-CN and en). Respect `prefers-reduced-motion` for the skeleton shimmer.

## Security and privacy

- Path resolution only confirms that a path is a project blob and returns IDs that the UI can already list. It reveals nothing about files outside the blob directory, not even whether they exist (`null` either way).
- The basename of an unresolved path is shown to the author only. It comes from the Agent's own transcript, which the author can already read.
- No change to Agent permissions or sandboxes.

## Implementation split

Two workers, split by directory:

1. **Contract, gateway and adapters**: `packages/protocol`, `services/studiod` (method handler), `packages/workbench/{codex,claude,core}` translators and tests, fake Codex image emission under `apps/web/e2e` fixtures.
2. **UI**: `packages/workbench/ui` (grouping, block, messages, CSS), wiring of `resolvePaths` in `apps/web/src/client`, browser e2e for the block. Worker 2 codes against the protocol types from worker 1's first commit; worker 1 lands the protocol change first and announces it.

## Acceptance

- Unit: translators emit `viewedImages` only when image content reached the model (Codex `imageView`; Claude `Read` with image block versus text file; ACP with and without image content). Grouping splits runs at non-image calls. `asset.resolvePaths` resolves blob paths, returns `null` for outside paths, symlinks out of the blob directory, missing files and `../` tricks, and rejects Agent callers.
- e2e: fake Codex views two extracted frames and one workDir scratch file; the transcript shows "Viewed 3 images" with two thumbnails and one placeholder; clicking a thumbnail locates its node or opens the preview.
- `pnpm check`, `pnpm build`, e2e twice in a row.
- README (en + zh-CN) roadmap entry; a `docs/lessons/` entry if an adapter's image signal turns out to be non-obvious.

## Follow-ups

- Durable frame provenance for `frameOf`: nullable `source_asset_version_id` / `source_at_ms` on `asset_versions`, written by frame extraction (`asset.extractFrames` and `media_process` extract-frames), via `db:generate`.
- Optional workDir image preview behind a dedicated, security-reviewed route.
- Showing the images a child work item viewed inside its report.

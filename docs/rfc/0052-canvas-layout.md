# RFC 0052: Canvas layout

Status: implemented (2026-11-25), with the decisions and implementation notes below. Accepted by the maintainer on 2026-11-24. Revises [RFC 0016](0016-canvas-organization.md) §2 (placement and Organize) and §4 (frames). Builds on the proposal pattern of [RFC 0031](0031-manuscript.md) and [RFC 0044](0044-scene-change-proposals.md), and on shot links from [RFC 0023](0023-script-nodes.md).

## Problem

A review of canvas organization on 2026-11-24 found these gaps. Every claim below was checked against `main` at `6c56baa1`.

1. **Organize knows one layout.** `arrangeCanvas` (`packages/canvas/ui/src/organization.ts`) only groups by `category`. Nodes a script produced already know their shot and role (`NodeView.shot`), but the shot group is not laid out in shot order. There is also no way to tidy a selection in place without creating frames.
2. **The grid is rigid.** The planner uses 1 column below 4 members and 2 columns otherwise, so 40 shots make a 20-row strip. Every cell takes the height of the group's tallest member, so one portrait image among landscape videos leaves a gap of about 220 px in every row. Every member is stretched to the group's widest card, so a 480 px script node widens every image.
3. **The author cannot manage frames.** The protocol has `frame.create` and `frame.update` (title, eight colors), but only Organize calls them. The UI has no way to frame a selection, rename a frame or recolor one. Frames only grow (RFC 0016 §4), and nothing shrinks a frame back to its content.
4. **There are no selection layout tools.** No align, distribute or grid for a selection. Snapping during a drag is off (no `snapToGrid`, no guides). Multi-selection has no toolbar: `NodeOperationsToolbar` appears only for a single node.
5. **Organize stops at 200 operations.** It builds one `canvas.apply` batch, and `canvas.apply` caps batches at 200 ops (`packages/protocol/src/canvas.ts`). A canvas near 200 nodes cannot be organized whole. Script batches reach that size quickly.
6. **Agents can move anything.** Neither the gateway nor canvas core restricts an Agent's `node.layout` or `frame.move`, so a turn can silently undo an arrangement the author made by hand. Agents also have no way to offer a tidy-up for the author to accept.

The defect where Organize reset each group to creation order is fixed separately (2026-11-24, branch `canvas-tidy-reading-order`): members keep their reading order, and organizing an organized canvas changes nothing. This RFC builds on that rule.

## Product principle check

- **Mechanism, not taste.** Every layout here is a mechanical rule on data the author controls: their categories, their script's shot order, the order they already arranged. Column count and grid choices are offered in the preview, not decided for the author. Nothing infers content or scores a layout.
- **Agents propose, the author decides.** An Agent places a node only when it creates it. After that it can only propose an Organize, and the author applies it with one click.
- **The author's work is protected in the gateway.** Positions the author set are refused to Agent writes by the gateway, not by prompt wording.
- **Defaults stay optional.** Organize stays a button the author presses. Nothing runs automatically. Every new tool can be ignored.

## Goals

- Organize offers three modes: by category, by script, and in place. The author picks the column count in the preview.
- The grid wastes no rows on mismatched heights and never stretches small cards to fit a large one.
- The author can frame a selection (⌘/Ctrl G), rename and recolor a frame, and fit a frame to its content.
- A selection of two or more nodes gets align, distribute and grid tools. Dragging snaps to nearby edges and centers.
- Organize works on canvases of up to 1000 nodes in one undo step.
- Agents never move existing nodes; they propose an Organize instead.

## Non-goals

- Automatic layout, including after generation or after an Agent turn.
- Classifying content or inferring categories.
- Freeform layout algorithms (force-directed, masonry). Masonry breaks reading order, which the author would then have to fight.
- Moving frame growth from the UI into canvas core (RFC 0016 §4 "not yet").
- Protecting frame titles and colors from Agents. Only layout is protected in this RFC.

## Design

### 1. Shared planner: `@vis/canvas-layout`

The planner moves out of `canvas-ui` into a new pure package, `packages/canvas/layout` (`@vis/canvas-layout`), which depends only on `protocol`. This follows `scene-core`. `canvas-ui` and `canvas-core` both import it, so the preview and the server compute the same plan from the same input. `scripts/check-boundaries.mjs` gets a rule: `'canvas-layout': ['protocol']`, and `canvas-ui` and `canvas-core` may depend on it.

The package exports two pure functions: `planOrganize` below and `organizePlanDigest(plan)` (§4). The mode, column and limit types come from `protocol` (`OrganizeMode`, `OrganizeColumns`, `ORGANIZE_LIMITS`).

```ts
planOrganize(input: {
  nodes: NodeView[]                 // all nodes, including hidden working ones; script mode reads shot order from each script node's main slot
  mode: 'category' | 'script' | 'inPlace'
  nodeIds?: string[]                // selection; absent means the whole canvas
  columns?: number | 'auto'         // 1-8, default 'auto'
  removeEmptyFrames: boolean
  titles: { uncategorized: string; untitledScript: string }  // localized by the caller
}): OrganizePlan

type OrganizePlan = {
  ops: CanvasOp[]                   // node.layout, frame.create, node.delete (empty frames only)
  groups: { title: string; frameId: string | null; nodeIds: string[]; x: number; y: number; w: number; h: number }[]
  removedFrames: { nodeId: string; title: string }[]
  untouched: string[]               // selected nodes this mode does not place
  insufficientSelection?: true     // inPlace has fewer than two selected content nodes
  tooLarge?: { count: number; limit: number } // distinct nodes affected by ops, including frames
}
```

It never emits content, category or purpose changes. Working nodes are skipped, as today.

### 2. Organize modes

**By category** is the current behavior with the new grid (§3): one frame per category, upstream categories to the left, frames reused by title, anchored packing for selections.

**By script** places nodes that carry a `shot` link. There is one frame per script node, titled with the script node's title, or `titles.untitledScript` when it has none. Inside it:

- Rows follow the script's shot order (`ScriptDoc.shots`, which the author reorders with `shot.move`); shots with no linked members add no row or gap.
- Columns follow roles in a fixed order: `first`, `last`, `video`, `previz`. Only roles that occur get a column.
- Several nodes for the same shot and role sit side by side in that cell, in reading order.
- Selected nodes without a shot link, or whose script node is deleted, are not moved. The preview lists them as `untouched`.

**In place** creates no frames. It needs at least two selected nodes. It arranges the selection into a grid anchored at the selection's top-left corner, in reading order. Nodes stay in their frames: a selection that spans frames is arranged per frame, inside each frame, and the frame grows if needed. Framed rows keep their anchor x and shift below unselected members and nested frames with an 80 px gap. On the open canvas the grid avoids other nodes like the anchored packing does today.

The preview dialog gets a mode switch (category, script, in place) and a column control (auto, 1-8). The planner reruns as the author changes them. Modes that do not apply are disabled with the reason: script mode with no linked nodes, in-place mode with fewer than two selected nodes.

### 3. The grid

The grid is shared by all three modes:

- **Columns.** In `auto` mode, pick the column count from 1 to 8 whose grid bounds come closest to a 4:3 box. The author can override this in the preview. Script mode takes its columns from roles and ignores this setting.
- **Rows.** Each row is as tall as its tallest card, not as tall as the group's tallest card.
- **Widths.** Images and videos in a group share one width: the largest media width in the group, at least 320 px. They keep their aspect ratio through the existing `fittedHeight` clamp. Other kinds (text, script, timeline, previz, scene, audio) keep their own size. Each column is as wide as its widest card, and cards are left-aligned in their cells.
- **Order.** Reading order (the defect fix), with `nodeId` breaking ties.
- **Idempotence.** Organizing with the same mode and columns on its own output produces no ops.

### 4. `canvas.organize`: server-side apply

A new method, `canvas.organize` (caller: `ui`):

```ts
params: {
  requestId, mode, nodeIds?, columns = 'auto', removeEmptyFrames, titles, description?,
  planDigest: string   // organizePlanDigest(plan) of the plan the author previewed
}
result: { operationId, idMap, changed: number /* >= 1 */, eventSeq }
```

The server reads the canvas in the write transaction and runs `planOrganize` with the same inputs. If `organizePlanDigest` of that plan differs from `planDigest`, it rejects the request with `revision_conflict` and reason `canvas.organize_plan_changed`, and the UI recomputes the preview. Otherwise it applies the ops as one undo entry described as "Organize canvas". The digest covers the planned ops and guarantees that the applied operations equal the previewed operations. Intervening edits that leave those operations identical are deliberately accepted. Per-node revisions would miss outcome-changing shot reorders: a shot reorder changes no node's `layoutRevision`, but changes the ops when linked nodes must move. `@vis/canvas-layout` exports `organizePlanDigest(plan)`: a stable hash of the ops in order, with a fixed property order and frame tempIds that are already deterministic. The UI and the server must call the same function. An empty plan returns `invalid_params` with reason `canvas.organize_nothing`. The plan may hold up to 1000 nodes. Larger plans return `invalid_params` with reason `canvas.organize_too_large`, and the UI asks the author to select fewer nodes. The 200-op cap on `canvas.apply` stays unchanged. The UI stops building a `canvas.apply` batch for Organize.

Idempotency follows `runIdempotent`: the same `requestId` replays the stored result.

### 5. Frames the author manages

- **Frame a selection: ⌘/Ctrl G.** This creates a frame around the selected nodes' bounds, with the same padding and header as Organize, and selects the frame's title for editing. The default title is "Frame" or 「框」. The server assigns membership from center points as it does today. Selected nodes that are already in different frames are refused with an inline hint: framing across frames would silently change membership.
- **Rename.** Double-click the frame title, or use the frame's context menu → Rename. Enter or blur saves with `frame.update`, and Escape cancels. All frames are renameable: RFC 0010 removed frame-to-work-item binding.
- **Color.** The frame context menu → Color, with the eight `FrameColor` swatches, each with an accessible name.
- **Fit to content.** The frame context menu → Fit to content. It sets the frame to its members' bounds plus padding and header, but no smaller than `FRAME_MIN_SIZE`. Ancestor frames do not shrink. An empty frame offers Delete instead.
- Frames still only grow automatically, and fitting is always the author's action.

### 6. Selection layout tools

When two or more nodes are selected, a selection toolbar appears above the selection bounds. It uses the same placement rules as `NodeOperationsToolbar`.

- **Align** left, horizontal center, right, top, vertical middle, bottom.
- **Distribute** horizontally or vertically. This needs three or more nodes. It spaces the gaps between nodes evenly and keeps the outermost nodes in place.
- **Tidy** runs the in-place Organize mode (§2) directly, with auto columns and no dialog. It can be undone like any other action.

Align and distribute each use one `canvas.apply` batch; Tidy uses one `canvas.organize` call. Each tool is one undo step. Results are clamped to each node's frame, exactly like dragging. If a frame member would cross its frame's edge, it stops at the edge.

**Snap guides.** While dragging, a moving card's edges and center snap to the edges and centers of visible nearby cards within 6 screen pixels. Matching guides are drawn in `--vis-accent`. Holding Alt (Option on macOS) suspends snapping during the drag. Only nodes inside the viewport are candidates, so snapping costs nothing on large canvases. Guides appear without animation.

Shortcuts: ⌘/Ctrl G (frame selection) and Alt (suspend snap) join the shortcut list in `shortcuts.tsx` and the README tables. Align and distribute get no shortcuts in this RFC.

### 7. Agents

**7.1 Agents place only at creation.** An Agent positions a node only in the batch that creates it: a position on `node.create` or `frame.create`, or a later `node.layout` / `frame.move` in the same batch that names the new node by its batch-local tempId. After that batch, the Agent cannot move or resize the node; it proposes an Organize instead (7.3).

Today's instructions already tell Agents to leave positions to the server (`prompt.ts`: create without coordinates and read the returned `placements`). Nothing asks them to move existing nodes, so the rule takes away nothing an Agent is meant to do. It turns that instruction into a gateway rule.

This needs no new data: there is no "who placed it" column and no migration. Server mechanisms are not Agent writes and are unaffected: placement at creation, delivery growth (the `fitNodeToAsset` push-down), and ancestor-frame growth when a node lands in a frame.

**7.2 The gateway refuses.** An Agent `canvas.apply` batch is rejected atomically with `forbidden` and reason `canvas.layout_protected` when it contains either of the following:

- `node.layout` with `x`, `y`, `w` or `h` on a node that existed before the batch.
- `frame.move` of a frame that existed before the batch.

Error params name the `nodeId`. Changes to `z` alone are allowed. The check tracks tempIds in operation order. It runs inside the write transaction, through the same server-only authorization callback used for working media (RFC 0016 "Agent media visibility"). Earlier successful requests remain replayable.

*Considered:* a per-node `layoutBy` stamp, which would let an Agent keep adjusting its own results until the author touches them. It needs a column, a migration and a stamping rule for every write path, and no current workflow needs it. If one appears, the stamp can be added later without changing 7.2's error contract.

**7.3 Proposals.** Three methods. The contract differs from this sketch in how a plan is guarded; see "Step d contract" below.

- `canvas.organize.propose` (caller: `agent`): `{ requestId, mode, nodeIds?, columns?, reason }`. The server plans immediately. An empty plan returns `invalid_params` with reason `canvas.organize_nothing`. It stores `{ proposalId, sessionId, mode, nodeIds, columns, reason, planDigest, plan summary }`. A new proposal from the same session supersedes that session's pending one. Each project holds at most 20 pending proposals, and the oldest expires first.
- `canvas.organize.proposals` (callers: `ui`, `agent`): lists proposals with their state: `pending`, `applied`, `dismissed`, `stale` or `superseded`.
- `canvas.organize.resolve` (caller: `ui` only): `{ proposalId, action: 'apply' | 'dismiss' }`. `apply` runs the same path as `canvas.organize` with the stored parameters and `planDigest`, as the author's write. If the digest no longer matches, the proposal becomes `stale` and nothing moves. No approval mode, auto-accept or session grant can call `resolve`.

**UI.** A pending proposal shows a quiet bar at the top of the canvas: "Codex suggests organizing 12 nodes by script: *reason* [Preview] [Dismiss]". Preview opens the Organize dialog locked to the proposal's plan. If the author changes the mode or columns there, the result becomes their own Organize, and the proposal is marked dismissed. The session transcript shows the proposal as a card with the same Preview action. The Agent is not notified when the author resolves a proposal, which matches RFC 0044.

**Prompts** (`prompt.ts` for every adapter, plus the Agent-visible method descriptions):

- Leave positions to the server when creating nodes.
- Never move or resize existing nodes; the gateway refuses it. Use `canvas.organize.propose` instead.
- Propose at most once per finished batch of results, and only when the result area is visibly disordered.
- State the reason in one sentence.

### 8. Contract and storage changes (before implementation)

- `packages/protocol`:
  - Add the `canvas.organize`, `canvas.organize.propose`, `canvas.organize.proposals` and `canvas.organize.resolve` methods with callers, and the `OrganizeMode` enum.
  - Add the reasons `canvas.organize_too_large`, `canvas.organize_nothing` and `canvas.layout_protected`, with Chinese and English error messages.
  - Add contract tests in `protocol.test.ts` and `capabilities.test.ts`.
- Storage:
  - Add an `organize_proposals` table, generated with `db:generate`. Nodes get no new column.
  - Add an event for proposal changes so open canvases update without polling.
- Add the `vis` CLI / MCP tool for `propose` and `proposals`.

## Implementation split

Steps are ordered by dependency. Workers split by directory. `CanvasView.tsx` is shared, so steps b and c must not run in parallel with each other or with a's UI part.

- **a. Planner and server Organize.** This step comes first and is mine for the contract. It creates `@vis/canvas-layout` (moving the planner there, plus the modes and the grid), adds `canvas.organize` to the gateway and canvas core, and switches the Organize dialog to mode and column controls and the new method.
- **b. Frames.** Frame a selection, rename, color, fit to content. This is UI-only and uses the existing ops.
- **c. Selection tools.** The multi-selection toolbar, align, distribute, tidy, and snap guides. This is UI-only.
- **d. Agents.** The gateway refusal, proposals, the canvas bar and transcript card, and the prompts. It depends on a.

## Acceptance

- `pnpm check` passes. After `pnpm build`, the full e2e suite passes twice in a row.
- Unit tests:
  - Each mode's layout: category, script (rows by shot order, columns by role, unlinked nodes untouched), and in place (per frame, clamped).
  - Auto columns and author-chosen columns.
  - Row heights per row; media width unified while other kinds keep their size.
  - Idempotence in every mode.
  - The digest conflict (including a shot reorder and a category change after the preview); digest stability across UI and server; the 1000-node bound.
  - The gateway refusal: `node.layout` and `frame.move` on existing nodes are refused, positions in the creating batch (by tempId) pass, `z`-only changes pass, server placement and delivery growth are unaffected, earlier requests replay.
  - Proposal supersede, stale and apply.
  - Align, distribute and snap math.
- e2e:
  - Organize in each mode and undo in one step.
  - ⌘G frames a selection and selects its title for editing; cancelling that edit and undoing once removes the frame and restores ancestor bounds. Saving a new title adds a separate rename step: the first undo restores the default title and the second removes the frame. Rename, recolor and fit also work through the frame controls.
  - Align and distribute three nodes, then undo.
  - A drag snaps to a neighbor's edge, and Alt suspends it.
  - A fake Codex turn's `node.layout` on an existing node is refused with `canvas.layout_protected`.
  - A fake Codex proposal appears as a bar, previews, applies and undoes. After the author moves a node, the preview replans and the apply still matches what the author saw.
- Screenshots (1600×1000, deviceScaleFactor 2) of each mode on a mixed canvas: portrait images, landscape videos, a script node, uncategorized uploads.
- RFC 0016 gets a note pointing here. Update both READMEs (shortcuts and roadmap) and add `docs/lessons/` entries as needed.

## Decisions (maintainer, 2026-11-24)

1. Agents place nodes only in the batch that creates them (§7.1). This replaced a per-node `layoutBy` stamp: the maintainer noted that Agents only move existing nodes when they decide to tidy, which proposals now cover.
2. Snapping is on by default; Alt (Option) suspends it during a drag.
3. Organize handles up to 1000 nodes per run.
4. Auto columns aim for a fixed 4:3 box, not the viewport's aspect.


## Step a implementation (2026-11-25)

The shared `@vis/canvas-layout` package now plans category, script and in-place organization. It depends only on protocol and exports `planOrganize`, `OrganizeInput`, `OrganizePlan`, `organizePlanDigest` and `organizeChangedCount`, plus the existing frame constants, recursive membership and growth helpers, reading order, fitted media height and grid math. Canvas UI keeps its existing helper imports through re-exports; drag and growth behavior is unchanged.

Auto columns compare the content grid's log aspect distance to 4:3 for one through eight columns, preferring fewer on a tie. Numeric counts cap at the member count. Rows use their own tallest card and columns their own widest card; only images and videos share width. Existing frame dimensions only grow. Category ordering, anchored selected packing, cross-language uncategorized frame reuse, optional empty-frame deletion and working-node exclusion remain. Anchored packing shifts complete rows past obstacles to preserve reading order on repeated organization.

Script frames follow main-slot shot order and fixed role columns, with duplicates side by side; shots without linked members add no row or gap, and orphan-shot rows still follow documented shots. The caller supplies fallback titles; unlinked candidates appear in `untouched`. In place requires at least two selected content nodes, groups by innermost frame, shifts complete framed rows below unselected members and nested frames while keeping their anchor x, grows ancestors around the final positions in the same plan, and avoids unselected open-canvas cards. It creates no frames.

`canvas.organize` reads the same NodeViews as the UI inside `runIdempotent`'s write transaction, validates empty/oversized/changed plans, then uses the internal apply path with one operation and one undo entry. Its 1000-node bound counts distinct nodes named by emitted ops, including created, resized and deleted frames; it does not use the public 200-op apply cap. The dialog previews every mode, column and removal change, shows disabled-mode reasons and untouched nodes, and sends the preview digest through the host's new `onOrganize` action. Errors remain inline and rerun the preview.

Clarification approved during implementation: the ops-only digest protects the previewed operations, not the unchanged source canvas. Moving a node that the plan already moves to the same target, or reordering empty shots without changing any op, deliberately keeps the digest. No source fingerprint or protocol change was added. The typed `tooLarge` and `insufficientSelection` fields above extend the illustrative API so callers localize their own feedback.

Known limits: existing title matching supports the product's English and Chinese uncategorized aliases. Shot links whose script still exists but whose shot is absent are placed after documented shots in stable shot-ID order; links to missing scripts stay untouched. Duplicate script titles reuse separate matching frames, preferring current linked membership. Frames still grow conservatively and overlapping manually drawn frames retain the existing geometric membership rules. Steps b–d remain open.

## Step b implementation (2026-11-25)

The author can frame selected content with ⌘/Ctrl G or the node context menu. Selected frames are ignored. The shared planner package now exports selection bounds, the cross-frame check, and direct-member fit bounds using the same padding, header and minimum size as Organize. Empty and frame-only selections do nothing; content with different innermost frame IDs, including open-canvas content mixed with framed content, is refused with an accessible inline hint.

Creation selects the new frame and focuses its title input with the text selected. Double-clicking a title or choosing Rename frame opens the same editor. Enter or blur saves a changed, non-empty trimmed title of at most 60 characters; Escape and empty titles cancel. The input owns keyboard and pointer events. Every current frame is renameable: the earlier read-only-title sentence in §5 was obsolete because RFC 0010 removed frame-to-work-item binding. No protocol or core change is needed.

The frame context menu exposes eight localized color buttons, their current pressed state and arrow-key navigation. Fit to content surrounds direct members, including nested frames, without moving them. It is disabled at an exact fit; empty frames retain Delete instead. Ancestors grow conservatively before the target operation in the same apply batch, since the server recomputes geometric membership after each layout. Ancestors never shrink as a side effect.

Clarification approved during implementation: creating a frame together with any ancestor growth is one apply batch and one undo entry. Saving its subsequent title edit is a separate `frame.update` and undo entry, like other inline editors. Cancelling the initial editor allows one undo to remove the frame; after naming it, undo first restores the default title, then removes the frame. Existing `onApply` returns no ID map, so the UI identifies the newly created frame from its pending creation bounds and the previous node IDs, as it already does for new content nodes.

Unit coverage includes bounds, minimum dimensions, cross-frame refusal, direct nested members, preserved member centers, exact fits, and ancestor growth without shrinkage. Browser coverage exercises creation, title selection, both undo sequences, double-click and menu rename, cancellation, blur save, keyboard color choice, fitting, cross-frame refusal, and nested creation. Shortcut help and both README tables include ⌘/Ctrl G.

Known limits: framing retains the existing center-point membership rule, so unselected nodes enclosed by the new bounds may also become members, and overlapping manual frames retain their existing geometric behavior. No ownership or permission boundary is introduced. The public apply batch limit remains unchanged. Steps c–d remain open.

## Step c implementation (2026-11-25)

Selections of at least two visible nodes get a floating layout toolbar using the existing node-toolbar offset and viewport-obstacle placement. It hides during drags, suspension, dialogs and menus. All nine icon buttons have Chinese and English accessible names and tooltips; keyboard arrows and Home/End navigate the enabled actions. Six aligns use the selection bounds. Horizontal and vertical distribution sort by leading edge, breaking ties by node ID, keep both endpoint nodes in place and equalize the intervening gaps. When the total gap is negative, they space leading edges equally instead. Distribution explains its three-node minimum.

Align and distribute round positions to integers and submit one localized apply batch through the same frame constraint and recursive frame-move helpers as dragging. A selected frame carries its members even when a member is also selected. Members of unselected frames stop at padded frame edges. Tidy computes the shared in-place planner with auto columns and the current selection, sends its digest through one `canvas.organize` call without a dialog, and displays errors through the existing canvas operation alert. Empty, insufficient and oversized plans disable Tidy with localized explanations.

Dragging snaps the moving card or selected group's bounds to nearby edges and centers within six screen pixels, converted with the current zoom. The drag-start snapshot builds deduplicated sorted x/y line indexes from viewport-intersecting visible nodes, excluding all dragged nodes and their recursive frame members. Each pointer move queries three moving lines per axis with binary search; it does not rescan candidates. Snapping precedes frame clamping, and guides invalidated by clamping disappear. Guides are one CSS pixel in screen space, use the accent theme variable and have no animation. Alt/Option keydown and keyup immediately recompute the latest raw pointer layout, so snapping suspends and resumes without pointer motion. The snapped and clamped preview is committed in the existing single drag write.

Pure math and integration tests cover every align, distribution gaps/ties/overlap, frame clamping and recursive moves, zoom thresholds, nearest lines, group bounds and candidate exclusions. Browser acceptance covers toolbar visibility, distribution reasons, align/distribute/Tidy and their single undo, edge snapping, Alt bypass and mid-drag suspension/resumption. Shortcut help and both README tables include Alt/Option.

Known limits: integer rounding can make distributed gaps differ by one canvas unit when the available gap is not divisible evenly; integer positions also cannot always match a half-unit center line exactly, and no guide is drawn for such a rounded mismatch. Align and distribute retain the public apply batch limit; recursive frame moves do not expand members into separate operations. The candidate index is fixed until the next drag, so nodes newly entering the viewport during auto-pan become candidates on that next drag. No protocol, storage, server or Agent-facing behavior changed. Step d remains open.

## Step d contract (2026-11-25)

Committed on this branch before step d's implementation. It changes how 7.3 guards a plan:

- **The proposal stores parameters, not a digest.** Frame titles are localized by the author's UI (the uncategorized frame, an untitled script's frame), and titles are part of the plan. The server cannot know them when the Agent proposes, so a digest stored then could never match the author's preview.
- `canvas.organize.propose` (`agent`): `{ requestId, mode, nodeIds?, columns, reason }`, with `reason` at most 300 characters. The server plans immediately with neutral titles, only to refuse an empty or too-large plan (`canvas.organize_nothing`, `canvas.organize_too_large`) and to record `changed`, the count the bar shows.
- `canvas.organize.resolve` (`ui`), with `action: 'apply'`, carries the same author-side fields as `canvas.organize`: `removeEmptyFrames`, `titles`, `description` and the `planDigest` of the preview on screen. The server replans the stored parameters on the current canvas with those fields:
  - a digest mismatch fails with `revision_conflict` / `canvas.organize_plan_changed` and the proposal stays pending, exactly as for `canvas.organize`;
  - an empty plan marks the proposal `stale` and moves nothing.
- The author always applies through a preview, so a move after the proposal no longer makes it stale. The author approves the plan they see, which is the guarantee that matters.
- States: `pending`, `applied`, `dismissed`, `stale`, `superseded` (a newer proposal from the same session) and `expired` (pushed out by the 20-pending cap, oldest first).
- Resolving a proposal that is no longer pending fails with `already_resolved` / `canvas.organize_proposal_closed`.
- The Agent refusal is `forbidden` / `canvas.layout_protected` with `{ nodeId }`.
- Event `canvas.organizeProposalChanged` with `{ proposalId, status }`.
- Until step d lands, the gateway answers `canvas.organize.propose` and `.resolve` with `unavailable` / `canvas.organize_proposals_unavailable` and lists no proposals. Step d removes this placeholder and its reason.

## Step d1 implementation (2026-11-25)

The gateway now protects existing node layout in every Agent `canvas.apply` path: ordinary and child-text batches, plus scene-bearing and deletion batches. The server-only write callback checks inside the transaction, after successful idempotency replay. It refuses `node.layout` with x, y, w or h and existing `frame.move` with `forbidden` / `canvas.layout_protected` and the first offending `nodeId`. It tracks creation tempIds in operation order, including tempIds that shadow an existing node ID. Creation coordinates, later layout of newly created tempIds and z-only updates remain available. Missing targets still reach the normal not-found checks. UI writes and server placement, delivery fitting, push-down and ancestor growth are unaffected.

Generated space migration `0035_melted_mordo` adds `organize_proposals`. As for scene proposals, shared `idempotency_keys` stores request fingerprints and original results, with the proposing session included in the fingerprint. Proposals retain mode, optional selection, columns, a one-sentence reason, the initial changed-node count, status, timestamps and the accepted operation ID. They store no digest. Proposing uses all current NodeViews, removes empty frames and plans with neutral titles (`Uncategorized` and `Script`); empty, insufficient in-place and oversized plans fail before any existing proposal changes.

A valid proposal supersedes that session's pending proposal and expires the oldest when the project exceeds 20 pending proposals. Each state change emits `canvas.organizeProposalChanged` in the same transaction. Lists return newest first; `all` includes at most 200 entries, while `pending` includes every pending proposal. Equal timestamps use SQLite insertion order because the current ULID suffix is random within one millisecond.

Only the UI can resolve. Apply replans the stored parameters using the author's current titles and empty-frame choice in one write transaction. An empty plan becomes `stale` without an operation; changed preview ops return `revision_conflict` / `canvas.organize_plan_changed` and leave the proposal pending. A matching plan uses the same internal Organize function as `canvas.organize`, records a `user` operation with the supplied description and one undo entry, then marks the proposal `applied`. Its returned `eventSeq` includes the final proposal event. Dismiss marks it `dismissed`; closed proposals return `already_resolved` / `canvas.organize_proposal_closed`, and unknown IDs return `not_found`. Successful propose and resolve requests replay their original results without emitting events or repeating writes.

Gateway method caller checks run before handlers and do not consult approval modes or session grants. Tests exercise denial before and after automatic command approval and an exact session grant for the resolve tool. The Agent capability catalog and MCP list omit resolve. Propose requires an active turn and a linked, unarchived session with an executable work item, rechecked in the write transaction. Both callers can list proposals. The placeholder handlers and both localized placeholder messages are removed.

Shared always-loaded guidance and the canvas guide tell Agents to leave creation positions to the server, never move or resize existing nodes, and offer `canvas.organize.propose` at most once per finished batch, only when the result area is visibly disordered, with a one-sentence reason. Codex and DeepSeek inherit that guidance through their existing shared prompt wrappers; Claude's prompt carries the same rule with its registered MCP tool name. CLI commands and MCP tools derive automatically from method metadata; no command entry was needed.

Limits and remaining work: session/work-item archival and deletion retain pending organize proposals, matching scene proposals; authors can still review or dismiss them. Undo reverses the canvas operation but keeps the proposal resolved, matching the existing review pattern. Step d2 adds the proposal bar and transcript card; no canvas or transcript UI changes are included here. Step c is developed separately and was not present on this implementation's base.

## Step d2 implementation (2026-11-25)

One project cache loads pending suggestions independently of the newest 200 history entries, so the history limit cannot hide an older pending suggestion. It refreshes on `canvas.organizeProposalChanged` through the connection's existing sequence deduplication, coalesces overlapping reads and discards responses after project changes. Reconnecting reloads the cache. Session titles come from session data, including archived sessions loaded on demand. UI packages receive protocol views and host callbacks; no backend or contract change was needed.

The canvas has a quiet, named status bar below the canvas/board switch. It shows the newest pending suggestion's session, localized changed-node count, mode and plain-text reason, with Preview and Dismiss. The single-line reason truncates visually with its full text in the title. A localized more button cycles through other sessions' pending suggestions; a new newest suggestion resets the choice. The bar hides while the canvas is suspended or hidden and has no entrance animation.

Preview opens the existing Organize dialog with the stored mode, selection and columns. The author plans against the current complete canvas with their localized fallback titles and empty-frame choice. Missing selected nodes are skipped without broadening the selection to other nodes. An empty or insufficient plan explains that nothing remains and offers Dismiss as its only footer action. Changing mode or columns permanently turns that preview into the author's own Organize, hides the reason and preserves its scope; returning a control to its original value does not relock it. Changing the empty-frame checkbox keeps the proposal path. Script columns remain editable in a proposal preview even though the script planner continues to use role columns.

An unchanged preview sends `canvas.organize.resolve` with the preview digest, titles, empty-frame choice and localized undo description. A changed preview first applies through `canvas.organize`, then dismisses the proposal after that apply succeeds. If dismissal fails, the dialog is already closed and the failure appears as a canvas error; retrying cannot repeat the successful organize. Digest conflicts stay inline and recompute the preview. An apply result without an operation closes the dialog and shows a short nothing-left notice. Preview itself is local and never resolves or applies, regardless of approval mode; browser acceptance explicitly asserts that it sends no resolve request and leaves both the layout and pending state unchanged.

Successful propose tool receipts create compact transcript cards with mode, count, plain-text reason and localized pending/applied/dismissed/stale/superseded/expired status. Status always comes from the project cache, never the transcript. Only a currently pending card offers Preview, which reveals the canvas from the board and opens the same dialog. A successful receipt with truncated display text can still link by its leading proposal ID to client data; malformed identities and unrelated or failed tool calls do not create cards.

Unit coverage includes receipt association and truncation, localized mode/status/bar labels, irreversible detachment on control edits, complete resolve fields, inline conflicts and the stale-result notice. Fake-Codex browser coverage includes preview without writes, apply and one-step undo, author dragging after proposal, dismiss and reload, edited columns and the empty-frame choice, superseding, transcript preview from the board, cycling multiple sessions, reopening the project and partly or entirely deleted selections. All screenshots use a 1600×1000 viewport at device scale factor 2 and live outside the repository.

Known limits: the card's count is the server's original affected-node count, including frames, rather than the count of currently surviving selected nodes. Terminal suggestions outside the backend's newest-200 history window show their receipt content with status unavailable and no Preview action; the UI does not guess their state. Cards require the matching propose call in loaded transcript history to distinguish them from unrelated JSON tool results; loading older history restores a card when its call falls outside the current page. Undo keeps a suggestion applied while reversing its canvas operation, as in d1. All functional acceptance items are implemented; final validation evidence, including any unrelated pre-existing timeline failures, is recorded in the dispatch report.

Validation exception: `pnpm check` passes and all seven proposal browser tests pass. The acceptance item requiring a completely green full e2e suite twice remains blocked by the pre-existing `timeline-keyframes.e2e.ts` moved-overlay-axis rounding failure and the `timeline-transforms.e2e.ts` phone-rotation export timeout. Those timeline paths are outside step d2 and were not changed.

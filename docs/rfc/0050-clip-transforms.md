# RFC 0050: Clip transforms — keyframed crop, scale and position

Status: implemented (2026-11-15; accepted by the maintainer on the same date). Builds on [RFC 0024](0024-timeline-editing.md) (timeline editing, 0024e overlays) and reuses the keyframe shape of [RFC 0037](0037-interactive-scene-nodes.md). Revises 0024e's "fixed position, size and opacity, no keyframes" for overlay clips.

## Problem

The timeline can cut, trim, fade, change speed and place static overlays, but it cannot move the picture inside a clip:

- Main-track clips are always fitted to the output with black bars (`scale` + `pad` in `packages/assets/src/timeline-render.ts`). An author cannot reframe a 16:9 shot for a 9:16 output, crop out an edge, or push in slowly on a still.
- Overlay clips have one position, width and opacity for their whole length (`OverlayPlacement`). A picture-in-picture cannot grow, slide in or fade to a different opacity over time.

Authors want two things: **keyframed scaling** (push in, pull out, Ken Burns on stills, an overlay that grows) and **dynamic cropping** (a crop window that moves over the source, e.g. following a subject when reframing to vertical).

## Goals

- One transform model on main-track clips and overlay clips, for video and image sources.
- Every transform value can be static or keyframed over the clip, with the same easing vocabulary as scene nodes.
- Export (ffmpeg) and the editor preview show the same picture at the same time, without visible stepping on slow moves.
- Authors can do everything in the editor without an Agent (minimal keyframe editor). Agents write the same fields through `timeline.set`.

## Non-goals

- Rotation, skew, flips, blur, colour, masks.
- Automatic reframing or subject tracking, motion presets ("auto Ken Burns"), default moves applied to new clips. Those are taste: an Agent may propose keyframes, an author-written skill may define presets, the product ships neither (product principle).
- Bézier curve editing, curve view, copying keyframes between clips, multi-key selection (a later step if authors ask).
- Animating text clips, transitions or audio.

## Contract (`packages/protocol/src/timeline.ts`)

### Keyframes

```ts
// Same shape and easing as scene keys (RFC 0037): an ease shapes the segment from this key to the next.
const TransformEase = z.enum(['linear', 'easeInOut', 'hold'])
const Key = <T>(value: T) => z.strictObject({ t: Ms, value, ease: TransformEase })
const Animated = <T>(value: T) => z.union([value, z.strictObject({ keys: z.array(Key(value)).min(2).max(TIMELINE_LIMITS.transformKeys) })])
```

- `t` is a **source time** in milliseconds: the position in the source media (for images, 0 to `outMs`). Keys therefore stay on the same frame of content when the clip is moved, trimmed or sped up, which is what a reframe that follows a subject needs. Speed changes stretch the move with the content.
- Keys must be strictly increasing. Keys outside the current `inMs..outMs` are kept (a trim can be undone) and still shape the curve; before the first key and after the last key the value holds.
- A single static value is written as the plain value, not as one key. Removing the second-to-last key turns the property back into a static value.
- `TIMELINE_LIMITS.transformKeys = 32` per property.

### Crop (main and overlay clips)

```ts
// Fractions of the source frame after rotation; three decimals.
const CropRect = z.strictObject({ x: Decimals(0, 1, 3), y: Decimals(0, 1, 3), width: Decimals(0.05, 1, 3), height: Decimals(0.05, 1, 3) })
// clip.crop?: Animated<CropRect>; the rect must lie inside the frame (x + width ≤ 1, y + height ≤ 1).
```

- On the **main track**, the cropped region is fitted to the output exactly as the whole frame is today (keep aspect, bars if the aspects differ). Cropping to the output's aspect therefore fills the frame without bars, and a crop window that shrinks over time **is** the push-in: keyframed scaling on the main track is a keyframed crop. No separate scale property, so there is one way to express a move.
- Every key of one clip's crop must have the same aspect ratio (in source pixels, tolerance 0.5 %). Otherwise the fitted size and the bars would wobble during the move. Validation message: `crop keys must keep one aspect ratio`.
- On **overlay** clips, the overlay shows only the cropped region; its height follows the crop's aspect (the 0024e rule "height follows the source aspect" becomes "follows the cropped aspect").

### Overlay placement becomes animatable

```ts
export const OverlayPlacement = z.strictObject({
  x: Animated(Decimals(0, 1, 3)),
  y: Animated(Decimals(0, 1, 3)),
  width: Animated(Decimals(TIMELINE_LIMITS.overlayMinWidth, 1, 3)),
  opacity: Animated(Decimals(0, 1, 2)),
})
```

Each property animates independently, so an overlay can slide without resizing. Existing documents are valid unchanged (a number is a static value). No storage migration: timeline documents are JSON validated on read and write.

### Shared evaluation

`packages/protocol` exports one pure `evaluateAnimated(value, sourceMs)` and `clipTransformAt(clip, sourceMs, output, sourceSize)` returning the crop rect in source pixels and (for overlays) the output rect and opacity. Preview, export and tests all use these, so the three cannot disagree about interpolation. `easeInOut` is smoothstep, as in scenes.

The transform result is `{ crop, rect, opacity }`: `crop` uses rotated source pixels; `rect` is the fitted main picture or the overlay in output pixels; `opacity` is the sampled placement opacity (picture fades remain in `overlayOpacityAt`). Overlay dimensions use the existing even-pixel rounding. Source time is supplied explicitly; callers map a timeline position through `sourceTimeAt` first.

## Export (`packages/assets/src/timeline-render.ts`)

Keyframes become per-frame ffmpeg expressions in output time `t`, built from the same segments as `evaluateAnimated` (piecewise `if(lt(t,…))` chains; at most 31 segments per property).

The filter chain is decided by a spike first (**S1**), because the obvious chains have known problems: `crop` evaluates `w`/`h` only once, `zoompan` works on whole pixels and jitters on slow moves, and `scale=eval=frame` changes the frame size mid-stream. Candidates:

1. Upscale once by a fixed factor (e.g. 4×), then `crop` with per-frame `x`/`y` and a size chosen per segment, then `scale` to the output — needs constant-size crops, so a zoom becomes a scale step.
2. `scale=eval=frame` to the animated size followed by a fixed-size `crop`/`overlay` onto a constant canvas, which keeps the downstream size constant.
3. A `perspective`/`affine`-style resampling filter if the bundled LGPL build has one that takes per-frame expressions.

S1 acceptance, measured on a 10 s 1080p source with a 1.00 → 1.10 push-in and a slow horizontal pan:

- No visible stepping (frame-to-frame motion of a fixed feature varies by less than 0.5 px).
- The exported frame at 0 %, 50 % and 100 % matches `clipTransformAt` within 1 px.
- Export time per animated clip at most 6× the same clip without transforms, with a lower time targeted through slice threading; works with the bundled macOS and Windows LGPL ffmpeg builds. Clips without keys retain the existing path; static crops use plain `crop` + `scale`, never `geq` (maintainer-approved revision, 2026-11-15; measurements below).
- Overlay animation uses `overlay` with per-frame `x`/`y`, animated width through the chosen scaling approach, and opacity through a per-frame alpha expression (`geq`-free if possible; S1 picks).

The S1 result and the chosen chain are recorded in this RFC before step a merges.

### S1 decision (maintainer-approved, 2026-11-15)

The original 1.5× time budget could not be met together with the motion criterion. The maintainer approved fractional `geq` bilinear sampling for animated main-track crops and the working overlay chain below, and revised the time budget to **6× per animated clip**. The motion variation below 0.5 px and endpoint error within 1 px remain required. An untransformed document must compile to a byte-identical filter graph; a static crop adds a plain crop before scaling and does not use the animated sampler.

S1 used the bundled LGPL FFmpeg 9.0.2 on macOS arm64 (Apple M5 Pro, 48 GiB), a locally generated 10 s 1080p30 `testsrc2` source, a 1.00 → 1.10 push-in and a slow horizontal pan. No network, generation providers or real agents were used. Times are medians of three exports, including the existing timeline padding/concat, silent AAC bed and VideoToolbox 8 Mbps encoding; baseline was an encode rather than stream copy.

The measurement decodes all 300 frames and follows the luma-weighted centroid of a white feature on black, without smoothing. Motion variation is the maximum Euclidean difference between consecutive-frame displacement vectors. Endpoint calibration at 0, 5 and 10 s follows three features across the frame, using pixel-centre coordinates; the held endpoint frame is excluded from timing.

| Chain | Time | Relative baseline | Motion variation | Maximum endpoint error |
|---|---:|---:|---:|---:|
| Existing fit/pad | 1.309 s | 1.00× | 0.024 px | Reference |
| Per-frame scale → fixed crop → downscale, 1× | 1.430 s | 1.09× | 2.131 px | 0.870 px |
| Same, 2× | 1.501 s | 1.15× | 1.265 px | 0.177 px |
| Same, 4× | 2.660 s | 2.03× | 0.769 px | 0.091 px |
| Same, 6× | 4.344 s | 3.32× | 0.470 px | 0.097 px |
| Same, 8× | 6.405 s | 4.89× | 0.505 px | 0.150 px |
| Fractional `geq` bilinear sampling | 7.918 s | 6.05× | 0.375 px | 0.062 px |

The initial `geq` result slightly exceeds even the revised budget; threading and the implementation measurements must therefore be checked before calling the export gate passed. Its errors at 0 / 50 / 100% were 0.032 / 0.037 / 0.062 px; the maximum error over all timed frames was 0.184 px.

Other candidates: animated `crop` width/height fails initialization because those expressions do not have a frame time. Ordinary `zoompan` at 1× / 2× / 4× supersampling had maximum per-axis motion variations of 2.868 / 1.520 / 1.040 px. Its integer windows, chroma alignment and zoom ceiling of 10 do not cover this contract. `perspective` is unavailable: the bundled FFmpeg source declares it GPL-only, and both platform builds disable GPL. Supersampled scaling also creates excessively large intermediate frames for the legal minimum crop of 0.05.

Overlay order: fixed-size `yuva444p` → `geq` preserving source alpha and multiplying by per-frame opacity → `scale=eval=frame` → `overlay` with per-frame x/y and 4:4:4 composition → output format. At 0 / 50 / 100%, the measured bounds matched the analytic rectangles exactly; a source alpha of 128/255 survived, with at most 1.6/255 decoded intensity error. Interleaved three-run medians were 1.210 s static, 1.235 s animated linear (1.021×), and 1.232 s with 31 smoothstep segments (1.018×).

The 32-key / 31-segment cap was exercised independently on x, y, width and opacity. Expressions reached 7,671 characters per property and the graph reached 38,539 characters; graphs stay in `-/filter_complex` files rather than Windows command-line arguments. This validates the chosen contract cap, not an inferred hard parser limit.

Two ordering pitfalls are part of the decision: `crop` caches expression `iw`/`ih` at initialization even after an upstream animated scale (over 13 px drift in the exploratory graph), so coordinates must use explicit animated dimensions. `geq` also keeps its configured output dimensions, so putting it after animated scaling freezes the initial overlay size; alpha processing must precede scaling. See [generation lessons](../lessons/generation.md).

All filters in the chosen chains are shared requirements in `scripts/ffmpeg/requirements.json`; Windows inherits them unchanged through `requirements-windows.json`. The recipes use the same source and LGPL configuration. This establishes filter availability, not Windows pixel or performance acceptance, which was not run on the Mac.

### Step a implementation measurements (2026-11-15)

The bounded threading check found no benefit from restricting the complex graph: one/two threads exceeded the 30/25 s observation budgets, four took 21.75 s, and eight took 13.68 s. Setting `filter_threads=4` did not improve the complex graph (11.73 s). Keep the default slice parallelism. Rendering separate clip segments in separate processes would add temporary outputs, decoding/encoding work, transition joins and cancellation ownership; the existing single graph is simpler and already permits independent clip filters and slice execution.

The implementation retains the approved bilinear `geq` chain and caches each time-only curve in that slice's expression registers once per frame. Register state belongs to each plane and slice; `N+1` forces initialization on the first frame and refreshes it on every output frame. This keeps a 31-segment curve out of the per-pixel work. Sampling occurs after retiming, output-fps conversion and source-end padding, so slow moves continue on held source frames. Main-track sampling includes fitted black bars on a fixed canvas; overlays sample alpha before animated scaling. Curves use the frame index divided by fps, including the overlay first-frame offset, rather than microsecond-rounded timestamps. A nanosecond tolerance only in segment comparisons prevents a floating-point ULP from delaying a hold key; interpolation stays on the exact frame clock. Real-frame regressions cover hold boundaries at 3× and 0.3×, including an output frame held past a short source trim.

Before animated main-track sampling, the source is normalized to eight-bit limited range, retaining alpha when present. This keeps the sampler's black/neutral/opaque constants valid for high-depth RGB/YUV inputs; a 16-bit RGB regression checks neutral black fitted bars. The preliminary range conversion keeps the source dimensions fixed and does not change the chosen fractional resampling mechanism.

Three interleaved runs of the final compiled graph on the same 10 s 1080p30 fixture gave medians of **1.304 s baseline**, **1.261 s static crop (0.97×)**, **4.825 s animated crop (3.70×)** and **5.184 s with 32 smoothstep crop keys (3.97×)**. Both animated cases pass the revised 6× budget, and static crop uses no `geq`. These are local measurements, not timing assertions in the default test suite.

Following the feature across all 300 frames of the compiled two-key export gave **0.402 px motion variation** and **0.194 px maximum position error**, satisfying the unchanged quality criteria. Real-FFmpeg regressions also compare two feature positions with `clipTransformAt` within 1 px for linear, smoothstep and hold curves, including source trims, 2× speed and letterboxing, and check animated overlay geometry, opacity and transparent borders.

The minimal compatibility bridge for existing overlay controls is also maintainer-approved (2026-11-15): animated fields show evaluated playhead values read-only, and legacy inspector/preset/drag/resize paths preserve key arrays. The full preview and key editor remain steps b/c.

### Step a review corrections (2026-11-15)

The overlay box now samples x/y/width and the cropped source aspect at the current source time in the existing player paint/rAF path. Presets, snapping and resizing use the same cropped aspect and playhead width, including trims and speed. Position-only presets remain available with keyed width; any preset or gesture that would replace keys stays blocked. The Inspector subscribes to clock events only while the selected overlay has keyed fields, so static selections do not cause clock-driven Inspector renders. These corrections align the bridge's box geometry; media crop preview and the key editor remain steps b/c.

`isAnimated` and the immutable `FULL_CROP` default are exported from protocol for shared use. Static crop compilation rounds the left/top/right/bottom edges and clamps them inside the source, rather than rounding origin and size independently: a half-frame crop at 0.5 on a 1001-pixel source starts at 501 and is 500 pixels wide. Animated overlay compilation computes no unused static rectangle, builds each crop curve once, and omits repeated crop curves from scaling when the crop aspect is constant; separate FFmpeg plane/filter expression contexts still require their own expressions.

Agent-evaluation overlay checks sample values through `evaluateAnimated` over the trimmed source range, including key boundaries. Visibility requires some positive opacity; position/size/half-opacity constraints hold across the range. `@vis/web`'s normal typecheck now also runs `tsc --noEmit -p agent-eval`, so `pnpm check` covers the previously omitted checker project without running real agents.

## Preview (`packages/timeline/ui`)

- The two alternating `<video>` elements (0024 §6) sit in a clipping container; per frame the player sets a CSS `transform` (translate + scale) and container size from `clipTransformAt`. Images use the same path.
- Updates run in the player's `requestAnimationFrame` loop from the `AudioContext` clock and write styles directly; no React render per frame (0024 UI spec §9).
- Scrubbing and paused seeks apply the transform for the frame under the playhead.
- `prefers-reduced-motion` does not change the preview: the moves are the author's content, not interface motion. Interface animations around keyframes (diamond highlight) respect it.

### Step b implementation (2026-11-15)

Main-track video and image elements each have a clipping container. The existing player frame subscription samples `clipTransformAt` through `sourceTimeAt`, writes the fitted container rectangle as output-relative percentages, and translates/scales the full source inside it. This preserves crop aspect and black bars without measuring layout per frame, including fullscreen. Prepared spare elements receive the incoming transform while hidden and are painted again before promotion, so handoffs cannot expose an untransformed picture. The extra spare used for adjacent transitions follows the same path.

Overlays use the same rectangle and media transform mapping. A source-relative CSS inset clips only their picture, leaving selection borders and resize handles outside the cropped box. Placement, crop and opacity update in the existing media frame loop; legacy gestures still preserve keyed properties. Read-only keyed Inspector fields own small frame subscriptions that write only their input values. The Inspector and OverlayLayer have no per-frame React state update. Paused clock events and media readiness events paint immediately; reduced-motion preferences leave authored content transforms intact.

Pure mapping and player tests cover main/overlay geometry, differing crop/output aspects, independent placement curves, hold and smoothstep boundaries, keys outside trims, source-time speed mapping, paused seeks and transformed spare promotion. The browser regression exports a real FFmpeg timeline with a trimmed keyed main video crop and a keyed image overlay (crop, x, y, width and opacity), with no providers or agent processes. It compares preview-area screenshots against exported frames at the first/middle/last displayed frames (0 / 1 / 2 s of a 21-frame, 10 fps timeline). Three coloured features must stay within **3 CSS pixels** to allow for chroma subsampling, differing bilinear filters and screenshot pixel rounding; the initial run's maximum error was **1.47 CSS pixels**. A second browser check confirms keyed Inspector values change during playback and seeking without rewriting the document.

The RFC 0024 timeline report was run before and after with `pnpm --filter @vis/web perf timeline.perf.ts` on the same Apple M5 Pro, Chrome CPU throttle 1× and PATH FFmpeg. Reports are under `/tmp/vis-perf/step-b-before` and `/tmp/vis-perf/step-b-after`. Playback frame rates did not decrease, meeting the 10% regression limit:

| Metric | Before | After |
|---|---:|---:|
| Play to first frame, median | 35 ms | 34 ms |
| Clip switches, three boundaries | 0 black / 936 frames | 0 black / 936 frames |
| Zoom, 200 clips | 60.0 fps | 60.0 fps |
| Scroll, 200 clips | 60.0 fps | 60.0 fps |
| Drag, 200 clips | 60.3 fps | 60.3 fps |
| Open editor, 50 clips, median | 113 ms | 128 ms |
| Renderer RSS after playback | 882 MB | 846 MB |

These are local measurements of the existing 0024 workload, without new timing assertions. Both runs exceed that report's existing 500 MB renderer-RSS target; step b reduces the observed RSS but does not resolve that separate budget.

### Step b review corrections (2026-11-15)

Preview now owns the resolved output frame and passes it to the main player and overlays. It retains the first source's decoded dimensions even after alternating elements are reused, and decoded dimensions take precedence over stored dimensions because they include rotation. Media dimensions are always a complete pair from one source; unavailable dimensions keep the picture hidden until a readiness event, including a hidden spare, repaints it. Overlay slot geometry and its controls remain available before a media element or its size exists.

Paints cache clip/placement identity, crop, millisecond source time, fade time, complete source size and output frame. Static clips do no time-driven style work; animation samples round down to preserve exact hold boundaries. Changed attributes/styles are written only when their values differ, and the player performs no first-clip lookup on its frame path. Overlay opacity comes from the same sampled transform, multiplied by picture fades without evaluating the placement curve twice. Small Inspector fields subscribe directly to transient gesture placements as well as keyed playback values; dragging still preserves keys and commits only on release.

Regressions cover rotated phone metadata, partial/unknown dimensions, readiness of hidden spares, layout before media insertion, unchanged paint inputs and hold boundaries. The browser test removes stored dimensions from the first image, seeks beyond the third clip, checks that main and overlay aspect ratios still agree with one implicit output, and verifies live Inspector drag values before any document write while retaining keyed width.

The initial single-run editor-open comparison (113 → 128 ms) was repeated with three runs of the pre-step-b UI (`f8b6c217`) and three runs of the corrected UI, on the same machine, Chrome throttle 1× and PATH FFmpeg. The six timeline reports ran sequentially without overlapping full test suites. Each run opens the warm 50-clip editor five times; the medians of those five samples were **97.014 / 98.195 / 98.216 ms before** and **98.709 / 97.939 / 98.067 ms after**. The median of run medians is **98.195 → 98.067 ms (−0.13%)**, so the earlier 13% increase does not persist in the repeated comparison. The harness includes Playwright round trips, and individual samples vary by roughly a display-frame interval; a single median pair is insufficient evidence of additional mount work.

| Three-run median | Before | After |
|---|---:|---:|
| Open editor, 50 clips | 98.2 ms | 98.1 ms |
| Play to first frame | 16 ms | 16 ms |
| Zoom, 200 clips | 60.0 fps | 60.0 fps |
| Scroll, 200 clips | 60.0 fps | 60.0 fps |
| Drag, 200 clips | 60.4 fps | 60.4 fps |
| Clip switches | 0 black / 936 frames in every run | 0 black / 936 frames in every run |

Reports are in `/tmp/vis-perf/step-b-review-before-{1,2,3}` and `/tmp/vis-perf/step-b-review-after-{1,2,3}`, with the collected values in `/tmp/vis-perf/step-b-review-medians.json`. Both open and playback measurements pass the 10% regression limit; the pre-existing renderer-RSS budget remains a separate issue.

### Second step b review corrections (2026-11-15)

Decoded dimensions now live beside stored metadata in the shared editor resource cache, keyed by immutable asset version. Preview, Inspector, output settings, the header and overlay preset/aspect calculations all read resolved metadata from that cache. Readiness events publish decoded pairs only when they change the resolved size; no clock-driven React update is added. Export was checked read-only: `probeTimelineSource` applies display rotation, rendering replaces stored visual metadata with that probe, and both the implicit output and overlay aspect use its post-rotation dimensions. A real rotated-MP4 regression confirms preview/export dimensions and Inspector presets with simulated pre-rotation stored metadata, including frame-rate changes and a square output with a portrait overlay. Export needs no change.

Reused images stay hidden until `complete` is true and `currentSrc` equals the assigned `src`; stale natural dimensions never authorize a paint or enter the shared cache. Empty or invalid overlay numeric edits report the existing validation message, and fields explicitly restore document values after invalid, clamped and no-op commits. Regression coverage includes pending image preload/promotion and rejected numeric edits.

`overlayOpacityAt` remains the single fade-window definition. Its pure helper accepts an optional already sampled opacity; Preview reuses the `clipTransformAt` sample, and the paint cache passes 1 to obtain the same fade factor without evaluating the curve again. No RPC or document schema changes. Paint identity relies on immutable clip objects without redundant crop/fade fields. Main pictures use their clipping containers without a media clip-path; hidden overlay slots prepare layout but skip node labels and handle work. The output frame has a localized accessible group label used by browser locators.

The requested follow-up timeline report passed on the same machine and configuration, saved in `/tmp/vis-perf/step-b-review2-after`. Compared with the preceding corrected three-run medians, warm editor opening was **98.1 → 97.4 ms**, first frame **16 → 11 ms**, zoom/scroll/drag **60.0 / 60.0 / 60.4 fps unchanged**, and clip switches again had **0 black frames out of 936**. No playback or editor-open regression exceeds 10%.

## Editor UI (minimal)

All copy goes into `messages.ts` in both languages; selectors for e2e use `aria-label` or visible text.

**Inspector, "Transform" section** (selected video, image or overlay clip):

- Crop: x / y / width / height fields (percent), an aspect lock (Free, Output, Source, 16:9, 9:16, 1:1, 4:3; uncropped main-track clips default to Output), and **Edit crop**.
- Overlay clips additionally show position x / y, width and opacity (existing fields).
- Each property has a keyframe diamond button: hollow = static, filled = a key at the playhead, half = animated but no key here. Clicking it adds or removes a key at the playhead (in source time). Next to it, previous / next key buttons.
- When a property is animated, editing its value updates the key at the playhead, or adds one if there is none. When static, editing changes the static value.
- Selecting a key shows its ease (Linear, Ease in-out, Hold).
- **Reset transform** clears crop and (for overlays) returns placement to static values at the playhead.

**Preview, crop editing**: with Edit crop on, the preview shows the whole source frame dimmed outside the crop box, with corner and edge handles and drag-to-move; the aspect lock applies; Esc or Done leaves the mode. Overlay clips keep the existing on-preview drag and resize handles (`overlay/OverlayLayer.tsx`); with animated properties, a drag writes keys at the playhead.

**Timeline**: the selected clip shows its keys as small diamonds along its bottom edge (all properties merged into one row; a tooltip lists which). Clicking one moves the playhead there; dragging moves the key in time (snaps to frames, stays inside the source range); Delete removes the selected key. Unselected clips show a small motion glyph when they have any keys.

Each commit is one `timeline.set` with `expectedRevision` and one undo step, as today.

### Step c implementation (2026-11-15)

The Transform section edits crop and each overlay placement property at the source time obtained through `sourceTimeAt`. Static edits remain plain values. On a static property, the first diamond creates two keys with the current document value and Linear ease: one at the clamped, rounded source time under the playhead, and one at the clip's source In point. If the playhead is at In, the second key is at source Out instead. Enabling keys does not refit crop or create motion; the Inspector explains the two matching keys. Later edits update or insert one key, retaining every other key, including keys outside the trim. Removing a two-key property's key samples its pre-removal curve at the playhead and writes a static value at contract precision. The 32-key limit disables insertion with a localized reason; existing keys can still be edited, eased and removed.

Aspect-lock defaults are derived from the current crop until an accepted explicit lock choice or the author's own accepted crop geometry edit with known media dimensions. Without crop, main-track clips show Output and overlays show Free. With crop, match its source-pixel aspect to Output, Source, 16:9, 9:16, 1:1 or 4:3 in that order, within the contract's 0.5% tolerance; otherwise show Free. Only crop-mode gestures/nudges and Crop X/Y/width/height field edits with known media dimensions store the active lock; an explicit choice is stored only after its refit is accepted. Key add/remove and ease-only changes never store a lock. Edits made while dimensions are unknown never store a lock, including a gesture that starts before dimensions resolve and ends afterward. An accepted Reset transform clears the stored lock. Stored locks are keyed by clip id and removed when that id leaves the document; deletion and undo then derive the lock from the restored crop rather than resurrecting a stored lock. Selection and render never register a lock. Inspector and crop mode use the same resolved source dimensions; while those dimensions are unknown they apply no preset-derived constraint. Explicitly changing a lock refits every crop key around its centre and clamps it inside the source. Once crop is animated, free resizing retains its common aspect. Quantized dimensions are fitted together to preserve the 0.5% aspect rule even at the minimum crop size. Locks that cannot fit the minimum crop dimensions are unavailable. No lock is added to the document contract.

Crop mode opens on the document crop, including the full 100% × 100% frame when crop is absent, and shows a separate full source frame, with the outside dimmed and eight resize handles plus a move surface. Pointer drafts paint locally and commit on release; cancellation restores the document sample. Arrow keys nudge the focused handle or crop, Shift increases the step, and Done or Escape exits. Overlay moves, resizes, keyboard nudges and placement presets update only the affected properties through their playhead keys. The existing transient placement store continues to paint small Inspector fields during a drag. Blurred numeric fields and diamond/ease controls own small clock subscriptions; the Inspector itself never subscribes to playback frames.

Selected clips show one merged key row below their label, with property names and timeline time in its accessible tooltip. Times between output frames also include milliseconds so distinct keys remain distinguishable. Endpoint diamonds stay inside the clip; keys outside its source trim are not drawn. Click seeks, drag snaps on the timeline frame clock and maps through clip speed back to source milliseconds, and Delete removes the merged key without deleting its clip. Movement stays within the displayed source range and cannot pass a neighbour of any affected property; if no frame fits between neighbours it stays put. Trimmed-out keys remain in the document. Unselected animated clips show a motion glyph. Key and crop gestures keep drafts outside React document state and use one `timeline.set` with `expectedRevision` and one undo step on release.

Pure tests cover static/key transitions, insertion and update, hidden keys, adjacency, ease, source-time mapping at non-unit speed, the key cap, merged movement and removal, frame snapping and neighbour bounds, crop aspect refits and all crop handles. Browser acceptance uses local fixtures, real FFmpeg and no providers or model processes; it exercises key insertion, field edits, timeline drag and Delete, ease, aspect changes, crop handles and keyboard, overlay drags, reset, and undo/redo. It checks persisted keys and preview/export feature alignment at four displayed times with the existing 3 CSS-pixel allowance. Screenshots use a 1600×1000 viewport at device scale factor 2 and live under `/tmp/vis-step-c`.


The timeline report at `/tmp/vis-perf/step-c-editor-isolated` compared with `/tmp/vis-perf/step-b-review2-after` measured warm editor opening at **97.4 → 97.6 ms (+0.12%)**, zoom/scroll/drag at **60.0 / 60.0 / 60.4 fps unchanged**, and **0 black frames out of 936**. First-frame latency was **11.1 → 14.1 ms** in that historical comparison. A contemporaneous control of the unchanged step-b base (`25d4abdd`, built separately under `/tmp`) measured **97.6 ms opening and 14.8 ms first frame**; step c therefore has no startup regression against the current control, and both remain well within the 300 ms absolute startup target. The control report is `/tmp/vis-perf/step-c-control-base`; all raw measurements are retained, including an initial run overlapping fixture setup (113 ms opening / 35 ms first frame). The controlled playback and editor-open comparison passes the 10% regression limit.


### Step c review corrections (2026-11-15)

Overlay gestures compare sampled values at contract precision and write keys only for changed properties. Movement permission is per axis, so a horizontal gesture can edit x while an unchanged y is at the 32-key limit. Permission checks and commits use the same clamped, rounded `playheadSourceTime`. Crop handles repaint their disabled state and limit reason from a small clock subscription and recheck permission at commit; they do not require a per-frame React render.

Crop X/Y edits and box movement preserve dimensions and aspect, and entering crop mode or enabling keys never refits the document. Only an explicit aspect-lock selection refits existing crops. A full-frame crop cannot move, so an arrow nudge at full size is a no-op. A varied source fixture with a blue feature outside the crop verifies that dimmed pixels retain source colour; the previous shadow was already translucent, but its uniform grey fixture did not demonstrate that visually.

Timeline keys use the shared `timelineTimeAt` inverse and a shared property-label helper. Diamonds stay within the exact clip bounds below the label, and the unselected motion glyph sits above it. Refused edits report the same localized reason as the Inspector; failed drags restore the diamond and leave selection and playhead unchanged. Key controls cache their small external-store snapshot by field comparison, without JSON serialization or redundant React state, and the unused single-property move wrapper is removed. Unit and browser regressions cover each corrected behavior, including draft refusal, invalid-document and conflict recovery. Updated 1600×1000 DPR-2 screenshots are under `/tmp/vis-step-c-review`.

The final review report at `/tmp/vis-perf/step-c-review-final` measured warm opening at **97.44 → 97.47 ms (+0.04%)** against `/tmp/vis-perf/step-b-review2-after`, zoom/scroll/drag at **60.0 / 60.0 / 60.4 fps unchanged**, and **0 black frames out of 936**. First-frame latency was **11.10 → 33.70 ms** against that historical baseline. A fresh run of the unchanged step-b control (`25d4abdd`) at `/tmp/vis-perf/step-c-review-control-final` measured **97.35 ms opening and 37.50 ms first frame**, compared with **97.47 ms and 33.70 ms** for the reviewed step c; the controlled comparison stays within the 10% limit. Renderer RSS was **908 MB control / 889 MB reviewed**, both above the original report target; the raw reports retain this environmental shift and the historical startup delta. All seven timeline benchmark cases passed, with only the conditional LGPL-build case skipped.


### Step c second review corrections (2026-11-15)

The Inspector and crop mode derive defaults from the current crop's aspect; only explicit lock choices are stored. An external crop therefore updates its derived lock, while a crop made under Output continues to read Output because its aspect matches the output. An unmatched aspect reads Free, and an uncropped main-track clip reads Output. Explicit choices are dropped when the clip leaves the document.

Overlay keyboard and pointer commits report key-limit refusals (including a corner resize capped during its gesture), use the shared transform-commit path and show localized validation, caption-linkage and conflict refusals. A requested capped keyboard axis shows the same key-limit reason as its Inspector field even when the other axis is editable. After pointer gesture start, the dominant axis tracks the total pointer delta; minor-axis drift of at most **3 CSS preview pixels** is ignored only when the dominant axis is at least **2×** as large, and near diagonals move both axes. Keyboard nudges are unaffected. Placement presets check only properties whose rounded values would change, repaint their availability through a small clock subscription, and recheck at commit. Placement normalization has one owner.

Crop commit refusals persist until the next crop-mode user action or a change to their conflict/disabled state. Clock paints update changes to disabled state and limit text; playback clears a commit message when the current playhead becomes editable. Crop handle refs are collected once, and limit-title formatting is shared with Inspector fields. Timeline key notices carry an owner so a successful key edit cannot clear another timeline notice. The selected clip label reserves a key row only when the shared in-trim filter yields visible diamonds. Unit and browser regressions cover these rules, including real component handlers with controlled refusals; updated 1600×1000 DPR-2 screenshots are under `/tmp/vis-step-c-review2`.

The second review report at `/tmp/vis-perf/step-c-review2-after` measured warm opening at **97.44 → 97.21 ms (-0.24%)** against the stored step-b report; a fresh unchanged step-b control (`25d4abdd`, `/tmp/vis-perf/step-c-review2-control`) measured **97.00 ms**. Zoom/scroll/drag remained **60.0 / 60.0 / 60.4 fps**, and both current builds had **0 black frames out of 936**, no interaction frames over 25 ms, and no interaction long tasks. The relative 10% gate applies to playback FPS, black frames and warm editor opening; those comparisons pass.

Play-to-first-frame uses the RFC 0024 absolute **300 ms** target. The reviewed median was **37.8 ms**, with raw samples **[50.8, 42.5, 14.7, 13.0, 37.8] ms**; the unchanged control median was **15.0 ms**, with **[14.2, 15.0, 13.6, 37.3, 34.5] ms**. First-frame latency is bimodal on this machine, around 14 ms and 38 ms in both builds; previous unchanged-base medians range from 11.1 ms to 37.5 ms, so a five-sample relative comparison is not meaningful. Both current builds pass the absolute target. Each benchmark command passed all seven cases, with the conditional LGPL-build case skipped; raw reports retain every sample and the renderer RSS measurements (813 MB reviewed / 833 MB control, both above the historical 500 MB target).


### Step c third review corrections (2026-11-15)

Small overlay drags retain the dominant-axis displacement after the gesture has started, including a two-pixel fine adjustment after a larger movement. Near diagonals move both axes; the three-pixel minor-axis dead zone applies only when the dominant axis is at least twice as large, measured in preview CSS pixels. Existing snapping and contract precision still apply. Placement edits normalize changed fields while preserving untouched values and curves; rounded no-ops return the original placement.

Crop refusals clear when their recorded conflict/disabled state changes, when playback reaches an editable position, on clock navigation, or on the next crop action. Overlay notices belong to a clip, selection and document content; ordinary refusals expire after selection or content changes, restoring any limited-preview status, while save acknowledgements preserve them. Missing-clip feedback instead expires on selection changes, editing input (including undo/redo), or restoration of its named clip. Aspect defaults are pure functions of the current crop; only explicit choices are stored, and those entries are removed when clips disappear. Handle ref callbacks and the general timeline notice callback are stable; key notices rely solely on the timeline's owner check. Unit and browser regressions cover small drags, stale-message recovery and each overlay notice expiry condition. Updated 1600×1000 DPR-2 screenshots are under `/tmp/vis-step-c-review3`.

The third-review benchmark at `/tmp/vis-perf/step-c-review3-after` measured warm opening at **97.44 → 97.27 ms (-0.18%)**, unchanged **60.0 / 60.0 / 60.4 fps** zoom/scroll/drag, and **0 black frames out of 936**. There were no interaction frames over 25 ms or interaction long tasks. First-frame latency was **34.4 ms median / 47.7 ms maximum**, with raw samples **[47.7, 36.8, 17.8, 33.6, 34.4] ms**, within the clarified 300 ms absolute target. All seven benchmark cases passed, with the conditional LGPL-build case skipped; raw reports retain renderer RSS of 866 MB, above the historical 500 MB target.


### Step c fourth review corrections (2026-11-15)

Overlay refusal visibility uses explicit numeric document-content and selection counters advanced during render rather than the save revision, memo identity or layout-effect state updates. Notices retain only their numeric context, never a timeline document. The draft preserves its document object on an own-save acknowledgement, so an earlier successful nudge finishing its save cannot erase a later refusal. Undo, redo and external content transitions invalidate the old context. A missing-clip refusal is allowed after the clip disappears and remains until the next pointerdown, editing key (including Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z or Ctrl+Y), selection change, or restoration of its named clip. Restored feedback cannot reappear when that clip is removed again. Focus navigation, modifier-only and assistive keys preserve that special notice; the pointer release that creates it leaves it visible. The refusal callback is stable, and no effect clears notices merely because their derived context expired.

Near-diagonal pointer movement tracks both axes. Minor-axis motion is suppressed only within three CSS preview pixels and with a dominant displacement at least twice as large; the documented 2.5/3.0 and 2.2/2.3 moves retain both axes, while 6/1 retains only the dominant one. Crop refusals record the source time used by the commit, and paint checks their blocking state at that time. Clock navigation and the next crop action clear them; advancing playback compares the recorded blocking state at the gesture time and clears the message when the current playhead becomes editable. Crop status paint has one conditional text write.

Lock defaults are pure functions of the current crop, with no first-read registration or storage on crop commits. Only explicit choices are stored and are pruned when their clip disappears. Placement edits preserve untouched fields, return the original placement on empty or rounded no-op edits, and return an explicit keyLimit refusal for a capped edit; pointer and keyboard commits share that result. No-op and refused edits create no undo/save work. Unit and browser regressions cover the in-flight autosave race using the real draft controller, missing clips during drag, near diagonals, gesture-time crop refusals, derived locks and no-op history. Updated 1600×1000 DPR-2 screenshots are under `/tmp/vis-step-c-review4`.


### Step c/d final follow-up (2026-11-15)

The author-action lock rule above supersedes the earlier review notes that stored only explicit choices. Accepted crop edits retain the lock in effect, so Free remains Free when resizing enters a preset's 0.5% matching tolerance. Refused aspect refits leave both the crop and the selected lock unchanged. Crop mode no longer treats unresolved media as square for preset matching or constraints; its layout placeholder does not determine the lock. The lock-pruning effect returns immediately when no locks are stored.

Overlay movement already held an initially capped axis in `movePlacement`; pure and component regressions now explicitly verify that a diagonal gesture previews and commits the editable y movement with x capped. A wholly capped drag reports keyLimit once per gesture. Keyboard nudges check the requested axis before clamping, so an attempt at a clamped edge still reports the limit. Missing-clip feedback ignores editing keys in text fields, where the timeline shortcut handler does not undo or redo. Pure memoized context tokens replace the earlier render-mutated counters; notices contain no documents, and the refusal callback follows context changes without an effect. Restoration visibility is derived from clip presence, and the restored notice is discarded with a guarded state adjustment instead of a render-time ref mutation, preventing revival after a second removal. Component regressions exercise each correction, retained lock pruning and notice restoration, including save acknowledgements and single-render content/selection transitions.

The isolated follow-up report at `/tmp/vis-perf/clip-transforms-followup` measured warm opening at **97.44 → 97.84 ms (+0.41%)** against `/tmp/vis-perf/step-b-review2-after`, unchanged **60.0 / 60.0 / 60.4 fps** zoom/scroll/drag, and **0 black frames out of 936**. No interaction frames exceeded 25 ms and no interaction long tasks were recorded. First-frame latency was **34.5 ms median / 44.7 ms maximum**, within the clarified 300 ms absolute target. All seven benchmark cases passed, with the conditional LGPL-build case skipped; renderer RSS was 927 MB versus the historical 928 MB, retaining the existing over-target measurement.

### Final narrow review (2026-11-15)

This review narrows the earlier follow-up lock-storage rule to the author actions listed above. Inspector key/ease changes use the general transform commit without registering a lock; crop geometry fields remember it only with resolved dimensions. Accepted Reset transform clears it. Crop gestures capture whether dimensions were known at pointerdown, so metadata arriving before release cannot register a lock from an unknown-size render. Unknown-size edits stay unconstrained and continue deriving the lock when dimensions arrive.

Notice context again uses explicit numeric content and selection counters. A stable refusal callback reads the latest counters through a ref, including callbacks retained before a pointerdown changes selection. Notices retain only numbers, never a document or memoized identity token. Visibility derives from those counters and clip presence; an effect discards restored missing-clip notices after commit, with no state update during render. Component regressions cover key add/remove, ease, reset, unknown-size field/nudge edits, metadata resolution during a pointer gesture, and an immediate pointerup refusal through a callback captured before selecting an unselected capped overlay. Existing save-race, restoration, selection and single-render transition checks remain in place.

## Agents

- The timeline guide (`workbench/core/src/instructions/guides/timeline.ts`) and Claude's `prompt.ts` document `crop`, animatable overlay fields, source-time keys and the aspect rule, with one example each (a vertical reframe that pans; a slow push-in on a still). No recommended moves or defaults.
- Invalid writes fail with the specific zod message and point to the timeline guide, as today.

### Step d implementation (2026-11-15)

The on-demand timeline guide and Claude's timeline instructions now describe main/overlay crop, independent animated overlay x/y/width/opacity, the `Animated<T>` shape (a plain value or a key array), strictly increasing source-time keys, endpoint holds, all three eases, 2–32 keys per property and the one-aspect crop rule. Each includes a vertical pan reframe and a slow still push-in as field examples; neither applies a move or defines a taste default. Codex and DeepSeek retain their short shared prompts and obtain the schema from the guide. Their guide tests assert the transform vocabulary and continue asserting that rotation is unsupported.

A protocol test checks `canvas.apply` / `timeline.set` validation for mixed-aspect crop and a 33-key overlay property, including the specific zod messages without changing them. One deterministic fake process speaks Codex app-server or DeepSeek ACP and runs through the real adapters, MCP and gateway with no providers or model connections. Both paths read the timeline guide, commit a trimmed 2× main-video crop and an image overlay with keyed crop, x, y, width and opacity, then receive both validation refusals and the timeline-guide hint. Browser acceptance checks the saved document/revision, merged key diamonds, overlay geometry and opacity at 0 and 1.5 seconds, and red/blue main-picture pixels in preview screenshots. Overlay expectations include contract even-pixel rounding; only browser subpixel layout uses a tolerance below half a CSS pixel. Browser acceptance uses a 1600×1000 viewport at DPR 2 and saves preview-area captures under `/tmp/vis-step-d-agents`.

Both READMEs describe transforms and mark this RFC complete. The existing full-frame crop acceptance now waits for ResizeObserver to publish a non-zero source frame before comparing both handle dimensions, preserving its original tolerance; zero is a mount-time state, not the fixture's settled geometry.

### Step d review corrections (2026-11-15)

Aspect locks now derive from the current crop using the preset matching rule above; only explicit choices are stored, and clip removal prunes them. An external 4:3 crop updates the Inspector lock before the next resize, which preserves its framing. Crop commits no longer overwrite a new explicit choice with the previous lock. Pure and browser regressions cover preset tolerance, crops created under Output, external framing, deletion/undo-shaped restoration and reused ids.

Overlay selection remains available at the key limit. A plain click selects without refusal; an attempted drag beyond the start threshold or a capped commit reports keyLimit. `editPlacement` owns commit-time refusal on both pointer and keyboard paths. Content/selection counters advance during render without a layout-effect state update or an extra render per edit; notices retain numeric context. Missing feedback expires on undo/redo input or restoration as well as the existing editing input/selection changes, and cannot revive after a second removal. Browser regressions exercise each case and count actual OverlayLayer renders in a test-only instrumented bundle.

The fake-agent acceptance resolves `/opt/homebrew/bin/ffmpeg` on macOS and PATH elsewhere, probes it before deciding readiness, and uses that binary for fixture creation and screenshot decoding. Failure diagnostics tolerate missing browser/admin resources after a failed setup; a regression verifies that the original setup error survives. The RFC status now agrees with the completed roadmap.

The skip audit identified absent ignored built-in font binaries: all seven `timeline-text.e2e.ts` cases, four `font-manifest.test.ts` family checks and three real ASS caption tests were skipped. `pnpm fonts:fetch` installed the manifest-pinned binaries/licenses with SHA-256 verification before the corrected gates; no skip guard or assertion was relaxed. The audit and complete gate reports live under `/tmp`.

## Steps

| Step | Content |
|---|---|
| S1 | Export filter-chain spike (above); record result here |
| a | Contract, `evaluateAnimated` / `clipTransformAt`, validation, export for main and overlay clips, protocol + render tests |
| b | Preview transforms in the player loop; preview/export frame comparison test |
| c | Minimal editor (inspector, crop mode, key diamonds); e2e for add key, move key, ease, crop edit, undo |
| d | Done: Agent guide, prompt, both READMEs, roadmap; Codex and DeepSeek acceptance with the fake agent in e2e |

Performance: re-run `pnpm --filter @vis/web perf` timeline report after b and c; transforms must not lower the 0024 playback numbers by more than 10 %.

## Decisions

- No separate "fill" (cover) mode on the main track: the crop aspect lock "Output" expresses it explicitly (maintainer, 2026-11-15).

## Open items (2026-11-15)

- A keyboard nudge at a clamped edge reports keyLimit even when the requested move is a no-op.
- Missing-notice clearing does not exclude `contenteditable=""` or `contenteditable="plaintext-only"` regions.

## Open questions

1. Overlay limit: animated overlays cost more per frame. Keep `overlayClipsPerTrack: 50` unless S1 shows otherwise.

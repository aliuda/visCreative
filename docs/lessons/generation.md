# Generation lessons

## Independent crop origin and size rounding can cross the frame edge

- **Symptom:** a half-frame crop at 0.5 on a 1001-pixel source compiles to origin 501 and width 501.
- **Cause:** rounding the normalized origin and width separately can add a pixel beyond the source boundary.
- **Instead:** round and clamp both edges, then subtract the rounded left/top from right/bottom. Regress the odd-sized source and a partial crop whose far edge rounds up.
- **Found in:** [RFC 0050 review corrections](../rfc/0050-clip-transforms.md#step-a-review-corrections-2026-11-15), `timeline-render.test.ts`, 2026-11-15.

## Animated FFmpeg dimensions do not reconfigure every downstream expression

- **Symptom:** a slow crop drifts over 13 px after a dynamic scaler, or an animated overlay moves but keeps its first width.
- **Cause:** `crop` caches expression `iw`/`ih` when configured; `geq` also retains its configured output dimensions. Upstream `scale=eval=frame` does not update those assumptions.
- **Instead:** use fractional `geq` sampling for animated crop windows, and apply overlay alpha before its animated scaler. If a fixed crop follows an animated scaler, calculate coordinates from explicit animated dimensions rather than cached `iw`/`ih`. Check position, size and alpha together at the endpoints and midpoint with real FFmpeg frames.
- **Found in:** [RFC 0050 S1 export spike](../rfc/0050-clip-transforms.md#s1-decision-maintainer-approved-2026-11-15), 2026-11-15.

## Timestamp rounding can delay a hold key by one frame

- **Symptom:** after a speed change, an exported hold key changes one frame later than the shared evaluator.
- **Cause:** `AVTB` timestamps have microsecond precision; a frame at one-third of a second can reach an expression as 0.333333, before the exact key boundary. Dividing source milliseconds by speed can also differ from the frame clock by one floating-point ULP.
- **Instead:** sample transforms on the output frame index divided by fps (including the overlay's first-frame offset), and use a nanosecond tolerance only for segment-boundary comparisons. Keep interpolation on the exact frame clock. Regress hold boundaries at both 3× and 0.3×, including held source frames after a very short trim.
- **Found in:** [RFC 0050 step a](../rfc/0050-clip-transforms.md#step-a-implementation-measurements-2026-11-15), `timeline-render.test.ts`, 2026-11-15.

## Sampler constants must match pixel depth and range

- **Symptom:** fitted bars acquire a colour cast when an animated crop reads a high-depth RGB image.
- **Cause:** `geq` can preserve negotiated high-depth YUV planes, while black/neutral/opaque values 16/128/255 describe eight-bit limited-range pixels.
- **Instead:** normalize the animated sampler input to eight-bit limited range, retaining alpha where present. Regress a 16-bit RGB source and inspect the fitted bars after encoding.
- **Found in:** [RFC 0050 step a](../rfc/0050-clip-transforms.md#step-a-implementation-measurements-2026-11-15), `timeline-render.test.ts`, 2026-11-15.

## Encoder pipe failure does not prove process closure

- **Symptom:** cancelling a render stuck in `seek` fails with EBUSY on its partial MP4, leaves a locked temporary directory, and rejects the serial render queue on Windows.
- **Cause:** killing ffmpeg can reject the encoding promise through stdin's error event before the child closes. Awaiting that rejected promise therefore does not wait for the output handle to be released; Chrome's abort close was also started without awaiting it before cleanup.
- **Instead:** track encoder `close` independently of encoding errors and share an awaited Chrome close promise. Remove partial output only after both close, with bounded Windows EBUSY/EPERM retries; catch a permanent cleanup failure so the cancelled job cannot strand subsequent jobs. Regress stdin error and process exit before close, delayed Chrome closure, and a cleanup failure, while retaining the real stuck-seek queue test.
- **Found in:** [render cancellation regression](../../packages/generation/src/providers/render/render-cancellation.test.ts), [RFC 0022 render teardown](../rfc/0022-windows.md#7-render-provider), 2026-11-13.

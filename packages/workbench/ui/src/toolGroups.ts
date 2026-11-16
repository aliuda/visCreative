import { ViewedImages, type JobView, type TranscriptItem } from '@vis/protocol'

export type ToolCall = { call?: TranscriptItem; result?: TranscriptItem }
export type ToolTranscriptGroup = { kind: 'tools'; itemId: string; calls: ToolCall[] }
export type ImageTranscriptGroup = { kind: 'images'; itemId: string; calls: ToolCall[]; paths: string[] }
export type TranscriptGroup = ToolTranscriptGroup | ImageTranscriptGroup | { kind: 'item'; item: TranscriptItem }

export function viewedImagePaths(pair: ToolCall): string[] | undefined {
  const images = [pair.call, pair.result].flatMap(item => {
    const parsed = ViewedImages.safeParse((item?.payload as { viewedImages?: unknown } | null)?.viewedImages)
    return parsed.success ? [parsed.data] : []
  })
  return images.length ? [...new Set(images.flat().map(image => image.path))] : undefined
}

function generationJobId(pair: ToolCall): string | undefined {
  const input = (pair.call?.payload as { input?: { jobId?: unknown } } | undefined)?.input
  const text = (pair.result?.payload as { text?: unknown } | undefined)?.text
  let result: unknown = text
  if (typeof text === 'string') {
    try { result = JSON.parse(text) } catch { /* Non-JSON or truncated tool results have no job ID to link */ }
  }
  const jobId = result && typeof result === 'object' && 'jobId' in result ? result.jobId : input?.jobId
  return typeof jobId === 'string' && jobId.length ? jobId : undefined
}

/** Tool receipts retain status at submission time; job events supplement later cancellation status. */
export function generationJob(pair: ToolCall, jobs: ReadonlyMap<string, JobView> | undefined): JobView | undefined {
  const jobId = jobs?.size ? generationJobId(pair) : undefined
  return jobId ? jobs?.get(jobId) : undefined
}

export function transcriptGenerationJobIds(items: TranscriptItem[]): string[] {
  return [...new Set(groupTranscript(items).flatMap(group => group.kind !== 'item'
    ? group.calls.flatMap(pair => { const jobId = generationJobId(pair); return jobId ? [jobId] : [] }) : []))]
}

function toolUseId(item: TranscriptItem): string | undefined {
  const id = (item.payload as { toolUseId?: unknown } | null)?.toolUseId
  return typeof id === 'string' && id.length ? id : undefined
}

export function groupTranscript(items: TranscriptItem[]): TranscriptGroup[] {
  const calls: ToolCall[] = items.filter(item => item.kind === 'tool_call').map(call => ({ call }))
  const pairs = new Map(calls.map(pair => [pair.call!, pair]))
  // Text may arrive during tool execution; still merge results under the original call.
  for (const item of items) {
    if (item.kind !== 'tool_result') continue
    const id = toolUseId(item)
    const pair = id === undefined ? undefined : calls.find(candidate =>
      !candidate.result && toolUseId(candidate.call!) === id,
    )
    if (pair) pair.result = item
    else pairs.set(item, { result: item })
  }
  const groups: TranscriptGroup[] = []
  let tools: ToolTranscriptGroup | ImageTranscriptGroup | undefined
  let segmentId: string | undefined
  for (const item of items) {
    if (item.kind !== 'tool_call' && item.kind !== 'tool_result') {
      groups.push({ kind: 'item', item })
      tools = undefined
      segmentId = undefined
      continue
    }
    segmentId ??= item.itemId
    const pair = pairs.get(item)
    if (!pair) continue
    const paths = viewedImagePaths(pair)
    const kind = paths === undefined ? 'tools' : 'images'
    if (!tools || tools.kind !== kind) {
      const itemId = tools ? item.itemId : segmentId
      tools = kind === 'images' ? { kind, itemId, calls: [], paths: [] } : { kind, itemId, calls: [] }
      groups.push(tools)
    }
    tools.calls.push(pair)
    if (tools.kind === 'images') tools.paths = [...new Set([...tools.paths, ...paths!])]
  }
  return groups.filter(group => group.kind === 'item' || group.calls.length > 0)
}

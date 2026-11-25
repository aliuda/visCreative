import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TimelineDoc } from '@vis/protocol'
import type { VideoEncoder } from './video-encoder'

const mocks = vi.hoisted(() => ({ exec: vi.fn(), run: vi.fn(), detect: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(() => {}, { [promisify.custom]: mocks.exec }),
}))
vi.mock('./media', async importOriginal => ({
  ...await importOriginal<typeof import('./media')>(),
  runMedia: mocks.run,
}))
vi.mock('./encoders', () => ({ detectVideoEncoder: mocks.detect }))
vi.mock('./ffmpeg-version', () => ({ requireFfmpeg7: vi.fn() }))

import { renderTimeline } from './timeline-render'

const hardware: VideoEncoder = { name: 'h264_nvenc', hardware: true, args: ['-cq', '20'], filter: 'format=nv12' }
const software: VideoEncoder = { name: 'libx264', hardware: false, args: ['-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] }
const doc: TimelineDoc = { version: 1, output: { width: 108, height: 192, fps: 10 }, tracks: [
  { id: 'main', kind: 'video', muted: false, volume: 1, clips: [
    { id: 'phone', source: { nodeId: 'phone', assetVersionId: 'phone' }, startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0 },
  ] },
] }
const sources = new Map([['phone', { kind: 'video' as const, path: resolve('phone.mp4'), durationMs: 2000, width: 192, height: 108 }]])
const attempts: { args: string[]; filter: string; path: string }[] = []

beforeEach(() => {
  mocks.exec.mockResolvedValue({ stdout: JSON.stringify({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 192, height: 108, pix_fmt: 'yuv420p', avg_frame_rate: '10/1', time_base: '1/10240', side_data_list: [{ rotation: 90 }] }],
    format: { duration: '2' },
  }) })
  mocks.detect.mockImplementation(async opts => opts.priority.includes('h264_nvenc') ? hardware : software)
  mocks.run.mockImplementation(async (_executable, args, opts) => {
    attempts.push({ args, filter: readFileSync(args[args.indexOf('-/filter_complex') + 1], 'utf8'), path: args.at(-1) })
    opts.onTime?.(attempts.length === 1 ? 1600 : 600)
  })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  attempts.length = 0
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const render = (encoder = hardware, extras: { signal?: AbortSignal; onProgress?: (value: number) => void } = {}) =>
  renderTimeline(doc, sources, { encoder, ffmpegPath: 'test-ffmpeg', ffprobePath: 'test-ffprobe', ...extras })
const encodedWith = () => attempts.map(attempt => attempt.args[attempt.args.indexOf('-c:v') + 1])

it('checks resolved post-rotation output dimensions and uses software before rendering an incompatible size', async () => {
  mocks.detect.mockResolvedValue(software)
  const result = await render()
  try {
    expect(mocks.detect).toHaveBeenCalledWith({
      ffmpegPath: 'test-ffmpeg', priority: ['h264_nvenc', 'libx264', 'libopenh264'], output: { width: 108, height: 192, fps: 10 },
    })
    expect(encodedWith()).toEqual(['libx264'])
    expect(result).toMatchObject({ width: 108, height: 192, fps: 10, mime: 'video/mp4', mode: 'encode' })
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('encoder=libx264'))
  } finally { await result.dispose() }
})

it('retries a failed hardware render once with software, preserving output and monotonic progress', async () => {
  const run = mocks.run.getMockImplementation()!
  mocks.run.mockImplementationOnce(async (...args) => {
    await run(...args)
    throw new Error('Hardware device lost')
  })
  const progress: number[] = []
  const result = await render(hardware, { onProgress: value => progress.push(value) })
  try {
    expect(encodedWith()).toEqual(['h264_nvenc', 'libx264'])
    expect(mocks.detect.mock.calls[1]![0]).toMatchObject({ priority: ['libx264', 'libopenh264'], output: { width: 108, height: 192, fps: 10 } })
    expect(attempts[0]!.filter).toContain(',format=nv12[video]')
    expect(attempts[1]!.filter).not.toContain('format=nv12')
    for (const attempt of attempts) {
      expect(attempt.filter).toContain('scale=108:192')
      expect(attempt.filter).toContain('fps=10')
      expect(attempt.args).toEqual(expect.arrayContaining(['-t', '2.000', '-c:a', 'aac', '-movflags', '+faststart']))
    }
    expect(attempts[1]!.args).toEqual(expect.arrayContaining(software.args))
    expect(progress).toEqual([0, 0.8, 0.8, 1])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retrying with software'))
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('encoder=libx264'))
  } finally { await result.dispose() }
})

it('propagates a failed software retry and removes the partial output directory', async () => {
  const run = mocks.run.getMockImplementation()!
  mocks.run.mockImplementation(async (...args) => {
    await run(...args)
    throw new Error('Encoding failed')
  })
  await expect(render()).rejects.toThrow('Encoding failed')
  expect(encodedWith()).toEqual(['h264_nvenc', 'libx264'])
  expect(existsSync(dirname(attempts[0]!.path))).toBe(false)
})

it('does not retry a software failure', async () => {
  mocks.run.mockRejectedValue(new Error('Software encoding failed'))
  await expect(render(software)).rejects.toThrow('Software encoding failed')
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(mocks.detect).not.toHaveBeenCalled()
})

it('does not retry hardware encoding after cancellation', async () => {
  const controller = new AbortController()
  mocks.run.mockImplementation(async () => {
    controller.abort(new Error('Cancelled export'))
    throw controller.signal.reason
  })
  await expect(render(hardware, { signal: controller.signal })).rejects.toThrow('Cancelled export')
  expect(mocks.run).toHaveBeenCalledTimes(1)
  expect(mocks.detect).toHaveBeenCalledTimes(1)
})

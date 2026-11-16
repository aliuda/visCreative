import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openSpaceDb, spaceSchema as s } from '@vis/storage'
import { createSessionService, killTree } from '@vis/workbench-core'
import { createClaudeRuntime, type QueryFn } from './adapter'

vi.mock('@vis/workbench-core', async importOriginal => {
  const core = await importOriginal<typeof import('@vis/workbench-core')>()
  return { ...core, killTree: vi.fn(core.killTree) }
})

let configDir: string
beforeEach(() => { configDir = mkdtempSync(join(tmpdir(), 'vis-claude-disposal-')) })
afterEach(() => { rmSync(configDir, { recursive: true, force: true }) })

it('termination and concurrent disposal wait for the delayed consumer to record the turn', async () => {
  const db = openSpaceDb(':memory:')
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  let aborted!: () => void
  const abortSeen = new Promise<void>(resolve => { aborted = resolve })
  const query: QueryFn = ({ options }) => {
    options!.abortController!.signal.addEventListener('abort', aborted, { once: true })
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
      // The SDK can drain buffered output after abort, even after taskkill has completed.
      await delayed
    })(), { interrupt: async () => {} }) as ReturnType<QueryFn>
  }
  const events: string[] = []
  const runtime = createClaudeRuntime({ db, report: event => { if (event.type === 'turn_ended') events.push(event.status) } }, {
    query, workDir: () => join(tmpdir(), 'vis-delayed-claude'), cliBinDir: tmpdir(), socketPath: 'unused',
    visMcp: { command: 'vis', args: ['mcp'] },
    issueToken: () => ({ token: 'fake', tokenHash: 'fake' }),
    env: { CLAUDE_CONFIG_DIR: configDir },
  })
  const sessions = createSessionService({ db, runtime })
  const session = sessions.create({ requestId: 'session' })
  const input = { sessionId: session.sessionId, turnId: 'turn', sessionTitle: 'Test', titleSource: 'user' as const, text: 'Hold', refs: [], inputSnapshotId: 'snapshot', resumeId: null }
  // Use a real session but dispatch directly: the test observes the runtime's final instance write.
  await runtime.dispatchTurn(input)
  let terminated = false, disposed = false
  const termination = runtime.terminateTurn(input).then(() => { terminated = true })
  await abortSeen
  const disposal = runtime.dispose().then(() => { disposed = true })
  try {
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(terminated).toBe(false)
    expect(disposed).toBe(false)
    expect(events).toEqual([])
  } finally { release(); await Promise.all([termination, disposal]) }
  expect(events).toEqual(['interrupted'])
  expect(db.select().from(s.agentInstances).get()).toMatchObject({ status: 'exited', exitReason: 'interrupted' })
  sessions.dispose()
  db.$client.close()
})


it('disposal waits for an already-finishing consumer whose tree kill is delayed', async () => {
  const db = openSpaceDb(':memory:')
  let release!: () => void, started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const killing = new Promise<void>(resolve => { started = resolve })
  const core = await vi.importActual<typeof import('@vis/workbench-core')>('@vis/workbench-core')
  vi.mocked(killTree).mockImplementationOnce(async (child, signal) => { started(); await held; await core.killTree(child, signal) })
  const events: string[] = []
  const query: QueryFn = ({ options }) => {
    options!.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: new AbortController().signal })
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
    })(), { interrupt: async () => {} }) as ReturnType<QueryFn>
  }
  const runtime = createClaudeRuntime({ db, report: event => { if (event.type === 'turn_ended') events.push(event.status) } }, {
    visMcp: { command: 'vis', args: ['mcp'] },
    query, workDir: () => tmpdir(), cliBinDir: tmpdir(), socketPath: 'unused', issueToken: () => ({ token: 'fake', tokenHash: 'fake' }),
    env: { CLAUDE_CONFIG_DIR: configDir },
  })
  const sessions = createSessionService({ db, runtime })
  const session = sessions.create({ requestId: 'session' })
  await runtime.dispatchTurn({ sessionId: session.sessionId, turnId: 'turn', sessionTitle: 'Test', titleSource: 'user', text: 'Hold', refs: [], inputSnapshotId: 'snapshot', resumeId: null })
  await killing
  let disposed = false
  const disposal = runtime.dispose().then(() => { disposed = true })
  try {
    // Another kill may exit the process; the first consumer still owes the database its terminal write.
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    expect(disposed).toBe(false)
    expect(events).toEqual([])
  } finally { release(); await disposal }
  expect(events).toHaveLength(1)
  expect(db.select().from(s.agentInstances).get()?.status).toBe('exited')
  sessions.dispose()
  db.$client.close()
})


it.each(['starting', 'active'])('disposal stops a %s turn before delayed catalog cleanup finishes', async phase => {
  const db = openSpaceDb(':memory:')
  const core = await vi.importActual<typeof import('@vis/workbench-core')>('@vis/workbench-core')
  let release!: () => void, turnAborted!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const aborted = new Promise<void>(resolve => { turnAborted = resolve })
  let catalogChild: ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>> | undefined
  let turnChild: typeof catalogChild
  let sawTurnAbort = false
  vi.mocked(killTree).mockImplementation(async (child, signal) => {
    if (catalogChild && child.stdin === catalogChild.stdin) await held
    await core.killTree(child, signal)
  })
  const query: QueryFn = ({ prompt, options }) => {
    const child = options!.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, signal: options!.abortController!.signal })
    if (typeof prompt !== 'string') {
      catalogChild = child
      return Object.assign((async function* () {})(), { supportedModels: () => new Promise(() => {}), close: () => {} }) as ReturnType<QueryFn>
    }
    turnChild = child
    options!.abortController!.signal.addEventListener('abort', () => { sawTurnAbort = true; turnAborted() }, { once: true })
    return (async function* () {
      if (phase === 'active') yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
      await aborted
      throw new Error('interrupted turn')
    })() as ReturnType<QueryFn>
  }
  const runtime = createClaudeRuntime({ db, report: () => {} }, {
    visMcp: { command: 'vis', args: ['mcp'] },
    query, workDir: () => tmpdir(), cliBinDir: tmpdir(), socketPath: 'unused', issueToken: () => ({ token: 'fake', tokenHash: 'fake' }),
    env: { CLAUDE_CONFIG_DIR: configDir },
  })
  const sessions = createSessionService({ db, runtime })
  const session = sessions.create({ requestId: 'session' })
  const dispatch = runtime.dispatchTurn({ sessionId: session.sessionId, turnId: 'turn', sessionTitle: 'Test', titleSource: 'user', text: 'Hold', refs: [], inputSnapshotId: 'snapshot', resumeId: null })
  const dispatched = dispatch.catch(error => error)
  try {
    await expect.poll(() => turnChild !== undefined).toBe(true)
    if (phase === 'active') await dispatch
    const catalog = runtime.agentOptions('claude', {}).catch(error => error)
    await expect.poll(() => catalogChild !== undefined).toBe(true)
    let disposed = false
    const disposal = runtime.dispose().then(() => { disposed = true })
    try {
      await expect.poll(() => sawTurnAbort).toBe(true)
      await expect.poll(() => turnChild!.exitCode !== null || turnChild!.signalCode !== null).toBe(true)
      expect(disposed).toBe(false)
    } finally { release(); await disposal }
    expect(await catalog).toMatchObject({ code: 'unavailable' })
    await dispatched
    expect(db.select().from(s.agentInstances).get()?.exitReason).toBe('interrupted')
  } finally {
    release()
    await runtime.dispose()
    await dispatched
    vi.mocked(killTree).mockImplementation(core.killTree)
    sessions.dispose()
    db.$client.close()
  }
})

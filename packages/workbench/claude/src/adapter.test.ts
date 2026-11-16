import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ModelInfo, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { VisError } from '@vis/domain'
import { createSessionService, type SessionService } from '@vis/workbench-core'
import { createClaudeRuntime, type ClaudeRuntimeOptions } from './adapter'

/** Controllable fake SDK call: tests push messages one by one or fail the process */
class FakeQuery {
  readonly queue: (SDKMessage | Error | 'end')[] = []
  private wake: (() => void) | undefined
  interrupted = false
  ignoreAbort = false
  closed = false
  readModels = vi.fn<() => Promise<ModelInfo[]>>(async () => catalogModels)
  constructor(readonly options: Options, readonly prompt: string | AsyncIterable<SDKUserMessage>) {
    options.abortController?.signal.addEventListener('abort', () => { if (!this.ignoreAbort) this.push(new Error('aborted')) })
  }
  push(item: SDKMessage | Error | 'end') {
    this.queue.push(item)
    this.wake?.()
  }
  async *iterate(): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      while (this.queue.length === 0) await new Promise<void>(r => { this.wake = r })
      const item = this.queue.shift()!
      if (item === 'end') return
      if (item instanceof Error) throw item
      yield item
    }
  }
  asQuery(): Query {
    const gen = this.iterate()
    return Object.assign(gen, {
      interrupt: async () => { this.interrupted = true; this.push(result('error_during_execution')); this.push('end'); return undefined },
      close: () => { this.closed = true },
      supportedModels: () => this.readModels(),
    }) as unknown as Query
  }
}

const catalogModels: ModelInfo[] = [
  { value: 'default', resolvedModel: 'claude-opus-test', displayName: 'Default model', description: 'SDK default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-test', displayName: 'Opus', description: 'Opus model', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-test', displayName: 'Sonnet', description: 'Sonnet model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku model', supportsEffort: false, supportedEffortLevels: ['high'] },
  { value: 'fable', displayName: 'Fable', description: 'Fable model' },
]

let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createClaudeRuntime>
let runtimeOptions: ClaudeRuntimeOptions
let calls: FakeQuery[]
let nextQuery: ((q: FakeQuery) => void) | undefined
let clock = 1_800_000_000_000
let fallbackDirs: string[]
let tokenSeq = 0
let environment: Record<string, string | undefined>
let homeDir: string

const init = (sessionId = 'claude-ses-1') => ({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-init' }) as unknown as SDKMessage
const assistant = (uuid: string, content: unknown[]) => ({ type: 'assistant', uuid, parent_tool_use_id: null, session_id: 'x', message: { content } }) as unknown as SDKMessage
const toolResult = (uuid: string, toolUseId: string, text: string) =>
  ({ type: 'user', uuid, parent_tool_use_id: null, session_id: 'x', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } }) as unknown as SDKMessage
const result = (subtype: 'success' | 'error_during_execution' = 'success') => ({ type: 'result', subtype, is_error: subtype !== 'success' }) as unknown as SDKMessage

beforeEach(() => {
  db = openSpaceDb(':memory:')
  calls = []
  fallbackDirs = []
  tokenSeq = 0
  nextQuery = undefined
  homeDir = mkdtempSync(join(tmpdir(), 'vis-claude-settings-'))
  environment = { PATH: '/usr/bin', HOME: homeDir }
  sessions = createSessionService({ db, runtime: { agentOptions: (kind, options) => runtime.agentOptions(kind, options), ensureReady: id => runtime.ensureReady(id), dispatchTurn: i => runtime.dispatchTurn(i), terminateTurn: i => runtime.terminateTurn(i), interruptTurn: i => runtime.interruptTurn(i) }, now: () => ++clock })
  runtimeOptions = {
    query: ({ prompt, options }) => {
      const q = new FakeQuery(options!, prompt)
      calls.push(q)
      nextQuery?.(q)
      return q.asQuery()
    },
    workDir: id => join(tmpdir(), 'vis-test-work', `${id}`),
    issueToken: () => ({ token: `spc_1.tok${++tokenSeq}`, tokenHash: `hash${tokenSeq}` }),
    socketPath: '/tmp/vis.sock',
    sandboxAvailable: () => false,
    visMcp: { command: process.execPath, args: ['vis.mjs', 'mcp'] },
    cliBinDir: '/opt/vis/bin',
    fallbackDirs,
    initTimeoutMs: 200,
    interruptGraceMs: 50,
    env: environment,
    now: () => ++clock,
  }
  runtime = createClaudeRuntime({ db, report: e => sessions.handleAgentEvent(e) }, runtimeOptions)
})

afterEach(async () => {
  sessions.dispose()
  await runtime.dispose()
  db.$client.close()
  rmSync(homeDir, { recursive: true, force: true })
})

let req = 0
function newSession() {
  return sessions.create({ requestId: `r${++req}`, title: '分镜', agentKind: 'claude' }).sessionId
}
function send(sessionId: string, text: string) {
  return sessions.sendMessage({ requestId: `r${++req}`, sessionId, text, refs: [] })
}
const turnOf = (messageId: string) => db.select().from(s.turns).where(eq(s.turns.messageId, messageId)).get()!
const message = (id: string) => db.select().from(s.messages).where(eq(s.messages.id, id)).get()!
const instances = (sessionId: string) => db.select().from(s.agentInstances).where(eq(s.agentInstances.sessionId, sessionId)).all()
const notices = (sessionId: string) => db.select().from(s.transcriptEntries)
  .where(and(eq(s.transcriptEntries.sessionId, sessionId), eq(s.transcriptEntries.kind, 'notice'))).all().map(n => (n.payload as { code: string }).code)
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 5))
  expect(check()).toBe(true)
}

function writeSettings(settings: unknown, configDir = join(homeDir, '.claude')) {
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
}

describe('Claude model catalog', () => {
  it('maps SDK aliases and per-model efforts without creating a session, turn or valid gateway token', async () => {
    const models = await runtime.agentOptions('claude', {})
    expect(models).toEqual(catalogModels.map(model => ({
      id: model.value, label: model.displayName, description: model.description,
      isDefault: model.value === 'default',
      efforts: model.supportsEffort === true ? model.supportedEffortLevels!.map(id => ({ id, label: id })) : [],
      defaultEffort: null, serviceTiers: [],
    })))
    const probe = calls[0]!
    expect(probe.closed).toBe(true)
    expect(probe.options.abortController!.signal.aborted).toBe(true)
    expect(typeof probe.prompt).toBe('object')
    expect(await (probe.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
    expect(probe.options.persistSession).toBe(false)
    expect(existsSync(probe.options.cwd!)).toBe(false)
    expect(db.select().from(s.sessions).all()).toEqual([])
    expect(db.select().from(s.turns).all()).toEqual([])
    expect(db.select().from(s.agentInstances).all()).toEqual([])
    expect(tokenSeq).toBe(1)
  })

  it.each(['sonnet', 'claude-sonnet-test'])('marks the configured default %s by exact alias or resolved model', async model => {
    runtimeOptions.model = model
    const models = await runtime.agentOptions('claude', {})
    expect(models.filter(option => option.isDefault).map(option => option.id)).toEqual(['sonnet'])
    expect(calls[0]!.options.model).toBe(model)
  })

  it('adds an unlisted configured model as the only default without guessing effort support', async () => {
    runtimeOptions.model = 'custom-proxy-model'
    const models = await runtime.agentOptions('claude', {})
    expect(models.filter(model => model.isDefault)).toEqual([{ id: 'custom-proxy-model', label: 'custom-proxy-model', isDefault: true, efforts: [], defaultEffort: null, serviceTiers: [] }])
    expect(models).toHaveLength(catalogModels.length + 1)
  })

  it('uses the first resolved match as the only default and preserves its declared efforts', async () => {
    runtimeOptions.model = 'claude-opus-test'
    const models = await runtime.agentOptions('claude', {})
    expect(models.filter(model => model.isDefault).map(model => model.id)).toEqual(['default'])
    expect(models.find(model => model.isDefault)!.efforts.map(effort => effort.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_REGION', 'AWS_PROFILE', 'CLOUD_ML_REGION'])('invalidates cached models when forwarded %s settings change', async key => {
    writeSettings({ env: { [key]: 'test-first-auth' } })
    await runtime.agentOptions('claude', {})
    writeSettings({ env: { [key]: 'test-second-auth' } })
    await runtime.agentOptions('claude', {})
    expect(calls).toHaveLength(2)
    expect(calls[1]!.options.env![key]).toBe('test-second-auth')
  })

  it('hashes merged auth values consistently and ignores unrelated or overridden exports', async () => {
    writeSettings({ env: { ANTHROPIC_API_KEY: 'test-settings-value', AWS_PROFILE: 'test-profile' } })
    environment.ANTHROPIC_API_KEY = 'test-export-value'
    await runtime.agentOptions('claude', {})
    environment.ANTHROPIC_API_KEY = 'test-other-export'
    environment.OTHER_ENV = 'test-ignored'
    writeSettings({ env: { AWS_PROFILE: 'test-profile', ANTHROPIC_API_KEY: 'test-settings-value' } })
    await runtime.agentOptions('claude', {})
    expect(calls).toHaveLength(1)
    rmSync(join(homeDir, '.claude', 'settings.json'))
    await runtime.agentOptions('claude', {})
    expect(calls).toHaveLength(2)
    expect(calls[1]!.options.env!.ANTHROPIC_API_KEY).toBe('test-other-export')
    environment.ANTHROPIC_API_KEY = ''
    await runtime.agentOptions('claude', {})
    expect(calls).toHaveLength(3)
  })

  it('shares probes only for matching auth hashes and reuses matching cached catalogs', async () => {
    let release!: (models: ModelInfo[]) => void
    nextQuery = q => {
      if (calls.length === 1) q.readModels.mockReturnValue(new Promise<ModelInfo[]>(resolve => { release = resolve }))
    }
    environment.ANTHROPIC_API_KEY = 'test-first-auth'
    const first = runtime.agentOptions('claude', {})
    await until(() => calls.length === 1)
    environment.ANTHROPIC_API_KEY = 'test-second-auth'
    const second = await runtime.agentOptions('claude', {})
    expect(calls).toHaveLength(2)
    release(catalogModels)
    const previous = await first
    expect(second).not.toBe(previous)
    environment.ANTHROPIC_API_KEY = 'test-first-auth'
    expect(await runtime.agentOptions('claude', {})).toBe(previous)
    expect(calls).toHaveLength(2)
  })

  it('uses a dedicated fifteen-second catalog timeout independently of turn startup', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      runtimeOptions.initTimeoutMs = 1
      await runtime.agentOptions('claude', {})
      expect(timer).toHaveBeenCalledWith(expect.any(Function), 15_000)
      expect(timer).not.toHaveBeenCalledWith(expect.any(Function), 1)
    } finally { timer.mockRestore() }
  })

  it('caches success per runtime and shares concurrent catalog reads', async () => {
    let release!: (models: ModelInfo[]) => void
    const gate = new Promise<ModelInfo[]>(resolve => { release = resolve })
    nextQuery = q => { q.readModels.mockReturnValue(gate) }
    const first = runtime.agentOptions('claude', {})
    const second = runtime.agentOptions('claude', { model: 'sonnet' })
    await until(() => calls.length === 1)
    expect(calls[0]!.readModels).toHaveBeenCalledTimes(1)
    release(catalogModels)
    expect(await second).toBe(await first)
    expect(await runtime.agentOptions('claude', {})).toBe(await first)
    expect(calls).toHaveLength(1)
  })

  it('uses turn authentication, PATH and spawn setup while keeping settings sources disabled', async () => {
    writeSettings({ env: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mapped-model', AWS_PROFILE: 'test-profile', OTHER_ENV: 'ignored' } })
    environment.ANTHROPIC_BASE_URL = 'https://example.com/export'
    fallbackDirs.push('/app/tools')
    runtimeOptions.platform = 'win32'
    runtimeOptions.dataDir = join(homeDir, 'data')
    delete environment.PATH
    environment.Path = '/user/tools'
    await runtime.agentOptions('claude', {})
    const probe = calls[0]!
    expect(probe.options).toMatchObject({
      settingSources: [], permissionMode: 'default', canUseTool: expect.any(Function),
      spawnClaudeCodeProcess: expect.any(Function),
      env: { ANTHROPIC_BASE_URL: 'https://example.com', ANTHROPIC_DEFAULT_SONNET_MODEL: 'mapped-model', AWS_PROFILE: 'test-profile', PATH: ['/opt/vis/bin', '/user/tools', '/app/tools'].join(delimiter), CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative' },
    })
    expect(probe.options.tools).toBeUndefined()
    expect(probe.options.allowedTools).toBeUndefined()
    expect(probe.options.mcpServers).toBeUndefined()
    expect(probe.options.env).not.toHaveProperty('VIS_AGENT_TOKEN')
    expect(probe.options.env).not.toHaveProperty('Path')
    expect(probe.options.env).not.toHaveProperty('OTHER_ENV')
    expect(environment.Path).toBe('/user/tools')
  })

  it.each(['reject', 'throw', 'empty'] as const)('rejects with a sanitized VisError after %s and retries with fresh settings', async failure => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      nextQuery = q => {
        if (failure === 'throw') throw new Error('test-auth-value')
        if (failure === 'reject') q.readModels.mockRejectedValue(new Error('test-auth-value'))
        else q.readModels.mockResolvedValue([])
      }
      const error = await runtime.agentOptions('claude', {}).catch(error => error)
      expect(error).toBeInstanceOf(VisError)
      expect(error).toMatchObject({ code: 'unavailable', message: 'Cannot read the Claude model catalog', details: { reason: 'session.models_unavailable' } })
      expect(JSON.stringify(error)).not.toContain('test-auth-value')
      if (failure !== 'throw') expect(calls[0]!.closed).toBe(true)
      writeSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'retry-mapping' } })
      nextQuery = undefined
      expect((await runtime.agentOptions('claude', {}))[0]!.label).toBe('Default model')
      expect(calls).toHaveLength(2)
      expect(calls[1]!.options.env!.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('retry-mapping')
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

  it('times out, closes the query and ignores its late catalog before retrying', async () => {
    runtimeOptions.catalogTimeoutMs = 10
    let release!: (models: ModelInfo[]) => void
    nextQuery = q => { q.readModels.mockReturnValue(new Promise<ModelInfo[]>(resolve => { release = resolve })) }
    await expect(runtime.agentOptions('claude', {})).rejects.toMatchObject({ code: 'unavailable' })
    expect(calls[0]!.closed).toBe(true)
    expect(calls[0]!.options.abortController!.signal.aborted).toBe(true)
    release(catalogModels)
    nextQuery = undefined
    expect((await runtime.agentOptions('claude', {}))[0]!.label).toBe('Default model')
    expect(calls).toHaveLength(2)
  })

  it('disposal closes an in-flight catalog query and rejects later reads', async () => {
    nextQuery = q => { q.readModels.mockReturnValue(new Promise(() => {})) }
    const pending = expect(runtime.agentOptions('claude', {})).rejects.toMatchObject({ code: 'unavailable' })
    await until(() => calls.length === 1)
    await runtime.dispose()
    await pending
    expect(calls[0]!.closed).toBe(true)
    expect(calls[0]!.options.abortController!.signal.aborted).toBe(true)
    await expect(runtime.agentOptions('claude', {})).rejects.toBeInstanceOf(VisError)
  })

  it.each(['success', 'timeout', 'close failure'] as const)('waits for the catalog process to exit after %s', async state => {
    runtimeOptions.catalogTimeoutMs = state === 'timeout' ? 50 : 2000
    let child!: ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>
    nextQuery = q => {
      child = q.options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: q.options.cwd!, env: q.options.env!, signal: q.options.abortController!.signal })
      if (state === 'timeout') q.readModels.mockReturnValue(new Promise(() => {}))
      if (state === 'close failure') {
        const asQuery = q.asQuery.bind(q)
        q.asQuery = () => Object.assign(asQuery(), { close: () => { throw new Error('test-close-failure') } })
      }
    }
    if (state === 'timeout') await expect(runtime.agentOptions('claude', {})).rejects.toMatchObject({ code: 'unavailable' })
    else await runtime.agentOptions('claude', {})
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(existsSync(calls[0]!.options.cwd!)).toBe(false)
  })

  it('keeps concurrent callers waiting until catalog process cleanup finishes', async () => {
    let overlapping!: Promise<unknown>
    nextQuery = q => {
      const child = q.options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: q.options.cwd!, env: q.options.env!, signal: q.options.abortController!.signal })
      const asQuery = q.asQuery.bind(q)
      q.asQuery = () => {
        const query = asQuery()
        const close = query.close.bind(query)
        query.close = () => {
          close()
          overlapping = runtime.agentOptions('claude', {}).then(models => {
            expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
            return models
          })
        }
        return query
      }
    }
    const models = await runtime.agentOptions('claude', {})
    expect(await overlapping).toBe(models)
    expect(calls).toHaveLength(1)
  })

  it('rejects a deferred SDK spawn after the catalog query has closed', async () => {
    await runtime.agentOptions('claude', {})
    const options = calls[0]!.options
    expect(() => options.spawnClaudeCodeProcess!({ command: process.execPath, args: [], env: options.env!, signal: new AbortController().signal })).toThrow('Runtime has stopped')
  })

  it('does not start a catalog query when disposed during the settings read', async () => {
    const pending = expect(runtime.agentOptions('claude', {})).rejects.toMatchObject({ code: 'unavailable' })
    await runtime.dispose()
    await pending
    expect(calls).toHaveLength(0)
  })
})

describe('Claude settings environment', () => {
  it('forwards only ANTHROPIC and explicit auth string values without loading user settings', async () => {
    writeSettings({
      env: {
        ANTHROPIC_BASE_URL: 'https://example.com',
        ANTHROPIC_AUTH_TOKEN: 'test-token',
        ANTHROPIC_API_KEY: 'test-api-key',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'test-model',
        ANTHROPIC_EMPTY: '',
        CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        AWS_REGION: 'test-region',
        AWS_PROFILE: 'test-profile',
        CLOUD_ML_REGION: 'test-cloud-region',
        ANTHROPIC_NUMBER: 42,
        ANTHROPIC_BOOLEAN: true,
        ANTHROPIC_NULL: null,
        ANTHROPIC_OBJECT: { token: 'test-token' },
        ANTHROPIC_ARRAY: ['test-token'],
        OTHER_TOKEN: 'test-token',
        PREFIX_ANTHROPIC_TOKEN: 'test-token',
        anthropic_token: 'test-token',
        AWS_ACCESS_KEY_ID: 'test-access-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        AWS_SESSION_TOKEN: 'test-session-token',
        AWS_REGION_SUFFIX: 'test-region',
        CLAUDE_CODE_OTHER: 'test-other',
        PATH: '/settings/bin',
        HOME: '/settings/home',
        VIS_SOCKET: '/settings/socket',
        VIS_AGENT_TOKEN: 'test-settings-token',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'test-settings-app',
      },
      hooks: { SessionStart: [] },
      permissions: { allow: ['Bash(*)'] },
      model: 'test-settings-model',
    })
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    const options = calls[0]!.options
    expect(options.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://example.com',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      ANTHROPIC_API_KEY: 'test-api-key',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'test-model',
      ANTHROPIC_EMPTY: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_REGION: 'test-region',
      AWS_PROFILE: 'test-profile',
      CLOUD_ML_REGION: 'test-cloud-region',
      AWS_ACCESS_KEY_ID: 'test-access-key',
      AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      AWS_SESSION_TOKEN: 'test-session-token',
      CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
      PATH: ['/opt/vis/bin', '/usr/bin'].join(delimiter),
      HOME: homeDir,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    })
    expect(options.settingSources).toEqual([])
    expect(options.tools).toEqual(['Read', 'Glob', 'Grep'])
    expect(options.allowedTools).toEqual(['mcp__vis__*', 'Read', 'Glob', 'Grep'])
    expect(options.permissionMode).toBe('dontAsk')
    expect(options.model).toBeUndefined()
    expect(options).not.toHaveProperty('hooks')
  })

  it('lets settings override exports while preserving adapter-owned keys', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-settings-token', ANTHROPIC_API_KEY: 'test-settings-key', ANTHROPIC_BASE_URL: 'https://example.com' } })
    environment.ANTHROPIC_AUTH_TOKEN = 'test-export-token'
    environment.ANTHROPIC_API_KEY = 'test-export-key'
    environment.ANTHROPIC_BASE_URL = 'https://example.com/export'
    environment.VIS_SOCKET = '/export/socket'
    environment.VIS_AGENT_TOKEN = 'test-export-token'
    environment.CLAUDE_AGENT_SDK_CLIENT_APP = 'test-export-app'
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env).toMatchObject({
      ANTHROPIC_AUTH_TOKEN: 'test-settings-token',
      ANTHROPIC_API_KEY: 'test-settings-key',
      ANTHROPIC_BASE_URL: 'https://example.com',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    })
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBe('test-export-token')
    expect(environment.ANTHROPIC_BASE_URL).toBe('https://example.com/export')
    expect(environment.VIS_AGENT_TOKEN).toBe('test-export-token')
  })

  it.each(['', undefined])('keeps settings values when an exported value is %j', async value => {
    writeSettings({ env: { ANTHROPIC_API_KEY: 'test-settings-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' } })
    environment.ANTHROPIC_API_KEY = value
    environment.CLAUDE_CODE_OAUTH_TOKEN = value
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env).toMatchObject({ ANTHROPIC_API_KEY: 'test-settings-key', CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth-token' })
  })

  it('ignores non-string values for the explicit auth keys', async () => {
    writeSettings({ env: {
      CLAUDE_CODE_OAUTH_TOKEN: 42,
      CLAUDE_CODE_USE_BEDROCK: true,
      CLAUDE_CODE_USE_VERTEX: null,
      AWS_REGION: [],
      AWS_PROFILE: {},
      CLOUD_ML_REGION: false,
    } })
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(Object.keys(calls[0]!.options.env!).sort()).toEqual(['CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH'])
  })

  it('honors CLAUDE_CONFIG_DIR over the source HOME', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-home-token' } })
    const configDir = join(homeDir, 'custom-config')
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-config-token' } }, configDir)
    environment.CLAUDE_CONFIG_DIR = configDir
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-config-token')
  })

  it('treats an empty CLAUDE_CONFIG_DIR as unset', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-home-token' } })
    environment.CLAUDE_CONFIG_DIR = ''
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-home-token')
  })

  it.each(['~', '~/custom-config'])('expands CLAUDE_CONFIG_DIR %s against the source home', async configured => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-default-token' } })
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-expanded-token' } }, configured === '~' ? homeDir : join(homeDir, 'custom-config'))
    environment.CLAUDE_CONFIG_DIR = configured
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-expanded-token')
  })

  it('uses the source USERPROFILE when HOME is absent on Windows', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-profile-token' } })
    runtimeOptions.platform = 'win32'
    runtimeOptions.dataDir = join(homeDir, 'data')
    delete environment.HOME
    environment.USERPROFILE = homeDir
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-profile-token')
  })

  it('prefers the source HOME over USERPROFILE on Windows', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-home-token' } })
    const profile = join(homeDir, 'profile')
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-profile-token' } }, join(profile, '.claude'))
    runtimeOptions.platform = 'win32'
    runtimeOptions.dataDir = join(homeDir, 'data')
    environment.USERPROFILE = profile
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-home-token')
  })

  it('does not start a Claude query when disposed during the settings read', async () => {
    const dispatch = runtime.dispatchTurn({ sessionId: newSession(), turnId: 'turn-read', sessionTitle: 'Test', titleSource: 'user', text: 'Test', refs: [], inputSnapshotId: 'snapshot', resumeId: null })
    const rejected = expect(dispatch).rejects.toThrow('Runtime has stopped')
    await runtime.dispose()
    await rejected
    expect(calls).toHaveLength(0)
  })

  it('rereads settings at every turn dispatch', async () => {
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-first-token', ANTHROPIC_API_KEY: 'test-first-key' } })
    nextQuery = q => { q.push(init()); q.push(result()); q.push('end') }
    const sid = newSession()
    const first = send(sid, 'First')
    await sessions.idle()
    await until(() => turnOf(first.messageId).status === 'completed')
    writeSettings({ env: { ANTHROPIC_AUTH_TOKEN: 'test-second-token' } })
    send(sid, 'Second')
    await sessions.idle()
    expect(calls[0]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-first-token')
    expect(calls[1]!.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('test-second-token')
    expect(calls[1]!.options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it.each(['missing', 'malformed', 'unreadable'] as const)('dispatches without extra keys when settings are %s', async state => {
    const configDir = join(homeDir, '.claude')
    if (state !== 'missing') {
      mkdirSync(configDir, { recursive: true })
      if (state === 'malformed') writeFileSync(join(configDir, 'settings.json'), '{"env":{"ANTHROPIC_AUTH_TOKEN":"test-token"')
      else mkdirSync(join(configDir, 'settings.json'))
    }
    nextQuery = q => { q.push(init()); q.push(result()); q.push('end') }
    const sent = send(newSession(), 'Test')
    await sessions.idle()
    await until(() => turnOf(sent.messageId).status === 'completed')
    expect(message(sent.messageId).deliveryState).toBe('delivered')
    expect(Object.keys(calls[0]!.options.env!).filter(key => /^ANTHROPIC_/.test(key))).toEqual([])
  })

  it.each([null, [], 'test-token', 42, {}, { env: null }, { env: [] }, { env: 'test-token' }, { env: 42 }])('ignores settings without an env object: %j', async settings => {
    writeSettings(settings)
    nextQuery = q => q.push(init())
    send(newSession(), 'Test')
    await sessions.idle()
    expect(Object.keys(calls[0]!.options.env!).filter(key => /^ANTHROPIC_/.test(key))).toEqual([])
  })
})

describe('A single turn', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('passes session model and effort %s over the runtime default', async effort => {
    runtimeOptions.model = 'sonnet'
    nextQuery = q => { q.readModels.mockResolvedValue(catalogModels.map(model => model.value === 'opus' ? { ...model, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] } : model)) }
    const sid = newSession()
    await sessions.setAgentConfig({ requestId: `config-${effort}`, sessionId: sid, model: 'opus', effort, serviceTier: 'default' })
    nextQuery = q => q.push(init())
    send(sid, 'Configured turn')
    await sessions.idle()
    expect(calls.at(-1)!.options).toMatchObject({ model: 'opus', effort })
    expect(calls.at(-1)!.options).not.toHaveProperty('serviceTier')
  })

  it.each([null, 'invalid', 'minimal', 'HIGH', ''])('drops unsupported effort %j and falls back to the runtime model', async effort => {
    runtimeOptions.model = 'sonnet'
    const sid = newSession()
    nextQuery = q => q.push(init())
    await runtime.dispatchTurn({ sessionId: sid, turnId: `turn-${effort}`, sessionTitle: 'Test', titleSource: 'user', text: 'Test', refs: [], inputSnapshotId: 'snapshot', resumeId: null, agentConfig: { model: null, effort, serviceTier: 'fast' } })
    expect(calls[0]!.options.model).toBe('sonnet')
    expect(calls[0]!.options).not.toHaveProperty('effort')
    expect(calls[0]!.options).not.toHaveProperty('serviceTier')
  })

  it.each([undefined, 'sonnet'])('treats the session default alias as unset with runtime model %s', async model => {
    if (model === undefined) delete runtimeOptions.model
    else runtimeOptions.model = model
    const sid = newSession()
    await sessions.setAgentConfig({ requestId: 'default-alias', sessionId: sid, model: 'default', effort: null, serviceTier: null })
    nextQuery = q => q.push(init())
    send(sid, 'Use defaults')
    await sessions.idle()
    expect(calls.at(-1)!.options.model).toBe(model)
    if (model === undefined) expect(calls.at(-1)!.options).not.toHaveProperty('model')
  })

  it('dispatches with the runtime default after catalog discovery fails', async () => {
    runtimeOptions.model = 'custom-proxy-model'
    nextQuery = q => { q.readModels.mockRejectedValue(new Error('test-auth-value')) }
    await expect(runtime.agentOptions('claude', {})).rejects.toBeInstanceOf(VisError)
    nextQuery = q => q.push(init())
    send(newSession(), 'Continue without a catalog')
    await sessions.idle()
    expect(calls.at(-1)!.options.model).toBe('custom-proxy-model')
  })

  it('leaves model and effort to the SDK when session and runtime defaults are unset', async () => {
    nextQuery = q => q.push(init())
    send(newSession(), 'Default turn')
    await sessions.idle()
    expect(calls[0]!.options).not.toHaveProperty('model')
    expect(calls[0]!.options).not.toHaveProperty('effort')
  })

  it('appends packaged media after the user PATH for the SDK Agent', async () => {
    fallbackDirs.push('/app/ffmpeg')
    nextQuery = q => q.push(init())
    send(newSession(), 'test')
    await sessions.idle()
    expect(calls[0]!.options.env!.PATH).toBe(['/opt/vis/bin', '/usr/bin', '/app/ffmpeg'].join(delimiter))
  })

  it('Send now force-ends startup that ignores abort and starts its selected message before late init arrives', async () => {
    sessions.dispose()
    sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: input => runtime.dispatchTurn(input), interruptTurn: input => runtime.interruptTurn(input), terminateTurn: input => runtime.terminateTurn(input) }, watchdog: { stopGraceMs: 10 }, now: () => ++clock })
    nextQuery = q => { if (calls.length === 1) q.ignoreAbort = true; else q.push(init('next-session')) }
    const sid = newSession()
    const first = send(sid, 'Hung startup')
    await until(() => calls.length === 1)
    const next = send(sid, 'Selected next')
    await sessions.sendNow({ requestId: 'force-starting', sessionId: sid, messageId: next.messageId })
    await sessions.idle()
    expect(calls).toHaveLength(2)
    expect(turnOf(first.messageId).status).toBe('interrupted')
    expect(turnOf(next.messageId).status).toBe('running')
    calls[0]!.push(init('late-session'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(db.select().from(s.sessions).get()?.agentResumeId).toBe('next-session')
    calls[1]!.push(result()); calls[1]!.push('end')
    await until(() => turnOf(next.messageId).status === 'completed')
  })

  it('Windows: merge Path and PATH, preserve system environment, and leave the caller object unchanged', async () => {
    runtimeOptions.platform = 'win32'
    runtimeOptions.dataDir = join(homeDir, 'data')
    delete environment.PATH
    environment.Path = 'C:\\Windows\\System32'
    environment.SystemRoot = 'C:\\Windows'
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, 'test')
    await sessions.idle()
    expect(calls[0]!.options.env).toMatchObject({ PATH: ['/opt/vis/bin', environment.Path].join(delimiter), SystemRoot: 'C:\\Windows' })
    expect(calls[0]!.options.env).not.toHaveProperty('Path')
    expect(environment.Path).toBe('C:\\Windows\\System32')
    expect(environment.PATH).toBeUndefined()
  })
  it('Startup arguments: restrict fallback tools and isolate the MCP transport credentials', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, '写一段旁白')
    await sessions.idle()
    const { options, prompt } = calls[0]!
    const workItemId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId
    expect(prompt).toBe(`写一段旁白\n\n<工作项>\n所属工作项：${workItemId}\n父工作项：无（根工作区）\n有子工作项：否\n</工作项>`)
    expect(options).toMatchObject({
      cwd: join(tmpdir(), 'vis-test-work', `${sid}`),
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['mcp__vis__*', 'Read', 'Glob', 'Grep'],
      permissionMode: 'dontAsk',
      settingSources: [],
      env: { PATH: ['/opt/vis/bin', '/usr/bin'].join(delimiter), HOME: homeDir },
    })
    expect(options.resume).toBeUndefined()
  })

  it('Resuming a session uses the latest workspace hierarchy system instructions', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const first = send(sid, '找个 DeepSeek 来验收')
    await sessions.idle()
    expect(calls[0]!.options.systemPrompt).toMatchObject({ append: expect.stringContaining('当前工作区没有子工作项') })
    const parentId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId!
    db.insert(s.workItems).values({ id: 'work_child', parentId, title: '子工作项', workDir: '', createdBy: { kind: 'user' }, statusChangedAt: clock, createdAt: clock }).run()
    calls[0]!.push(result())
    calls[0]!.push('end')
    await until(() => turnOf(first.messageId).status === 'completed')
    send(sid, '处理子工作项报告')
    await sessions.idle()
    expect(calls[1]!.options.resume).toBe('claude-ses-1')
    expect(calls[1]!.options.systemPrompt).toMatchObject({ append: expect.stringContaining('子工作项的报告会通过持久工作消息自动唤醒你') })
    expect(calls[1]!.options.systemPrompt).toMatchObject({ append: expect.not.stringContaining('当前工作区没有子工作项') })
    expect(calls[1]!.prompt).toContain('有子工作项：是')
  })

  it('init means accepted; messages become transcript entries; the instance exits after normal completion and the next turn uses resume', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init('claude-ses-9'))
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('delivered')
    expect(instances(sid)).toEqual([expect.objectContaining({ status: 'ready', tokenHash: 'hash1' })])
    expect(turnOf(a.messageId).instanceId).toBe(instances(sid)[0]!.id)

    const q = calls[0]!
    q.push(assistant('u1', [{ type: 'text', text: '我先读一下画布' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'vis canvas get' } }]))
    q.push(toolResult('u2', 'tu1', '{"nodes":[]}'))
    q.push(assistant('u3', [{ type: 'text', text: '画布是空的' }]))
    q.push(result())
    q.push('end')
    await until(() => turnOf(a.messageId).status === 'completed')

    const items = sessions.getTranscript({ sessionId: sid }).items.filter(i => i.kind !== 'user')
    expect(items.map(i => [i.itemId, i.kind])).toEqual([
      ['u1:0', 'assistant_text'], ['u1:1', 'tool_call'], ['u2:0', 'tool_result'], ['u3:0', 'assistant_text'],
    ])
    expect(items[2]!.payload).toEqual({ toolUseId: 'tu1', isError: false, text: '{"nodes":[]}' })
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()).toMatchObject({ agentResumeId: 'claude-ses-9', providerLeafUuid: 'u3' })
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'completed' })

    nextQuery = q2 => q2.push(init('claude-ses-9'))
    send(sid, 'B')
    await sessions.idle()
    expect(calls[1]!.options.resume).toBe('claude-ses-9')
    expect(instances(sid).map(i => i.status)).toEqual(['exited', 'ready'])
  })

  it('keeps Read image paths across SDK messages within a turn and clears them for the next run', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const first = send(sid, 'Inspect the image')
    await sessions.idle()
    const imageResult = (uuid: string) => ({ type: 'user', uuid, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] } }) as unknown as SDKMessage
    calls[0]!.push(assistant('read-call', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/project/frame.png' } }]))
    calls[0]!.push(imageResult('image-result'))
    calls[0]!.push(result())
    calls[0]!.push('end')
    await until(() => turnOf(first.messageId).status === 'completed')
    expect(sessions.getTranscript({ sessionId: sid }).items.find(item => item.itemId === 'image-result:0')?.payload).toEqual({ toolUseId: 'read', isError: false, text: '[图片]', viewedImages: [{ path: '/project/frame.png' }] })
    const next = send(sid, 'Continue')
    await sessions.idle()
    calls[1]!.push(imageResult('unmatched-result'))
    calls[1]!.push(result())
    calls[1]!.push('end')
    await until(() => turnOf(next.messageId).status === 'completed')
    expect(sessions.getTranscript({ sessionId: sid }).items.find(item => item.itemId === 'unmatched-result:0')?.payload).not.toHaveProperty('viewedImages')
  })

  it('Insert a notice when context is compacted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, 'A')
    await sessions.idle()
    calls[0]!.push({ type: 'system', subtype: 'compact_boundary', uuid: 'c', session_id: 'x', compact_metadata: { trigger: 'auto', pre_tokens: 1 } } as unknown as SDKMessage)
    await until(() => notices(sid).includes('context_compacted'))
  })
})

describe('Failure and interruption', () => {
  it('Process failure before init: classify as rejected and exit the instance', async () => {
    const sid = newSession()
    nextQuery = q => q.push(new Error('spawn claude ENOENT'))
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('rejected')
    expect(notices(sid)).toEqual(['dispatch_rejected'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_failed' })
  })

  it('Timeout waiting for init: outcome unknown, no automatic resend', async () => {
    const sid = newSession()
    const a = send(sid, 'A')
    await sessions.idle()
    expect(message(a.messageId).deliveryState).toBe('unknown')
    expect(notices(sid)).toEqual(['dispatch_unknown'])
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'start_timeout' })
  })

  it('an interrupt between query creation and spawn still spawns and ends as interrupted', async () => {
    let child!: ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>>
    let spawnError: unknown
    nextQuery = q => {
      q.ignoreAbort = true
      q.options.abortController!.signal.addEventListener('abort', () => {
        try {
          const signal = new AbortController()
          child = q.options.spawnClaudeCodeProcess!({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: q.options.env!, signal: signal.signal })
          signal.abort()
        } catch (error) { spawnError = error }
        finally { q.push(new Error('interrupted startup')) }
      }, { once: true })
    }
    const sid = newSession()
    const sent = send(sid, 'Deferred spawn')
    await until(() => calls.length === 1)
    await sessions.stop({ requestId: 'stop-deferred-spawn', sessionId: sid, turnId: turnOf(sent.messageId).id })
    await sessions.idle()
    expect(spawnError).toBeUndefined()
    expect(child).toBeDefined()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(turnOf(sent.messageId).status).toBe('interrupted')
    expect(instances(sid)[0]!.exitReason).toBe('interrupted')
    expect(notices(sid)).not.toContain('dispatch_rejected')
  })

  it('User stop: interrupt this call and classify the turn as interrupted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const a = send(sid, 'A')
    await sessions.idle()
    await sessions.stop({ requestId: 'stop1', sessionId: sid, turnId: turnOf(a.messageId).id })
    expect(calls[0]!.interrupted).toBe(true)
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(instances(sid)[0]).toMatchObject({ status: 'exited', exitReason: 'interrupted' })
  })

  it.each(['dispose', 'interrupt'] as const)('%s while waiting for init aborts startup; late init cannot continue running', async action => {
    const sid = newSession()
    const a = send(sid, '启动期间删除')
    await until(() => calls.length === 1)
    if (action === 'dispose') {
      sessions.dispose()
      await runtime.dispose()
    } else await sessions.stop({ requestId: 'stop-starting', sessionId: sid, turnId: turnOf(a.messageId).id })
    await sessions.idle()
    expect(calls[0]!.options.abortController?.signal.aborted).toBe(true)
    expect(instances(sid)[0]?.status).toBe('exited')
    calls[0]!.push(init())
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(instances(sid)[0]?.status).toBe('exited')
    expect(db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()?.agentResumeId).toBeNull()
    if (action === 'dispose') await expect(runtime.ensureReady(sid)).rejects.toThrow('Runtime is closed')
  })

  it('Process exit mid-turn: classify as interrupted', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    const a = send(sid, 'A')
    await sessions.idle()
    calls[0]!.push(new Error('process exited with code 1'))
    await until(() => turnOf(a.messageId).status === 'interrupted')
    expect(message(a.messageId).deliveryState).toBe('delivered')
  })
})

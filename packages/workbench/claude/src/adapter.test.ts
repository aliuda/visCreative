import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from '@vis/workbench-core'
import { createClaudeRuntime, type ClaudeRuntimeOptions } from './adapter'

/** Controllable fake SDK call: tests push messages one by one or fail the process */
class FakeQuery {
  readonly queue: (SDKMessage | Error | 'end')[] = []
  private wake: (() => void) | undefined
  interrupted = false
  ignoreAbort = false
  constructor(readonly options: Options, readonly prompt: string) {
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
      close: () => {},
    }) as unknown as Query
  }
}

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
  sessions = createSessionService({ db, runtime: { ensureReady: id => runtime.ensureReady(id), dispatchTurn: i => runtime.dispatchTurn(i), terminateTurn: i => runtime.terminateTurn(i), interruptTurn: i => runtime.interruptTurn(i) }, now: () => ++clock })
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
  return sessions.create({ requestId: `r${++req}`, title: '分镜' }).sessionId
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
      PATH: ['/opt/vis/bin', '/usr/bin'].join(delimiter),
      HOME: homeDir,
      VIS_SOCKET: '/tmp/vis.sock',
      VIS_AGENT_TOKEN: 'spc_1.tok1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative',
    })
    expect(options.settingSources).toEqual([])
    expect(options.tools).toEqual(['Bash', 'Read', 'Glob', 'Grep'])
    expect(options.allowedTools).toEqual(['Bash(vis:*)', 'Read', 'Glob', 'Grep'])
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
      VIS_SOCKET: '/tmp/vis.sock',
      VIS_AGENT_TOKEN: 'spc_1.tok1',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative',
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
    expect(Object.keys(calls[0]!.options.env!).sort()).toEqual(['CLAUDE_AGENT_SDK_CLIENT_APP', 'HOME', 'PATH', 'VIS_AGENT_TOKEN', 'VIS_SOCKET'])
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
  it('Startup arguments: restrict tools, reject others, and inject token and socket', async () => {
    const sid = newSession()
    nextQuery = q => q.push(init())
    send(sid, '写一段旁白')
    await sessions.idle()
    const { options, prompt } = calls[0]!
    const workItemId = db.select().from(s.sessions).where(eq(s.sessions.id, sid)).get()!.workItemId
    expect(prompt).toBe(`写一段旁白\n\n<工作项>\n所属工作项：${workItemId}\n父工作项：无（根工作区）\n有子工作项：否\n</工作项>`)
    expect(options).toMatchObject({
      cwd: join(tmpdir(), 'vis-test-work', `${sid}`),
      tools: ['Bash', 'Read', 'Glob', 'Grep'],
      allowedTools: ['Bash(vis:*)', 'Read', 'Glob', 'Grep'],
      permissionMode: 'dontAsk',
      settingSources: [],
      env: { VIS_SOCKET: '/tmp/vis.sock', VIS_AGENT_TOKEN: 'spc_1.tok1', PATH: ['/opt/vis/bin', '/usr/bin'].join(delimiter), HOME: homeDir },
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

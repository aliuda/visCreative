import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, openSpaceDb, spaceSchema, type SpaceDb } from '@vis/storage'
import { createSessionService, type SessionService } from '@vis/workbench-core'
import { createClaudeRuntime, type ClaudeRuntimeOptions, type QueryFn } from './adapter'
import { claudeDescriptor } from './descriptor'

let root: string
let db: SpaceDb
let sessions: SessionService
let runtime: ReturnType<typeof createClaudeRuntime>
let options: ClaudeRuntimeOptions
let sdk: Options
let sequence = 0
const requestId = () => `claude-permission-${++sequence}`
const permission = () => ({ signal: new AbortController().signal, toolUseID: 'test-tool', requestId: 'permission-request' })
const forbiddenPaths = ['~/.codex', '~/.dsh', '~/.claude', '~/.claude.json', '~/.claude.json.*', '~/.minimax', '~/.codebuddy', '~/.codebuddy.json', '~/.codebuddy.json.*']
let launched: { command: string; args: string[]; env: Record<string, string | undefined> }[]

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vis-claude-sandbox-')))
  const cwd = join(root, 'project/work')
  const home = join(root, 'home')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(home)
  db = openSpaceDb(':memory:')
  launched = []
  const query: QueryFn = ({ options: current }) => {
    sdk = current!
    sdk.spawnClaudeCodeProcess!({ command: '/sdk/claude', args: ['--output-format', 'stream-json'], cwd, env: { ...sdk.env, GH_TOKEN: 'fake', VIS_AGENT_TOKEN: 'fake', NODE_OPTIONS: 'untrusted' }, signal: sdk.abortController!.signal })
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
      if (!sdk.abortController!.signal.aborted) await new Promise<void>(resolve => sdk.abortController!.signal.addEventListener('abort', () => resolve(), { once: true }))
    })(), { interrupt: async () => sdk.abortController!.abort(), supportedModels: async () => [{ value: 'default', displayName: 'Default', description: 'Test model' }], close: () => {} }) as ReturnType<QueryFn>
  }
  options = {
    query, workDir: () => cwd, socketPath: '/test/vis.sock', cliBinDir: '/test/bin', dataDir: join(root, 'data'),
    visMcp: { command: process.execPath, args: ['vis.mjs', 'mcp'] }, forbiddenPaths,
    env: { HOME: home, PATH: '/usr/bin', ANTHROPIC_AUTH_TOKEN: 'fake-auth', GH_TOKEN: 'fake', ARK_API_KEY: 'fake', VIS_AGENT_TOKEN: 'fake' },
    platform: 'darwin', sandboxAvailable: () => true,
    issueToken: () => ({ token: 'fake-vis-token', tokenHash: 'test-hash' }),
    spawn: (command, args, spawnOptions) => {
      launched.push({ command, args, env: spawnOptions.env })
      const events = new EventEmitter()
      const child = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null, signalCode: null, kill() { this.killed = true; events.emit('exit', null, 'SIGKILL'); return true } })
      return child as unknown as ReturnType<NonNullable<ClaudeRuntimeOptions['spawn']>>
    },
  }
  runtime = createClaudeRuntime({ db, report: event => sessions.handleAgentEvent(event), requestApproval: request => sessions.requestApproval(request) }, options)
  sessions = createSessionService({ db, runtime, rootPath: join(root, 'project') })
})

afterEach(async () => {
  sessions.dispose()
  await runtime.dispose()
  db.$client.close()
  rmSync(root, { recursive: true, force: true })
})

async function start(mode: 'ask' | 'auto' = 'ask') {
  const { sessionId } = sessions.create({ requestId: requestId(), agentKind: 'claude' })
  if (mode === 'auto') sessions.setApprovalMode({ requestId: requestId(), sessionId, mode })
  sessions.sendMessage({ requestId: requestId(), sessionId, text: 'Test', refs: [] })
  await sessions.idle()
  return sessionId
}
const approvals = (sessionId: string) => sessions.getTranscript({ sessionId }).items.filter(item => item.kind === 'approval')
const notices = (sessionId: string) => sessions.getTranscript({ sessionId }).items.filter(item => item.kind === 'notice')
const respond = (sessionId: string, decision: 'allow_once' | 'allow_session' | 'deny') => sessions.respondApproval({ requestId: requestId(), approvalId: approvals(sessionId).at(-1)!.itemId, decision })

it('launches the SDK binary through Seatbelt with native tools and keeps vis credentials only in MCP', async () => {
  await start()
  const child = launched[0]!
  expect(child.command).toBe('/usr/bin/sandbox-exec')
  expect(child.args.slice(0, 1)).toEqual(['-p'])
  expect(child.args.slice(2)).toEqual(['/sdk/claude', '--output-format', 'stream-json'])
  const policy = child.args[1]!
  const denied = policy.split('\n').find(line => line.startsWith('(deny file-read*'))!
  for (const path of ['.codex', '.dsh', '.minimax', '.codebuddy']) expect(denied).toContain(JSON.stringify(join(root, 'home', path)))
  for (const path of ['.claude', '.claude.json']) expect(denied).toContain(JSON.stringify(join(root, 'home', path)))
  expect(policy).toContain('(global-name "com.apple.securityd")')
  for (const path of ['data/run', 'data/providers.json', 'home/Library/Keychains']) expect(denied).toContain(JSON.stringify(join(root, path)))
  expect(denied).toContain('/app[.]db')
  expect(denied).toContain('/space[.]db')
  expect(policy.split('\n').at(-1)).toContain(JSON.stringify(join(root, 'data/agents/claude')))
  expect(policy.split('\n').at(-1)).not.toContain(JSON.stringify(join(root, 'home/.claude')))
  expect(child.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'data/agents/claude'))
  expect(sdk).toMatchObject({ permissionMode: 'default', sandbox: { enabled: false }, settingSources: [], strictMcpConfig: true })
  expect(sdk.disallowedTools).toEqual(['AskUserQuestion'])
  expect(sdk.settings).toMatchObject({ permissions: { ask: expect.arrayContaining(['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit']) } })
  expect(sdk.tools).toBeUndefined()
  expect(sdk.allowedTools).toBeUndefined()
  expect(claudeDescriptor.capabilities.approvals).toBe(true)
  expect(sdk.mcpServers).toEqual({ vis: { command: process.execPath, args: ['vis.mjs', 'mcp'], env: { VIS_SOCKET: '/test/vis.sock', VIS_AGENT_TOKEN: 'fake-vis-token' } } })
  for (const env of [sdk.env!, child.env]) {
    for (const key of ['VIS_AGENT_TOKEN', 'VIS_SOCKET', 'GH_TOKEN', 'ARK_API_KEY', 'NODE_OPTIONS']) expect(env).not.toHaveProperty(key)
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('fake-auth')
  }
})

it('forwards settings authentication through the sandbox spawn and gives settings precedence', async () => {
  const config = join(root, 'custom')
  mkdirSync(config)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fake-settings-auth', ANTHROPIC_BASE_URL: 'https://example.com', PATH: '/untrusted' } }))
  options.env!.CLAUDE_CONFIG_DIR = config
  await start()
  expect(launched[0]!.command).toBe('/usr/bin/sandbox-exec')
  expect(launched[0]!.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'fake-settings-auth', ANTHROPIC_BASE_URL: 'https://example.com', SSL_CERT_FILE: '/etc/ssl/cert.pem' })
  expect(launched[0]!.env.PATH).not.toContain('/untrusted')
  expect(sdk.settingSources).toEqual([])
})

it('auto-accepts vis MCP in sessions without a work item and asks for other MCP tools', async () => {
  const sessionId = await start()
  db.update(spaceSchema.sessions).set({ workItemId: null }).where(eq(spaceSchema.sessions.id, sessionId)).run()
  const input = { value: 'test' }
  await expect(sdk.canUseTool!('mcp__vis__canvas_get', input, permission())).resolves.toEqual({ behavior: 'allow', updatedInput: input })
  expect(approvals(sessionId)).toEqual([])
  const pending = sdk.canUseTool!('mcp__other__canvas_get', input, permission())
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ kind: 'other', status: 'pending' })
  respond(sessionId, 'deny')
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
})

it('auto mode records workspace commands, project writes and native web reads', async () => {
  const sessionId = await start('auto')
  for (const [tool, input] of [['Bash', { command: 'ls' }], ['Write', { file_path: join(root, 'project/new.txt'), content: 'test' }], ['Edit', { file_path: 'local.txt', old_string: 'a', new_string: 'b' }], ['NotebookEdit', { notebook_path: 'local.ipynb' }], ['WebFetch', { url: 'https://example.com' }], ['WebSearch', { query: 'test' }]] as const) {
    await expect(sdk.canUseTool!(tool, input, permission())).resolves.toMatchObject({ behavior: 'allow' })
  }
  expect(approvals(sessionId)).toHaveLength(6)
  for (const entry of approvals(sessionId)) expect(entry.payload).toMatchObject({ status: 'approved', auto: true })
})

it.each(['outside write', 'symlink write', 'symlink parent write', 'missing path', 'other tool', 'blocked command'] as const)('auto mode asks for %s and delivers the denial to Claude', async kind => {
  const sessionId = await start('auto')
  symlinkSync(join(root, 'home'), join(root, 'project/alias'), 'junction')
  const [tool, input] = kind === 'outside write' ? ['Write', { file_path: join(root, 'home/new.txt') }]
    : kind === 'symlink write' ? ['Edit', { file_path: join(root, 'project/alias/new.txt') }]
    : kind === 'symlink parent write' ? ['Write', { file_path: `${join(root, 'project/alias')}/../new.txt` }]
    : kind === 'missing path' ? ['Write', { content: 'test' }]
    : kind === 'blocked command' ? ['Bash', { command: 'ls' }]
    : ['Task', { prompt: 'test' }]
  const pending = sdk.canUseTool!(tool as string, input as Record<string, unknown>, { ...permission(), ...(kind === 'blocked command' ? { blockedPath: join(root, 'home') } : {}) })
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ status: 'pending' })
  respond(sessionId, 'deny')
  await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: expect.any(String) })
})

it('ask mode approves a command only after the shared card is answered', async () => {
  const sessionId = await start()
  const pending = sdk.canUseTool!('Bash', { command: 'git status' }, permission())
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ kind: 'command', summary: 'git status', status: 'pending' })
  respond(sessionId, 'allow_once')
  await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
})

it('session approvals reuse the exact command string and ask for a different command', async () => {
  const sessionId = await start()
  const pending = sdk.canUseTool!('Bash', { command: 'ls' }, permission())
  respond(sessionId, 'allow_session')
  await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
  await expect(sdk.canUseTool!('Bash', { command: 'ls' }, permission())).resolves.toMatchObject({ behavior: 'allow' })
  expect(approvals(sessionId)).toHaveLength(1)
  const expanded = sdk.canUseTool!('Bash', { command: 'git status' }, permission())
  expect(approvals(sessionId)).toHaveLength(2)
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ status: 'pending' })
  respond(sessionId, 'deny')
  await expect(expanded).resolves.toMatchObject({ behavior: 'deny' })
})

it('does not expose authentication or MCP credentials from SDK startup errors', async () => {
  options.query = () => { throw new Error('fake-auth and fake-vis-token in SDK arguments') }
  const sessionId = await start()
  const payloads = JSON.stringify(notices(sessionId))
  expect(payloads).toContain('Cannot start Claude: [redacted] and [redacted] in SDK arguments')
  expect(payloads).not.toContain('fake-auth')
  expect(payloads).not.toContain('fake-vis-token')
})

it('denies aborted requests and callbacks after the turn has stopped', async () => {
  const sessionId = await start()
  const controller = new AbortController()
  controller.abort()
  await expect(sdk.canUseTool!('Bash', { command: 'ls' }, { ...permission(), signal: controller.signal })).resolves.toMatchObject({ behavior: 'deny' })
  expect(approvals(sessionId)).toEqual([])
  await runtime.terminateTurn({ sessionId, turnId: sessions.list({}).sessions[0]!.activeTurnId! })
  await expect(sdk.canUseTool!('mcp__vis__canvas_get', {}, permission())).resolves.toMatchObject({ behavior: 'deny' })
})

describe('Platform and authentication fallbacks', () => {
  it('Windows settings authentication overrides exports with different key casing during catalog launch', async () => {
    options.platform = 'win32'
    delete options.env!.ANTHROPIC_AUTH_TOKEN
    options.env!.anthropic_auth_token = 'fake-export'
    mkdirSync(join(root, 'home/.claude'))
    writeFileSync(join(root, 'home/.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fake-settings' } }))
    await runtime.agentOptions('claude', {})
    expect(launched[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe('fake-settings')
    expect(launched[0]!.env).not.toHaveProperty('anthropic_auth_token')
    expect(options.env!.anthropic_auth_token).toBe('fake-export')
  })

  it.each(['sandbox', 'Keychain fallback', 'Windows'] as const)('catalog probes share the %s launch path and keep their transport credentials isolated', async mode => {
    if (mode !== 'sandbox') delete options.env!.ANTHROPIC_AUTH_TOKEN
    if (mode === 'Windows') options.platform = 'win32'
    await expect(runtime.agentOptions('claude', {})).resolves.toMatchObject([{ id: 'default' }])
    expect(launched[0]!.command).toBe(mode === 'sandbox' ? '/usr/bin/sandbox-exec' : '/sdk/claude')
    for (const key of ['VIS_AGENT_TOKEN', 'VIS_SOCKET', 'GH_TOKEN', 'ARK_API_KEY', 'NODE_OPTIONS']) expect(launched[0]!.env).not.toHaveProperty(key)
    expect(sdk.settingSources).toEqual([])
    expect(sdk.persistSession).toBe(false)
    expect(sdk.mcpServers).toBeUndefined()
    expect(existsSync(sdk.cwd!)).toBe(false)
    expect(db.select().from(spaceSchema.agentInstances).all()).toEqual([])
    if (mode === 'Keychain fallback') expect(sdk.permissionMode).toBe('dontAsk')
    else await expect(sdk.canUseTool!('Bash', { command: 'ls' }, permission())).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('Windows uses full tools and approvals without requiring environment authentication or claiming isolation', async () => {
    options.platform = 'win32'
    delete options.env!.ANTHROPIC_AUTH_TOKEN
    const sessionId = await start('auto')
    expect(launched[0]!.command).toBe('/sdk/claude')
    expect(sdk.tools).toBeUndefined()
    expect(sdk.permissionMode).toBe('default')
    const pending = sdk.canUseTool!('Bash', { command: 'ls', cwd: options.workDir(sessionId) }, permission())
    expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ status: 'pending' })
    respond(sessionId, 'allow_once')
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
    expect(sdk.env!.CLAUDE_CONFIG_DIR).toBe(join(root, 'data/agents/claude'))
    expect(notices(sessionId)).toEqual([])
  })

  it.each(['sandbox-exec', 'certificates', 'environment auth'] as const)('macOS preserves restricted tools and emits a notice without %s', async missing => {
    if (missing === 'environment auth') delete options.env!.ANTHROPIC_AUTH_TOKEN
    else options.sandboxAvailable = path => path !== (missing === 'sandbox-exec' ? '/usr/bin/sandbox-exec' : '/etc/ssl/cert.pem')
    const sessionId = await start()
    expect(launched[0]!.command).toBe('/sdk/claude')
    expect(sdk).toMatchObject({ permissionMode: 'dontAsk', tools: ['Read', 'Glob', 'Grep'], allowedTools: ['mcp__vis__*', 'Read', 'Glob', 'Grep'] })
    expect(sdk.canUseTool).toBeUndefined()
    expect(sdk.env!.CLAUDE_CONFIG_DIR).toBe(join(root, 'home/.claude'))
    expect(sdk.disallowedTools).toEqual(['AskUserQuestion'])
    expect(notices(sessionId).at(-1)!.payload).toMatchObject({ code: 'sandbox_read_only' })
    if (missing === 'environment auth') expect(notices(sessionId).at(-1)!.payload).toMatchObject({ message: expect.stringContaining('CLAUDE_CODE_OAUTH_TOKEN') })
  })

  it('an empty settings credential overrides an exported token and selects Keychain fallback', async () => {
    mkdirSync(join(root, 'home/.claude'))
    writeFileSync(join(root, 'home/.claude/settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: '' } }))
    await start()
    expect(launched[0]!.command).toBe('/sdk/claude')
    expect(launched[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(sdk.permissionMode).toBe('dontAsk')
  })

  it.each(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'])('%s supports the sandboxed authentication path', async key => {
    delete options.env!.ANTHROPIC_AUTH_TOKEN
    options.env![key] = key.startsWith('CLAUDE_CODE_USE_') ? '1' : 'fake-auth'
    await start()
    expect(launched[0]!.command).toBe('/usr/bin/sandbox-exec')
    expect(sdk.permissionMode).toBe('default')
  })
})

it('isolates native configuration while importing only authentication and connection settings from the user directory', async () => {
  const config = join(root, 'user-config')
  mkdirSync(config)
  const forwarded = {
    AWS_ACCESS_KEY_ID: 'fake-access', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session', AWS_BEARER_TOKEN_BEDROCK: 'fake-bearer',
    GOOGLE_APPLICATION_CREDENTIALS: join(root, 'fake-adc.json'), HTTPS_PROXY: 'https://proxy.example.com', HTTP_PROXY: 'http://proxy.example.com', NO_PROXY: 'example.com',
    https_proxy: 'https://lower-proxy.example.com', http_proxy: 'http://lower-proxy.example.com', no_proxy: 'localhost', NODE_EXTRA_CA_CERTS: join(root, 'fake-ca.pem'),
  }
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { ...forwarded, GH_TOKEN: 'not-forwarded' }, hooks: { SessionStart: ['not-loaded'] }, mcpServers: { unsafe: {} } }))
  options.env!.CLAUDE_CONFIG_DIR = config
  for (const key of Object.keys(forwarded)) options.env![key] = 'fake-export'
  await start()
  expect(launched[0]!.env).toMatchObject({ ...forwarded, CLAUDE_CONFIG_DIR: join(root, 'data/agents/claude') })
  expect(launched[0]!.env).not.toHaveProperty('GH_TOKEN')
  expect(launched[0]!.args[1]).toContain(JSON.stringify(config))
  expect(options.env!.CLAUDE_CONFIG_DIR).toBe(config)
  expect(sdk.settingSources).toEqual([])
  expect(sdk).not.toHaveProperty('hooks')
})

it('restores a custom user configuration explicitly when sandboxing is unavailable', async () => {
  const config = join(root, 'custom-config')
  mkdirSync(config)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'fake-custom' } }))
  options.env!.CLAUDE_CONFIG_DIR = config
  options.sandboxAvailable = () => false
  await start()
  expect(launched[0]!.command).toBe('/sdk/claude')
  expect(launched[0]!.env.CLAUDE_CONFIG_DIR).toBe(config)
  expect(launched[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe('fake-custom')
  expect(sdk.tools).toEqual(['Read', 'Glob', 'Grep'])
  expect(sdk.allowedTools).toEqual(['mcp__vis__*', 'Read', 'Glob', 'Grep'])
  expect(sdk.disallowedTools).toContain('AskUserQuestion')
})

it('passes the project directory to Claude and allows sandboxed reads without approval cards', async () => {
  const sessionId = await start()
  expect(sdk.additionalDirectories).toEqual([join(root, 'project')])
  for (const [tool, input] of [['Read', { file_path: join(root, 'home/.claude/settings.json') }], ['Glob', { path: join(root, 'home'), pattern: '**/*' }], ['Grep', { path: join(root, 'home'), pattern: 'test' }]] as const) {
    await expect(sdk.canUseTool!(tool, input, permission())).resolves.toMatchObject({ behavior: 'allow' })
  }
  expect(approvals(sessionId)).toEqual([])
})

it.each(['Read', 'Glob', 'Grep'] as const)('Windows %s reads allow workspace/project targets and ask for canonical outside paths', async tool => {
  options.platform = 'win32'
  const sessionId = await start('auto')
  const key = tool === 'Read' ? 'file_path' : 'path'
  for (const path of [join(root, 'project/work/inside'), join(root, 'project/shared')]) {
    await expect(sdk.canUseTool!(tool, { [key]: path, pattern: '**/*' }, permission())).resolves.toMatchObject({ behavior: 'allow' })
  }
  expect(approvals(sessionId)).toEqual([])
  symlinkSync(join(root, 'home'), join(root, 'project/alias'), 'junction')
  const pending = sdk.canUseTool!(tool, { [key]: `${join(root, 'project/alias')}/../outside`, pattern: '**/*' }, permission())
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ kind: 'other', status: 'pending' })
  respond(sessionId, 'deny')
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
})

it('uses Seatbelt rather than an untrusted Bash cwd field to bound automatic command approval', async () => {
  const sessionId = await start('auto')
  await expect(sdk.canUseTool!('Bash', { command: 'ls', cwd: join(root, 'home') }, permission())).resolves.toMatchObject({ behavior: 'allow' })
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ detail: 'ls', cwd: options.workDir(sessionId), auto: true })
})

it('records only canonical file paths and reuses a file session grant without recording contents', async () => {
  const sessionId = await start()
  const target = join(root, 'project/work/file.txt')
  writeFileSync(target, 'original')
  symlinkSync(target, join(root, 'project/work/alias.txt'))
  const pending = sdk.canUseTool!('Write', { file_path: 'alias.txt', content: 'private-new-file-content' }, permission())
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ detail: target, kind: 'file_write', status: 'pending' })
  respond(sessionId, 'allow_session')
  await expect(pending).resolves.toMatchObject({ behavior: 'allow' })
  await expect(sdk.canUseTool!('Edit', { file_path: target, old_string: 'private-old-content', new_string: 'private-edited-content' }, permission())).resolves.toMatchObject({ behavior: 'allow' })
  expect(approvals(sessionId)).toHaveLength(1)
  const recorded = JSON.stringify(approvals(sessionId))
  for (const text of ['private-new-file-content', 'private-old-content', 'private-edited-content']) expect(recorded).not.toContain(text)
})

it.each(['sandbox setup', 'query initialization'])('scrubs secrets and proxy credentials during %s while preserving diagnostic environment values', async stage => {
  const secrets = Object.fromEntries(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS'].map(key => [key, `fake-${key.toLowerCase()}-"\\?`]))
  const proxies = { HTTPS_PROXY: 'https://proxy-user:proxy-pass@proxy.example.com', http_proxy: 'http://lower-user:lower-pass@lower-proxy.example.com' }
  Object.assign(options.env!, secrets, proxies, {
    LANG: 'en_US.UTF-8', CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'fake-access-id',
    ANTHROPIC_BASE_URL: 'https://api.example.com', HTTP_PROXY: 'http://public-proxy.example.com', NO_PROXY: 'localhost',
    GOOGLE_APPLICATION_CREDENTIALS: join(root, 'fake-adc.json'), NODE_EXTRA_CA_CERTS: join(root, 'fake-ca.pem'),
  })
  options.issueToken = () => ({ token: 'fake-agent-token-"\\?', tokenHash: 'test-hash' })
  const variants = (value: string) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]
  const confidential = [...Object.values(secrets), options.issueToken().token, 'proxy-user:proxy-pass@', 'lower-user:lower-pass@']
  const homePath = join(options.env!.HOME!, 'workspace/file.ts')
  const diagnostic = `SDK exited with code 1 at ${homePath}; PATH=/usr/bin; LANG=en_US.UTF-8; flag=1; access=fake-access-id; base=https://api.example.com; socket=${options.socketPath}; adc=${options.env!.GOOGLE_APPLICATION_CREDENTIALS}; ca=${options.env!.NODE_EXTRA_CA_CERTS}`
  const message = `${diagnostic}; credentials: ${[...Object.values(secrets), options.issueToken().token, ...Object.values(proxies)].flatMap(variants).join(' | ')}`
  if (stage === 'sandbox setup') options.sandboxAvailable = () => { throw new Error(message) }
  options.query = ({ options: queryOptions }) => {
    expect(queryOptions!.env).toMatchObject({ ...secrets, ...proxies })
    throw new Error(message)
  }
  const sessionId = await start()
  const recorded = notices(sessionId).map(item => (item.payload as { message: string }).message).join('\n')
  expect(recorded).toContain(diagnostic)
  expect(recorded).toContain('[redacted]')
  expect(recorded).toContain('proxy.example.com')
  expect(recorded).toContain('lower-proxy.example.com')
  for (const value of confidential.flatMap(variants)) expect(recorded).not.toContain(value)
})

it('scrubs abnormal post-init errors and preserves the message outside credential values', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  options.env!.CLAUDE_CODE_USE_BEDROCK = '1'
  const homePath = join(options.env!.HOME!, 'workspace/file.ts')
  options.query = ({ options: current }) => Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
    throw new Error(`Network failed for ${current!.env!.ANTHROPIC_AUTH_TOKEN} and ${options.issueToken().token}; exited with code 1 at ${homePath}`)
  })(), {}) as ReturnType<QueryFn>
  try {
    await start()
    await expect.poll(() => logged.mock.calls.length).toBe(1)
    const output = JSON.stringify(logged.mock.calls)
    expect(output).toContain('Network failed for [redacted] and [redacted]')
    expect(output).toContain(`exited with code 1 at ${homePath}`)
    expect(output).not.toContain('fake-auth')
    expect(output).not.toContain(options.issueToken().token)
  } finally { logged.mockRestore() }
})

it('treats a legacy resume failure normally without switching back to the user configuration', async () => {
  const seen: Options[] = []
  options.query = ({ options: current }) => { seen.push(current!); throw new Error('No conversation found with this session ID') }
  const session = sessions.create({ requestId: requestId(), agentKind: 'claude' })
  await expect(runtime.dispatchTurn({ sessionId: session.sessionId, sessionTitle: 'Test', titleSource: 'user', turnId: 'legacy-turn', text: 'Resume', refs: [], inputSnapshotId: 'snapshot', resumeId: 'legacy-resume' })).rejects.toThrow('No conversation found with this session ID')
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ resume: 'legacy-resume', env: { CLAUDE_CONFIG_DIR: join(root, 'data/agents/claude') } })
})

it('always protects the real Claude configuration even when an injected forbidden-path list is empty', async () => {
  options.forbiddenPaths = []
  await start()
  const denied = launched[0]!.args[1]!.split('\n').find(line => line.startsWith('(deny file-read*'))!
  for (const path of ['.claude', '.claude.json']) expect(denied).toContain(JSON.stringify(join(root, 'home', path)))
  expect(denied).toContain('/[.]claude[.]json[.][^/]*$')
})

it('Windows resolves a tilde read against the real home before deciding workspace access', async () => {
  options.platform = 'win32'
  const sessionId = await start('auto')
  const pending = sdk.canUseTool!('Read', { file_path: '~/.claude/settings.json' }, permission())
  expect(approvals(sessionId).at(-1)!.payload).toMatchObject({ status: 'pending', detail: join(root, 'home/.claude/settings.json') })
  respond(sessionId, 'deny')
  await expect(pending).resolves.toMatchObject({ behavior: 'deny' })
})

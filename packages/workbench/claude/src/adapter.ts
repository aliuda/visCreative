import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import type { EffortLevel, ModelInfo, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SpaceDb } from '@vis/storage'
import { AgentModelOption } from '@vis/protocol'
import { VisError } from '@vis/domain'
import { agentPath, type AgentEvent, type AgentRuntimePort, type ApprovalRequest, type ChildLike, DispatchError, exitInstance, killTree, markInstanceReady, nodeChildEnv, prepareSandbox, type RequestApproval, spawnAgentProcess, startTurnInstance } from '@vis/workbench-core'
import { buildPrompt, systemAppend } from './prompt'
import { translate } from './translate'
import { claudeSandbox } from './descriptor'
import { canonicalToolPath, insideDirectories } from './paths'

/** Restricted fallback when outer isolation is unavailable. */
export const TOOLS = ['Read', 'Glob', 'Grep']
export const ALLOWED_TOOLS = ['mcp__vis__*', 'Read', 'Glob', 'Grep']

// Claude also needs these explicit keys for OAuth and cloud-provider authentication.
const CLAUDE_AUTH_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_REGION',
  'AWS_PROFILE',
  'CLOUD_ML_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
])
const CONNECTION_ENV_KEYS = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'])
const SECRET_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS'])

export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query

const EFFORT_LEVELS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])
const isEffort = (value: unknown): value is EffortLevel => typeof value === 'string' && EFFORT_LEVELS.has(value)
const isAuthEnv = (key: string) => /^ANTHROPIC_/.test(key) || CLAUDE_AUTH_ENV_KEYS.has(key)
const isForwardedEnv = (key: string) => isAuthEnv(key) || CONNECTION_ENV_KEYS.has(key)
const catalogError = () => VisError.of('unavailable', 'session.models_unavailable', { detail: 'Claude model catalog is unavailable' }, 'Cannot read the Claude model catalog')

function authHash(env: Record<string, string | undefined>): string {
  const auth = Object.entries(env).filter(([key]) => isForwardedEnv(key)).sort(([left], [right]) => left.localeCompare(right))
  return createHash('sha256').update(JSON.stringify(auth)).digest('hex')
}

function modelOptions(models: ModelInfo[], configured?: string): AgentModelOption[] {
  if (!Array.isArray(models) || models.length === 0) throw new Error('Invalid Claude model catalog')
  const selected = models.find(model => model.value === (configured ?? 'default'))
    ?? (configured ? models.find(model => model.resolvedModel === configured) : undefined)
  const options = models.map(model => AgentModelOption.parse({
    id: model.value, label: model.displayName, description: model.description,
    isDefault: model === selected,
    efforts: model.supportsEffort === true ? (model.supportedEffortLevels ?? []).filter(isEffort).map(id => ({ id, label: id })) : [],
    defaultEffort: null, serviceTiers: [],
  }))
  if (configured && !selected) {
    options.push({ id: configured, label: configured, isDefault: true, efforts: [], defaultEffort: null, serviceTiers: [] })
  }
  return options
}

// Keep streaming input open for control requests without ever submitting a model prompt.
async function* catalogInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (!signal.aborted) await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }) })
}

export type ClaudeRuntimeOptions = {
  query: QueryFn
  spawn?: typeof spawnAgentProcess
  dataDir?: string
  forbiddenPaths?: readonly string[]
  visMcp: { command: string; args: string[] }
  sandboxAvailable?: (path: string) => boolean
  /** Session working directory. Claude stores transcripts by cwd, so resume must use the same directory */
  workDir(sessionId: string): string
  /** Issue a runtime token; store only its hash in the database */
  issueToken(): { token: string; tokenHash: string }
  socketPath: string
  /** Directory containing the vis executable, prepended to the Agent process PATH */
  cliBinDir: string
  /** Packaged tools appended after the user PATH. */
  fallbackDirs?: readonly string[]
  model?: string
  /** Maximum wait from startup to receiving init */
  initTimeoutMs?: number
  /** Maximum wait for fresh authentication and catalog initialization; defaults to 15 seconds */
  catalogTimeoutMs?: number
  /** Grace period for Agent cleanup after interruption; abort immediately on timeout */
  interruptGraceMs?: number
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  now?: () => number
}

function userHome(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  return env.HOME ?? (platform === 'win32' ? env.USERPROFILE : undefined) ?? homedir()
}

function userConfigDir(env: Record<string, string | undefined>, platform: NodeJS.Platform): string {
  const home = userHome(env, platform)
  const configured = env.CLAUDE_CONFIG_DIR
  return !configured ? join(home, '.claude') : configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured
}

async function settingsEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform, signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const configDir = userConfigDir(env, platform)
    const settings: unknown = JSON.parse(await readFile(join(configDir, 'settings.json'), { encoding: 'utf8', ...(signal ? { signal } : {}) }))
    if (!settings || typeof settings !== 'object' || !('env' in settings)) return {}
    const values = settings.env
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(values)) {
      if (isForwardedEnv(key) && typeof value === 'string') result[key] = value
    }
    return result
  } catch {
    // Settings are optional; parse and filesystem errors may contain credentials.
    return {}
  }
}

type Run = {
  sessionId: string
  turnId: string
  instanceId: string
  q: Query
  abort: AbortController
  interrupted: boolean
  done: Promise<void>
  scrub(error: unknown): string
}

/**
 * One SDK call per turn, restoring context with resume; the process exits when the turn ends.
 * Receiving init means the Agent has accepted the turn; all subsequent endings are reported through turn_ended.
 */
export function createClaudeRuntime(
  ctx: { db: SpaceDb; report: (event: AgentEvent) => void; requestApproval?: RequestApproval },
  opts: ClaudeRuntimeOptions,
): AgentRuntimePort & { agentOptions: NonNullable<AgentRuntimePort['agentOptions']>; dispose(): Promise<void> } {
  const { db, report } = ctx
  const now = opts.now ?? Date.now
  const spawn = opts.spawn ?? spawnAgentProcess
  const runs = new Map<string, Run>()
  const starting = new Map<string, { turnId: string; instanceId: string; abort: AbortController; done: Promise<void> }>()
  const consumers = new Set<Run>()
  const startups = new Set<{ abort: AbortController; done: Promise<void> }>()
  const processes = new Map<string | symbol, { child: ChildLike; exited: Promise<void> }>()
  const catalogs = new Map<string, AgentModelOption[]>()
  const catalogPending = new Map<string, Promise<AgentModelOption[]>>()
  const catalogControllers = new Set<AbortController>()
  let disposed = false

  const exit = (instanceId: string, reason: string) => exitInstance(db, instanceId, reason, now())

  async function stopProcess(id: string | symbol) {
    const process = processes.get(id)
    if (!process) return
    await killTree(process.child, 'SIGKILL')
    await process.exited
    if (processes.get(id) === process) processes.delete(id)
  }

  async function queryEnv(signal?: AbortSignal): Promise<Record<string, string | undefined>> {
    const env = { ...(opts.env ?? process.env) }
    const platform = opts.platform ?? process.platform
    // Windows environment keys are case-insensitive; avoid passing both Path and PATH to child processes.
    if (platform === 'win32') {
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
      const path = pathKey ? env[pathKey] : undefined
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
      if (path !== undefined) env.PATH = path
      for (const [key, value] of Object.entries(env)) {
        const canonical = key.toUpperCase()
        if (key !== canonical && isForwardedEnv(canonical)) {
          delete env[key]
          if (!Object.hasOwn(env, canonical)) env[canonical] = value
        }
      }
    }
    const settings = await settingsEnv(env, platform, signal)
    if (platform === 'win32') {
      for (const [key, value] of Object.entries(settings)) {
        for (const exported of Object.keys(env)) if (exported.toLowerCase() === key.toLowerCase()) delete env[exported]
        env[key.toUpperCase()] = value
      }
      return env
    }
    return { ...env, ...settings }
  }

  function queryOptions(abort: AbortController, id: string | symbol, token: string, env: Record<string, string | undefined>, cwd: string): { options: Options; expanded: boolean; isolated: boolean; notice: string | undefined; scrub(error: unknown): string } {
    if (abort.signal.aborted || disposed) throw new Error('Runtime has stopped')
    const platform = opts.platform ?? process.platform
    const userConfig = userConfigDir(env, platform)
    const agent = { ...claudeSandbox, envPassthrough: Object.keys(env).filter(isForwardedEnv), forbiddenPaths: [...new Set([...claudeSandbox.forbiddenPaths, ...(opts.forbiddenPaths ?? []), userConfig])] }
    const hasAuth = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].some(key => env[key]?.trim()) || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some(key => env[key] === '1' || env[key] === 'true')
    // Keychain OAuth cannot reach securityd in Seatbelt; retain the restricted login path for turns and catalog probes.
    const needsEnvAuth = platform === 'darwin' && !hasAuth
    const available = needsEnvAuth ? () => false : opts.sandboxAvailable
    const { dataRuntimeDirectory, ...restrictedAgent } = agent
    const configDir = !needsEnvAuth && opts.dataDir ? join(opts.dataDir, dataRuntimeDirectory) : userConfig
    const sandbox = prepareSandbox({ cwd, agent: needsEnvAuth ? restrictedAgent : agent, ...(opts.dataDir ? { dataDir: opts.dataDir } : {}), env: { ...env, CLAUDE_CONFIG_DIR: configDir }, platform, ...(available ? { available } : {}) })
    const notice = needsEnvAuth ? 'Claude full tools require authentication in settings env or CLAUDE_CODE_OAUTH_TOKEN; using restricted tools for Keychain login.' : sandbox.notice
    const expanded = Boolean(sandbox.policy) || (platform === 'win32' && !notice)
    const runtimeEnv = { ...sandbox.env, ...(!expanded ? { CLAUDE_CONFIG_DIR: userConfig } : {}), PATH: agentPath({ cliBinDir: opts.cliBinDir, fallbackDirs: opts.fallbackDirs, base: sandbox.env.PATH }), CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_CLIENT_APP: 'vis-creative' }
    const scrub = (error: unknown) => errorMessage(error, runtimeEnv, token)
    return { expanded, isolated: Boolean(sandbox.policy), notice, scrub, options: {
      cwd,
      abortController: abort,
      spawnClaudeCodeProcess: options => {
        if (typeof id === 'symbol' && (abort.signal.aborted || options.signal.aborted || disposed)) throw new Error('Runtime has stopped')
        // Use the filtered turn environment even if the SDK supplies additional host variables.
        const child = sandbox.policy
          ? spawn('/usr/bin/sandbox-exec', ['-p', sandbox.policy, options.command, ...options.args], { cwd, env: runtimeEnv })
          : spawn(options.command, options.args, { cwd, env: runtimeEnv })
        const process = { child, exited: new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => { if (child.pid === undefined) resolve() }) }) }
        processes.set(id, process)
        options.signal.addEventListener('abort', () => { void killTree(child, 'SIGKILL') }, { once: true })
        if (options.signal.aborted) void killTree(child, 'SIGKILL')
        child.stderr.resume()
        // SDK shutdown first allows stdin cleanup, then calls kill. Keep that final action tree-wide.
        return {
          stdin: child.stdin, stdout: child.stdout,
          get killed() { return child.killed },
          get exitCode() { return child.exitCode },
          get signalCode() { return child.signalCode },
          kill() { void killTree(child, 'SIGKILL'); return true },
          on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child),
        }
      },
      ...(expanded ? { permissionMode: 'default', canUseTool: async () => ({ behavior: 'deny', message: 'Catalog probes cannot run tools.' }) } : { tools: TOOLS, allowedTools: ALLOWED_TOOLS, permissionMode: 'dontAsk' }),
      // Native safe-command and read shortcuts must still pass through the host's workspace checks.
      ...(expanded ? { settings: { permissions: { ask: ['Bash', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'] } } } : {}),
      sandbox: { enabled: false },
      disallowedTools: ['AskUserQuestion'],
      settingSources: [],
      strictMcpConfig: true,
      // A catalog probe has no active turn, so its deliberately unusable token must not start a vis connection.
      ...(typeof id === 'symbol' ? {} : { mcpServers: { vis: { ...opts.visMcp, env: { ...nodeChildEnv(opts.visMcp.command), VIS_SOCKET: opts.socketPath, VIS_AGENT_TOKEN: token } } } }),
      env: runtimeEnv,
    } }
  }

  function turnPermissions(input: Parameters<AgentRuntimePort['dispatchTurn']>[0], cwd: string, isolated: boolean, abort: AbortController): NonNullable<Options['canUseTool']> {
    const active = () => !disposed && !abort.signal.aborted && (starting.get(input.sessionId)?.turnId === input.turnId || runs.get(input.sessionId)?.turnId === input.turnId)
    const home = userHome(opts.env ?? process.env, opts.platform ?? process.platform)
    // Preserve link/.. segments until canonical checks have followed the symlink.
    const toolPath = (path: string) => path === '~' ? home : /^~[/\\]/.test(path) ? `${home}${sep}${path.slice(2)}` : isAbsolute(path) ? path : `${cwd}${sep}${path}`
    const roots = [cwd, ...(input.projectContext ? [input.projectContext.rootPath] : [])]
    return async (toolName, toolInput, permission) => {
      const deny = () => ({ behavior: 'deny' as const, message: 'The author did not approve this tool call.' })
      if (!active() || permission.signal.aborted) return deny()
      if (/^mcp__vis__[A-Za-z0-9_-]+$/.test(toolName)) return { behavior: 'allow', updatedInput: toolInput }
      let kind: ApprovalRequest['kind'] = 'other'
      let detail = toolName
      let evidence: Pick<ApprovalRequest, 'cwd' | 'paths' | 'webRead' | 'autoApprovalBlocked'> = {}
      if (['Read', 'Glob', 'Grep'].includes(toolName)) {
        if (isolated) return { behavior: 'allow', updatedInput: toolInput }
        let path = toolName === 'Read' ? toolInput.file_path : toolInput.path ?? cwd
        let complete = typeof path === 'string' && Boolean(path)
        if (toolName === 'Glob' && typeof toolInput.pattern === 'string') {
          const pattern = toolInput.pattern
          if (pattern.includes('..') || /[{}()]/.test(pattern)) complete = false
          else if (isAbsolute(pattern)) path = pattern.split(/[?*[]/, 1)[0] || pattern
        }
        const absolute = typeof path === 'string' ? toolPath(path) : undefined
        const targets = [...(absolute ? [absolute] : []), ...(permission.blockedPath ? [toolPath(permission.blockedPath)] : [])]
        if (complete && targets.length && targets.every(target => insideDirectories(target, roots, opts.platform ?? process.platform))) return { behavior: 'allow', updatedInput: toolInput }
        detail = absolute ? canonicalToolPath(absolute) ?? absolute : 'Read path unavailable'
      } else if (toolName === 'Bash') {
        kind = 'command'
        detail = typeof toolInput.command === 'string' ? toolInput.command : 'Command unavailable'
        // Claude cannot report the shell's real cwd. Only Seatbelt makes workspace auto approval bounded.
        evidence = { cwd, autoApprovalBlocked: !isolated || Boolean(permission.blockedPath) || toolInput.dangerouslyDisableSandbox === true }
      } else if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
        kind = 'file_write'
        evidence.cwd = cwd
        const path = toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path
        const absolute = typeof path === 'string' && path ? toolPath(path) : undefined
        const canonical = absolute ? canonicalToolPath(absolute) : undefined
        detail = canonical ?? absolute ?? 'File path unavailable'
        if (absolute) evidence.paths = [absolute]
        if (!canonical) evidence.autoApprovalBlocked = true
        if (permission.blockedPath) evidence.paths = [...(evidence.paths ?? []), toolPath(permission.blockedPath)]
      } else if (toolName === 'WebFetch' || toolName === 'WebSearch') {
        kind = 'network'
        evidence.webRead = true
        detail = typeof toolInput.url === 'string' ? toolInput.url : typeof toolInput.query === 'string' ? toolInput.query : toolName
      }
      if (!ctx.requestApproval) return deny()
      try {
        const summary = toolName === 'Bash' ? detail : `${toolName}: ${detail}`
        const decision = await ctx.requestApproval({ sessionId: input.sessionId, turnId: input.turnId, kind, summary, detail, ...evidence })
        return decision !== 'deny' && active() && !permission.signal.aborted ? { behavior: 'allow', updatedInput: toolInput } : deny()
      } catch { return deny() }
    }
  }

  async function readCatalog(env: Record<string, string | undefined>, abort: AbortController): Promise<AgentModelOption[]> {
    const id = Symbol('catalog')
    let q: Query | undefined
    let cwd: string | undefined
    const cancelled = new Promise<never>((_, reject) => { abort.signal.addEventListener('abort', () => reject(new Error('Claude catalog read stopped')), { once: true }) })
    try {
      const read = async () => {
        cwd = mkdtempSync(join(tmpdir(), 'vis-claude-options-'))
        // No instance stores this token's hash, so it can never authenticate to the gateway.
        const { token } = opts.issueToken()
        const { options } = queryOptions(abort, id, token, env, cwd)
        q = opts.query({
          prompt: catalogInput(abort.signal),
          options: { ...options, ...(opts.model ? { model: opts.model } : {}), cwd, persistSession: false },
        })
        return modelOptions(await q.supportedModels(), opts.model)
      }
      return await Promise.race([read(), cancelled])
    } catch {
      // Catalog failures can include authentication environment values; never expose or cache them.
      throw catalogError()
    } finally {
      try { q?.close() } catch { /* abort and tree cleanup still run */ }
      abort.abort()
      await stopProcess(id)
      if (cwd) rmSync(cwd, { recursive: true, force: true })
    }
  }

  async function consume(run: Run, iterator: AsyncIterator<SDKMessage>, first: SDKMessage | undefined) {
    const { sessionId, turnId } = run
    const readPaths = new Map<string, string>()
    let status: 'completed' | 'failed' | 'interrupted' = 'interrupted'
    try {
      for (let msg = first; msg; ) {
        if (msg.type === 'result') {
          status = run.interrupted ? 'interrupted' : msg.subtype === 'success' && !msg.is_error ? 'completed' : 'failed'
        }
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') report({ type: 'context_compacted', sessionId })
        if ((msg.type === 'assistant' || msg.type === 'user') && msg.parent_tool_use_id === null) report({ type: 'leaf', sessionId, leafUuid: msg.uuid! })
        for (const item of translate(msg, readPaths)) report({ type: 'item', sessionId, turnId, ...item })
        const next = await iterator.next()
        msg = next.done ? undefined : next.value
      }
    } catch (error) {
      // Abnormal process exit or abort: the turn did not finish normally, so treat it as interrupted (0004)
      if (!run.interrupted) console.error(`[claude] ${sessionId} turn ${turnId} ended abnormally`, run.scrub(error))
    } finally {
      await stopProcess(turnId)
      exit(run.instanceId, status)
      report({ type: 'turn_ended', sessionId, turnId, status })
      // Disposal must retain the consumer until both process exit and the final database write.
      if (runs.get(sessionId) === run) runs.delete(sessionId)
      consumers.delete(run)
    }
  }

  return {
    async agentOptions() {
      if (disposed) throw catalogError()
      const abort = new AbortController()
      catalogControllers.add(abort)
      const timer = setTimeout(() => abort.abort(), opts.catalogTimeoutMs ?? 15_000)
      try {
        const env = await queryEnv(abort.signal)
        if (disposed || abort.signal.aborted) throw catalogError()
        const key = authHash(env)
        const pending = catalogPending.get(key)
        if (pending) return await pending
        const cached = catalogs.get(key)
        if (cached) return cached
        const result = readCatalog(env, abort).then(models => {
          catalogs.set(key, models)
          return models
        }).finally(() => { catalogPending.delete(key) })
        catalogPending.set(key, result)
        return await result
      } catch {
        throw catalogError()
      } finally {
        clearTimeout(timer)
        catalogControllers.delete(abort)
      }
    },

    async ensureReady(sessionId) {
      if (disposed) throw new DispatchError('rejected', 'Runtime is closed')
      // One call per turn, with no persistent process to prepare; only ensure the working directory exists
      mkdirSync(opts.workDir(sessionId), { recursive: true })
    },

    async dispatchTurn(input) {
      if (disposed) throw new DispatchError('rejected', 'Runtime is closed')
      if (runs.has(input.sessionId) || starting.has(input.sessionId)) throw new DispatchError('rejected', 'This session already has an active turn')
      const { token, tokenHash } = opts.issueToken()
      const instanceId = startTurnInstance(db, { sessionId: input.sessionId, turnId: input.turnId, tokenHash }, now())
      const abort = new AbortController()
      let finished!: () => void
      const startup = { turnId: input.turnId, instanceId, abort, done: new Promise<void>(resolve => { finished = resolve }) }
      starting.set(input.sessionId, startup)
      startups.add(startup)
      let scrub = (error: unknown) => errorMessage(error, {}, token)
      try {
        let q: Query
        try {
          const cwd = opts.workDir(input.sessionId)
          const env = await queryEnv(abort.signal)
          scrub = error => errorMessage(error, env, token)
          const prepared = queryOptions(abort, input.turnId, token, env, cwd)
          const { options, expanded, isolated, notice } = prepared
          scrub = prepared.scrub
          if (notice && opts.dataDir) report({ type: 'item', sessionId: input.sessionId, turnId: input.turnId, itemId: `sandbox:${input.turnId}`, revision: 1, kind: 'notice', payload: { code: 'sandbox_read_only', message: notice } })
          const sessionModel = input.agentConfig?.model
          const model = sessionModel && sessionModel !== 'default' ? sessionModel : opts.model
          const effort = input.agentConfig?.effort
          q = opts.query({
            prompt: buildPrompt(input),
            options: {
              ...options,
              ...(expanded ? { canUseTool: turnPermissions(input, cwd, isolated, abort) } : {}),
              ...(input.projectContext ? { additionalDirectories: [input.projectContext.rootPath] } : {}),
              ...(input.resumeId ? { resume: input.resumeId } : {}),
              ...(model ? { model } : {}),
              ...(isEffort(effort) ? { effort } : {}),
              cwd: opts.workDir(input.sessionId),
              systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(input.workContext, expanded, isolated) },
            },
          })
        } catch (error) {
          if (abort.signal.aborted || disposed) {
            exit(instanceId, 'interrupted')
            throw new DispatchError('unknown', 'Runtime has stopped')
          }
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', `Cannot start Claude: ${scrub(error)}`)
        }

        // Wait for init: failure before receiving it proves the Agent did not process this message
        const iterator = q[Symbol.asyncIterator]()
        const timeoutMs = opts.initTimeoutMs ?? 60_000
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), timeoutMs) })
        let first: IteratorResult<SDKMessage>
        const firstNext = iterator.next()
        // After timeout, this read fails due to abort with nobody still waiting
        firstNext.catch(() => {})
        try {
          const raced = await Promise.race([firstNext, timeout])
          if (raced === 'timeout') {
            abort.abort()
            exit(instanceId, 'start_timeout')
            throw new DispatchError('unknown', `Waiting for Claude startup exceeded ${Math.round(timeoutMs / 1000)} seconds`)
          }
          if (abort.signal.aborted || disposed) throw new Error('Runtime has stopped')
          first = raced
        } catch (error) {
          if (error instanceof DispatchError) throw error
          if (abort.signal.aborted || disposed) {
            exit(instanceId, 'interrupted')
            throw new DispatchError('unknown', 'Claude startup was interrupted')
          }
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', `Claude startup failed: ${scrub(error)}`)
        } finally {
          clearTimeout(timer)
        }
        if (first.done) {
          exit(instanceId, 'start_failed')
          throw new DispatchError('rejected', 'Claude exited before starting')
        }
        if (first.value.type === 'system' && first.value.subtype === 'init') {
          report({ type: 'resume_id', sessionId: input.sessionId, resumeId: first.value.session_id })
        }
        markInstanceReady(db, instanceId)

        const run: Run = { sessionId: input.sessionId, turnId: input.turnId, instanceId, q, abort, scrub, interrupted: false, done: Promise.resolve() }
        runs.set(input.sessionId, run)
        consumers.add(run)
        // The turn continues in the background; dispatchTurn only reports acceptance
        run.done = consume(run, iterator, first.value)
      } finally {
        if (runs.get(input.sessionId)?.turnId !== input.turnId) await stopProcess(input.turnId)
        if (starting.get(input.sessionId)?.turnId === input.turnId) starting.delete(input.sessionId)
        startups.delete(startup)
        finished()
      }
    },

    async interruptTurn({ sessionId, turnId }) {
      const pending = starting.get(sessionId)
      if (pending?.turnId === turnId) { pending.abort.abort(); await pending.done; return }
      const run = runs.get(sessionId)
      if (!run || run.turnId !== turnId) return
      run.interrupted = true
      const grace = new Promise<void>(r => setTimeout(r, opts.interruptGraceMs ?? 5000).unref())
      try {
        await Promise.race([run.q.interrupt(), grace])
      } catch {
        // If the interrupt request fails, abort directly
      }
      // Force abort if still running after the grace period
      void Promise.race([run.done, grace]).then(() => { if (runs.get(sessionId) === run) run.abort.abort() })
    },

    async terminateTurn({ sessionId, turnId }) {
      const pending = starting.get(sessionId)
      if (pending?.turnId === turnId) {
        starting.delete(sessionId)
        exit(pending.instanceId, 'interrupted')
        pending.abort.abort()
        await stopProcess(turnId)
        await pending.done
      }
      const run = runs.get(sessionId)
      if (run?.turnId === turnId) {
        run.interrupted = true
        runs.delete(sessionId)
        run.abort.abort()
        await stopProcess(turnId)
        await run.done
      }
    },

    async dispose() {
      disposed = true
      const pending = [...startups]
      for (const run of pending) run.abort.abort()
      const all = [...consumers]
      for (const run of all) {
        run.interrupted = true
        run.abort.abort()
      }
      for (const abort of catalogControllers) abort.abort()
      await Promise.all([
        ...[...processes.keys()].map(id => stopProcess(id)),
        ...pending.map(run => run.done),
        ...all.map(run => run.done),
        ...[...catalogPending.values()].map(result => result.catch(() => {})),
      ])
    },
  }
}

function errorMessage(error: unknown, env: Record<string, string | undefined>, token: string): string {
  let message = error instanceof Error ? error.message : String(error)
  const values = [token]
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue
    if (SECRET_ENV_KEYS.has(key.toUpperCase())) values.push(value)
    else if (/^(?:https?|no)_proxy$/i.test(key)) {
      // Keep proxy hosts useful in diagnostics while removing credentials, including their trailing delimiter.
      const userinfo = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*@)/i.exec(value)?.[1]
      if (userinfo) values.push(userinfo)
    }
  }
  const variants = new Set<string>()
  for (const value of values) {
    if (!value) continue
    variants.add(value)
    variants.add(JSON.stringify(value).slice(1, -1))
    try { variants.add(encodeURIComponent(value)) } catch { /* Invalid Unicode is still scrubbed in its literal form. */ }
  }
  for (const value of [...variants].sort((left, right) => right.length - left.length)) message = message.replaceAll(value, '[redacted]')
  return message
}

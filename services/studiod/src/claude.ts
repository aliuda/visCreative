import { createClaudeRuntime, claudeDescriptor, type QueryFn } from '@vis/agent-claude'
import { issueAgentToken } from './auth'
import type { AgentRuntimeFactory } from './space-host'

/** Connect the Claude adapter to a space: tokens are issued per space, with a fixed working directory per session. */
export function claudeRuntime(opts: { query: QueryFn; socketPath: string; cliBinDir: string; dataDir: string; visMcp: { command: string; args: string[] }; fallbackDirs?: readonly string[]; env?: NodeJS.ProcessEnv; model?: string }): AgentRuntimeFactory {
  const factory: AgentRuntimeFactory = ({ spaceId, db, workDir, report, requestApproval, forbiddenPaths }) => createClaudeRuntime({ db, report, requestApproval }, {
    query: opts.query,
    socketPath: opts.socketPath,
    cliBinDir: opts.cliBinDir,
    dataDir: opts.dataDir,
    visMcp: opts.visMcp,
    ...(forbiddenPaths ? { forbiddenPaths } : {}),
    ...(opts.fallbackDirs ? { fallbackDirs: opts.fallbackDirs } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    workDir,
    issueToken: () => issueAgentToken(spaceId),
  })
  return Object.assign(factory, { descriptor: claudeDescriptor })
}

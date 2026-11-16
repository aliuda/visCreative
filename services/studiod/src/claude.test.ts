import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { claudeRuntime } from './claude'
import { listAgents } from './agents'
import { openSpaceHost } from './space-host'

const defaults = { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } }

describe('Claude child session configuration', () => {
  it('discovers, validates and applies a child model and effort on its first and subsequent turns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vis-claude-child-'))
    const turns: { prompt: string; options: Options }[] = []
    const optionsFor = (text: string) => turns.find(turn => turn.prompt.includes(text))?.options
    const catalogClosed = vi.fn()
    const factory = claudeRuntime({
      socketPath: 'unused', cliBinDir: dir, dataDir: join(dir, 'data'), visMcp: { command: process.execPath, args: ['vis.mjs', 'mcp'] }, env: { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }, model: 'sonnet',
      query: ({ prompt, options }) => {
        const catalog = typeof prompt !== 'string'
        if (typeof prompt === 'string') turns.push({ prompt, options: options! })
        const messages = async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'system', subtype: 'init', session_id: 'fake-claude-resume', uuid: 'init' } as unknown as SDKMessage
          yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage
        }
        return Object.assign(messages(), {
          supportedModels: async () => [
            { value: 'opus', displayName: 'Opus', description: 'Test Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] },
            { value: 'sonnet', displayName: 'Sonnet', description: 'Test Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
            { value: 'haiku', displayName: 'Haiku', description: 'Test Haiku', supportsEffort: false },
          ],
          close: catalog ? catalogClosed : () => {},
        }) as unknown as Query
      },
    })
    const host = openSpaceHost('claude-child', dir, { runtimes: { claude: factory }, providers: [], defaults })
    try {
      expect(listAgents({ claude: factory })[0]!.capabilities).toMatchObject({ models: true, effort: true })
      const { models } = await host.work.agentOptions({ agentKind: 'claude' })
      expect(models.find(model => model.isDefault)?.id).toBe('sonnet')
      expect(models.find(model => model.id === 'haiku')?.efforts).toEqual([])
      expect(catalogClosed).toHaveBeenCalledTimes(1)
      const root = host.work.create({ requestId: 'root', title: 'Root', chat: { agentKind: 'claude' } }).item
      const actor = { sessionId: root.sessions[0]!.sessionId, workItemId: root.workItemId }
      const child = (await host.work.dispatch({ requestId: 'child', parentId: root.workItemId, title: 'Child', brief: 'Create a draft', agentKind: 'claude', activate: false, agentConfig: { model: 'opus', effort: 'max', serviceTier: null } }, () => actor)).item
      expect(child.sessions[0]!.agentConfig).toEqual({ model: 'opus', effort: 'max', serviceTier: null })
      host.work.activate({ requestId: 'activate-child', workItemId: child.workItemId, expectedRevision: child.revision })
      await expect.poll(() => optionsFor('Create a draft')).toMatchObject({ model: 'opus', effort: 'max' })
      await host.sessions.idle()
      await expect.poll(() => host.work.get({ workItemId: child.workItemId }).item.sessions[0]!.activeTurnId).toBeNull()
      expect(optionsFor('Create a draft')).toMatchObject({ model: 'opus', effort: 'max' })
      expect(optionsFor('Create a draft')).not.toHaveProperty('serviceTier')
      await expect(host.work.setAgentConfig({ requestId: 'bad-effort', workItemId: child.workItemId, model: 'haiku', effort: 'high', serviceTier: null }, () => actor)).rejects.toMatchObject({ code: 'invalid_params' })
      await host.work.setAgentConfig({ requestId: 'update-child', workItemId: child.workItemId, model: 'sonnet', effort: 'medium', serviceTier: 'default' }, () => actor)
      expect(host.work.get({ workItemId: child.workItemId }).item.sessions[0]!.agentConfig).toEqual({ model: 'sonnet', effort: 'medium', serviceTier: 'default' })
      host.sessions.sendMessage({ requestId: 'next-turn', sessionId: child.sessions[0]!.sessionId, text: 'Revise the draft', refs: [] })
      await host.sessions.idle()
      await expect.poll(() => optionsFor('Revise the draft')).toMatchObject({ model: 'sonnet', effort: 'medium' })
      expect(optionsFor('Revise the draft')).not.toHaveProperty('serviceTier')
      expect(catalogClosed).toHaveBeenCalledTimes(1)
    } finally {
      await host.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


it('does not cache a failed Claude catalog across configuration retries or block default turns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vis-claude-catalog-retry-'))
  const models = vi.fn().mockRejectedValueOnce(new Error('test-auth-value')).mockResolvedValue([
    { value: 'sonnet', displayName: 'Sonnet', description: 'Test Sonnet', supportsEffort: true, supportedEffortLevels: ['high'] },
  ])
  const turns: Options[] = []
  const host = openSpaceHost('claude-catalog-retry', dir, {
    runtimes: { claude: claudeRuntime({
      socketPath: 'unused', cliBinDir: dir, dataDir: join(dir, 'data'), visMcp: { command: process.execPath, args: ['vis.mjs', 'mcp'] }, env: { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'config') }, model: 'sonnet',
      query: ({ prompt, options }) => {
        if (typeof prompt === 'string') turns.push(options!)
        return Object.assign((async function* () {
          yield { type: 'system', subtype: 'init', session_id: 'fake', uuid: 'init' } as unknown as SDKMessage
          yield { type: 'result', subtype: 'success', is_error: false } as SDKMessage
        })(), { supportedModels: models, close: () => {} }) as unknown as Query
      },
    }) },
    providers: [], defaults,
  })
  try {
    const session = host.sessions.create({ requestId: 'session', agentKind: 'claude' })
    await expect(host.sessions.setAgentConfig({ requestId: 'failed-config', sessionId: session.sessionId, model: 'sonnet', effort: 'high', serviceTier: null })).rejects.toMatchObject({ code: 'unavailable' })
    host.sessions.sendMessage({ requestId: 'default-turn', sessionId: session.sessionId, text: 'Continue with defaults', refs: [] })
    await host.sessions.idle()
    expect(turns[0]!.model).toBe('sonnet')
    await host.sessions.setAgentConfig({ requestId: 'retry-config', sessionId: session.sessionId, model: 'sonnet', effort: 'high', serviceTier: null })
    expect(models).toHaveBeenCalledTimes(2)
    expect((await host.sessions.agentOptions({ sessionId: session.sessionId })).models[0]!.efforts).toEqual([{ id: 'high', label: 'high' }])
    expect(models).toHaveBeenCalledTimes(2)
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

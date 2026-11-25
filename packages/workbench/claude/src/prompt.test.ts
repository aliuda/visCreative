import { describe, expect, it } from 'vitest'
import { listCapabilities, toolNameOf, type MethodName } from '@vis/protocol'
import type { DispatchInput } from '@vis/workbench-core'
import { buildPrompt, SYSTEM_APPEND, systemAppend } from './prompt'

const input: DispatchInput = {
  sessionId: 'session', turnId: 'turn', text: '绘制雨夜街道', inputSnapshotId: 'snapshot',
  refs: [], resumeId: null, sessionTitle: 'Claude 1', titleSource: 'default',
}

it('script instructions use the vis MCP tools available to Claude', () => {
  const script = SYSTEM_APPEND.split('<脚本节点>')[1]!.split('</脚本节点>')[0]!
  expect(script).not.toContain('Bash')
  expect(script).toContain('canvas_get')
  expect(script).toContain('canvas_apply')
  expect(SYSTEM_APPEND).toContain('vis MCP tools')
})

it('protects existing layouts and limits organize proposals using the registered MCP name', () => {
  for (const text of ['placements', 'Never move or resize existing nodes', 'gateway refuses it', 'mcp__vis__canvas_organize_propose', 'at most once per finished batch', 'visibly disordered', 'reason in one sentence']) {
    expect(SYSTEM_APPEND).toContain(text)
  }
})

it('library instructions use MCP tools and preserve user labels', () => {
  const library = SYSTEM_APPEND.split('<资产库>')[1]!.split('</资产库>')[0]!
  for (const text of ['asset_list', 'asset_label', 'labeled: false', 'nextCursor', 'context', 'path', '50', 'runId', 'skippedFields', '绝不重试', '角色 / 场景 / 物品 / 风格 / 其他', '视频片段 / 成片']) expect(library).toContain(text)
})

it('Without project context, preserve existing input and explain how to register local work', () => {
  expect(buildPrompt(input)).toBe(input.text)
  expect(SYSTEM_APPEND).toContain('asset_import_file')
  expect(SYSTEM_APPEND).toContain('canvas_apply')
})

describe('Workspace hierarchy', () => {
  const root = { workItemId: 'work_1', parentId: null, hasChildren: true }
  const child = { workItemId: 'work_2', parentId: 'work_1', hasChildren: false }

  it('Root workspaces describe dispatch, replies, and parent review rules factually', () => {
    const instructions = systemAppend(root)
    for (const text of ['根工作区', 'work_dispatch', '目标、上下文、工作范围、交付物与验收条件', '将参考节点 ID 写进 brief', '不要轮询', 'resolvedBy', 'already_resolved', 'reviewBy 为 parent', 'reviewBy 为 user']) expect(instructions).toContain(text)
    expect(instructions).not.toContain('kind: done')
    expect(instructions).not.toContain('协调者')
    expect(instructions).not.toContain('自己的框')
  })

  it('With a parent, report decisions, blockers, and completion, then wait for review', () => {
    const instructions = systemAppend(child)
    for (const text of ['不再派发子工作项', 'work_report', 'question / blocked / escalation', 'kind: done', 'nodeIds / assetVersionIds', '报告成功后保持空闲', '画布和资产属于项目']) expect(instructions).toContain(text)
    expect(instructions).not.toContain('可以用 work_dispatch')
    expect(instructions).not.toContain('reviewBy 为 parent')
  })

  it('Turns carry only workspace hierarchy facts', () => {
    expect(buildPrompt({ ...input, workContext: root })).toContain('<工作项>\n所属工作项：work_1\n父工作项：无（根工作区）\n有子工作项：是\n</工作项>')
    expect(buildPrompt({ ...input, workContext: child })).toContain('所属工作项：work_2\n父工作项：work_1\n有子工作项：否')
    expect(buildPrompt({ ...input, workContext: child })).not.toContain('角色：')
    expect(buildPrompt({ ...input, workContext: child })).not.toContain('画布框：')
  })
})

describe('Project and skill prompts', () => {
  const skill = { name: 'storyboard', description: '把剧本拆成分镜', path: '/project/skills/storyboard/SKILL.md' }
  const projectContext = { rootPath: '/project', assetsPath: '/project/assets', skillsPath: '/project/skills', workDir: '/project/workspaces/session', skills: [skill] }

  it('Each turn carries the root directory, assets, working directory, and on-demand skill directory', () => {
    const prompt = buildPrompt({ ...input, projectContext })
    expect(prompt).toContain('<项目>')
    for (const path of [projectContext.rootPath, projectContext.assetsPath, projectContext.skillsPath, projectContext.workDir, skill.path]) expect(prompt).toContain(path)
    expect(prompt).toContain(skill.name)
    expect(prompt).toContain(skill.description)
    expect(prompt).toContain('按任务需要读取完整文件后遵循')
    expect(prompt).not.toContain('<指定 skill>')
  })

  it('User-specified skills must be read and followed while preserving original text and fixed references', () => {
    const prompt = buildPrompt({ ...input, projectContext, skills: [skill.name], refs: [{ nodeId: 'target', slotId: 'main', revision: null }] })
    expect(prompt.startsWith(input.text)).toBe(true)
    expect(prompt).toContain('<指定 skill>')
    expect(prompt).toContain('必须读取并遵循各自的 SKILL.md')
    expect(prompt).toContain(JSON.stringify(skill))
    expect(prompt).toContain('空，可作为生成目标')
  })

  it('Explicitly mark an empty skill directory without loading full skill content', () => {
    const prompt = buildPrompt({ ...input, projectContext: { ...projectContext, skills: [] }, skills: [] })
    expect(prompt).toContain('\n无\n</项目>')
    expect(prompt).not.toContain('<指定 skill>')
  })
})


it('The canvas receives only deliverables, with provenance declared and server placement used', () => {
  const instructions = SYSTEM_APPEND
  for (const text of ['交付物才写画布', '不要建「报告」文本节点', 'purpose: "working"', 'node.setMeta', '人物/场景/道具/镜头/分镜/文案/其他', 'inputNodeIds', 'placements']) expect(instructions).toContain(text)
})

it('timeline instructions explain document limits, pinned edits, local export, and layout', () => {
  const instructions = SYSTEM_APPEND
  for (const text of ['timelineFrom', '{ nodeId, durationMs }', '500\u201330000', 'durationSec', 'video', 'first', 'timeline.set', 'expectedRevision', 'assetVersionId', 'startMs', 'inMs', 'outMs', 'fadeInMs', 'fadeOutMs', '0–2', '1 条视频轨', '4 条音频轨', '200 个片段', '30 分钟', '10 秒', 'timeline.export', 'params: {}', 'exportOf', 'Frame', 'canvas_get', 'canvas_apply', 'media_process', 'media_get', 'media_get', '剪辑绝不提交生成任务', '单素材截取、变速、提取音轨', '仍不支持旋转', '画中画', 'media.captions_unavailable', 'overlay: { x, y, width, opacity }', '2 条叠加轨', 'speed', '0.25–4', 'transitionIn', 'crossfade', 'dip', 'textTracks', 'font_list', 'assetVersionId }', 'pnpm fonts:fetch', '字幕联动', '让字幕继续跟着原来的镜头', '不要编造字段', '没有实际完成并检查结果之前']) expect(instructions).toContain(text)
})


it('teaches exact child configuration only on author or author-written workflow direction', () => {
  const work = { workItemId: 'root', parentId: null, hasChildren: true }
  const instructions = systemAppend(work)
  for (const text of ['only when the author asked', 'skill or workflow the author wrote', 'otherwise omit agentConfig', 'mcp__vis__work_agent_options', 'mcp__vis__work_dispatch', 'mcp__vis__work_set_agent_config', 'mcp__vis__work_get', 'ambiguous or not listed', 'Do not pick a model on your own initiative']) expect(instructions).toContain(text)
})


it('does not teach child sessions to configure or dispatch children', () => {
  const child = { workItemId: 'child', parentId: 'root', hasChildren: false }
  const instructions = systemAppend(child)
  for (const text of ['mcp__vis__work_agent_options', 'mcp__vis__work_dispatch', 'mcp__vis__work_set_agent_config']) expect(instructions).not.toContain(text)
})


it('every named vis MCP tool is registered for agents', () => {
  const registered = new Set(listCapabilities('agent').filter(capability => !capability.method.startsWith('capabilities.')).map(capability => `mcp__vis__${toolNameOf(capability.method as MethodName)}`))
  const work = { workItemId: 'root', parentId: null, hasChildren: true }
  const prompts = [SYSTEM_APPEND, systemAppend(work, true, true), systemAppend(work, true, false), buildPrompt({ ...input, refs: [{ nodeId: 'node', slotId: 'slot', revision: 1 }] })]
  const named = new Set(prompts.flatMap(prompt => [...prompt.matchAll(/mcp__vis__[A-Za-z0-9_]+/g)].map(match => match[0])))
  expect(named.size).toBeGreaterThan(10)
  for (const name of named) expect(registered.has(name), name).toBe(true)
  expect(SYSTEM_APPEND).toContain('mcp__vis__gen_submit')
  expect(SYSTEM_APPEND).toContain('mcp__vis__gen_get({ jobId, waitMs: 30000 })')
  expect(SYSTEM_APPEND).toContain('mcp__vis__media_get({ taskId, waitMs: 30000 })')
  expect(SYSTEM_APPEND).not.toContain('CLI remains on PATH')
})

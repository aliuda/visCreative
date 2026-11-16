#!/usr/bin/env node
// One deterministic fixture speaks both Codex app-server and DeepSeek ACP; neither path calls a model.
import { execFile } from 'node:child_process'

const acp = process.argv.includes('--profile')
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const notify = (method, params) => send({ method, params })
const sessionId = 'timeline-fixture'
let mcp
let toolSeq = 0
let buffer = ''

async function tool(turnId, name, args = {}) {
  const id = `transform-tool-${++toolSeq}`
  const item = { id, type: 'mcpToolCall', server: 'vis', tool: name, arguments: args, status: 'inProgress' }
  if (acp) notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: id, title: `mcp__vis__${name}`, rawInput: args } })
  else notify('item/started', { threadId: sessionId, turnId, item })
  const result = await new Promise((resolve, reject) => {
    const env = Array.isArray(mcp.env) ? Object.fromEntries(mcp.env.map(({ name, value }) => [name, value])) : mcp.env
    const child = execFile(mcp.command, mcp.args, { env: { ...process.env, ...env } }, (error, stdout) => {
      if (error) { reject(error); return }
      try { resolve(stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 1).result) }
      catch (error) { reject(error) }
    })
    child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`)
  })
  if (acp) notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: id,
    status: result.isError ? 'failed' : 'completed', content: result.content } })
  else notify('item/completed', { threadId: sessionId, turnId, item: { ...item, status: result.isError ? 'failed' : 'completed', result } })
  const output = JSON.parse(result.content.find(item => item.type === 'text').text)
  if (result.isError) throw new Error(output.error?.message ?? JSON.stringify(output))
  return output
}

async function transforms(turnId) {
  await tool(turnId, 'guide', { topic: 'timeline' })
  const { nodes } = await tool(turnId, 'canvas_get')
  const source = title => {
    const node = nodes.find(node => node.title === title)
    return { nodeId: node.nodeId, assetVersionId: node.slots.find(slot => slot.slotKey === 'main').content.assetVersionId }
  }
  const timeline = nodes.find(node => node.kind === 'timeline')
  const slot = timeline.slots.find(slot => slot.slotKey === 'main')
  const key = (t, value) => ({ t, value, ease: 'linear' })
  const doc = { version: 1, output: { width: 320, height: 180, fps: 10 }, tracks: [
    { id: 'main', kind: 'video', muted: false, volume: 1, clips: [{ id: 'pan', source: source('Transform source'), startMs: 0, inMs: 1000, outMs: 5000, speed: 2, volume: 1, fadeInMs: 0, fadeOutMs: 0,
      crop: { keys: [key(1000, { x: 0, y: 0, width: 0.5, height: 0.5 }), key(5000, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 })] } }] },
    { id: 'overlays', kind: 'overlay', muted: true, volume: 1, clips: [{ id: 'moving-overlay', source: source('Transform overlay'), startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0,
      crop: { keys: [key(0, { x: 0, y: 0, width: 1, height: 1 }), key(2000, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 })] },
      overlay: { x: { keys: [key(0, 0.25), key(2000, 0.75)] }, y: { keys: [key(0, 0.25), key(2000, 0.75)] },
        width: { keys: [key(0, 0.2), key(2000, 0.4)] }, opacity: { keys: [key(0, 1), key(2000, 0.5)] } } }] },
  ] }
  const saved = await tool(turnId, 'canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc }] })
  const invalid = structuredClone(doc)
  invalid.tracks[0].clips[0].crop.keys[1].value.height = 0.4
  const messages = []
  try {
    await tool(turnId, 'canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: saved.slotRevisions[slot.slotId], doc: invalid }] })
    throw new Error('Mixed-aspect crop unexpectedly accepted')
  } catch (error) {
    if (!error.message.includes('crop keys must keep one aspect ratio') || !error.message.includes('See guide "timeline"')) throw error
    messages.push(error.message)
  }
  const capped = structuredClone(doc)
  capped.tracks[1].clips[0].overlay.x.keys = Array.from({ length: 33 }, (_, i) => key(i * 50, 0.5))
  try {
    await tool(turnId, 'canvas_apply', { ops: [{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: saved.slotRevisions[slot.slotId], doc: capped }] })
    throw new Error('33-key property unexpectedly accepted')
  } catch (error) {
    if (!error.message.includes('Too big: expected array to have <=32 items') || !error.message.includes('See guide "timeline"')) throw error
    messages.push(error.message)
  }
  return `Clip transforms applied. Refused invalid writes: ${messages.join(' | ')}`
}

async function receive(message) {
  if (message.id === undefined || !message.method) return
  const { id, method, params } = message
  if (method === 'initialize') return send({ id, result: acp ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } : { userAgent: 'fake-timeline/0' } })
  if (method === 'model/list') return send({ id, result: { data: [], nextCursor: null } })
  if (['thread/start', 'thread/resume', 'session/new', 'session/resume'].includes(method)) {
    mcp = acp ? params.mcpServers[0] : Object.values(params.config.mcp_servers)[0]
    return send({ id, result: acp ? { sessionId, configOptions: [] } : { thread: { id: sessionId } } })
  }
  if (method === 'turn/start' || method === 'session/prompt') {
    const turnId = `transform-turn-${process.pid}`
    if (!acp) send({ id, result: { turn: { id: turnId, status: 'inProgress' } } })
    try {
      const text = await transforms(turnId)
      if (acp) {
        notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
        send({ id, result: { stopReason: 'end_turn' } })
      } else {
        notify('item/completed', { threadId: sessionId, turnId, item: { id: 'answer', type: 'agentMessage', text } })
        notify('turn/completed', { threadId: sessionId, turn: { id: turnId, status: 'completed' } })
      }
    } catch (error) {
      if (acp) send({ id, error: { code: -32603, message: error.message } })
      else notify('turn/completed', { threadId: sessionId, turn: { id: turnId, status: 'failed', error: { message: error.message } } })
    }
    return
  }
  send({ id, result: {} })
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, nl))
    buffer = buffer.slice(nl + 1)
    void receive(message)
  }
})
process.stdin.on('end', () => process.exit(0))

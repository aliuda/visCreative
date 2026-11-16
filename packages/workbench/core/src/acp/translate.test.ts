import { expect, it } from 'vitest'
import { createTranslator } from './translate'

it('keeps the original raw-input path when later updates supply a different location', () => {
  const translate = createTranslator('session', 'turn', 'acp')
  translate({ sessionUpdate: 'tool_call', toolCallId: 'read', rawInput: { path: '/project/original.png' } })
  translate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'in_progress', locations: [{ path: '/project/later.png' }] })
  const result = translate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', locations: [{ path: '/project/result.png' }], content: [{ type: 'image' }] })
  expect(result[0]?.payload).toMatchObject({ viewedImages: [{ path: '/project/original.png' }] })
})

it.each([
  { rawInput: { path: '/project/path.png', file_path: '/project/file.png' }, locations: [{ path: '/project/location.png' }], path: '/project/path.png' },
  { rawInput: { file_path: '/project/file.png' }, locations: [{ path: '/project/location.png' }], path: '/project/file.png' },
  { locations: [{ path: '/project/location.png' }], path: '/project/location.png' },
])('captures an image path supplied by a later tool update: $path', ({ path, ...input }) => {
  const translate = createTranslator('session', 'turn', 'acp')
  translate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', rawInput: {} })
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'in_progress', ...input })).toEqual([])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })[0]?.payload)
    .toMatchObject({ viewedImages: [{ path }] })
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed', ...input, content: [{ type: 'image' }] })[0]?.payload)
    .toMatchObject({ viewedImages: [{ path }] })
})

it.each([
  { rawInput: { path: '/project/path.png', file_path: '/project/file.png' }, locations: [{ path: '/project/location.png' }], path: '/project/path.png' },
  { rawInput: { file_path: '/project/file.png' }, locations: [{ path: '/project/location.png' }], path: '/project/file.png' },
  { locations: [{ path: '/project/location.png' }], path: '/project/location.png' },
])('remembers the first image path from rawInput or locations: $path', ({ path, ...input }) => {
  const translate = createTranslator('session', 'turn', 'acp')
  const call = translate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', ...input })
  expect(call[0]?.payload).not.toHaveProperty('viewedImages')
  const update = { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }] }
  const expected = [{ itemId: 'acp:session:read:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'read', isError: false, text: '[图片]', viewedImages: [{ path }] } }]
  expect(translate(update)).toEqual(expected)
  expect(translate(update)).toEqual(expected)
  expect(translate({ ...update, content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })).toEqual(expected)
})

it('does not mark text content, failed reads, or image results without a remembered path as viewed', () => {
  const translate = createTranslator('session', 'turn', 'acp')
  translate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', rawInput: { path: '/project/frame.png' } })
  const update = { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Notes' } }] }
  expect(translate(update)[0]?.payload).toEqual({ toolUseId: 'read', isError: false, text: 'Notes' })
  const image = [{ type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } }]
  expect(translate({ ...update, status: 'failed', content: image })[0]?.payload).toEqual({ toolUseId: 'read', isError: true, text: '[图片]' })
  expect(translate({ ...update, toolCallId: 'unknown', content: image })[0]?.payload).not.toHaveProperty('viewedImages')
})

it('namespaces every ACP transcript item with the configured prefix and preserves revisions', () => {
  const translate = createTranslator('session', 'turn', 'custom')
  expect(translate({ sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: 'Hello' } })).toEqual([
    { itemId: 'custom:session:message', revision: 1, kind: 'assistant_text', payload: { text: 'Hello' } },
  ])
  expect(translate({ sessionUpdate: 'agent_message_chunk', messageId: 'message', content: { type: 'text', text: ' again' } })).toEqual([
    { itemId: 'custom:session:message', revision: 2, kind: 'assistant_text', payload: { text: 'Hello again' } },
  ])
  expect(translate({ sessionUpdate: 'agent_thought_chunk', messageId: 'message', content: { type: 'text', text: 'Reasoning' } })).toEqual([
    { itemId: 'custom:session:message:thought', revision: 1, kind: 'reasoning', payload: { text: 'Reasoning' } },
  ])
  expect(translate({ sessionUpdate: 'plan', entries: [{ content: 'Inspect', status: 'pending' }] })).toEqual([
    { itemId: 'custom:session:turn:plan', revision: 1, kind: 'plan', payload: { entries: [{ text: 'Inspect', status: 'pending' }] } },
  ])
  expect(translate({ sessionUpdate: 'plan', entries: [] })[0]).toMatchObject({ itemId: 'custom:session:turn:plan', revision: 2 })
  expect(translate({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'read', rawInput: { path: 'notes' } })).toEqual([
    { itemId: 'custom:session:tool:call', revision: 1, kind: 'tool_call', payload: { toolUseId: 'tool', name: 'read', input: { path: 'notes' } } },
  ])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Notes' } }] })).toEqual([
    { itemId: 'custom:session:tool:result', revision: 1, kind: 'tool_result', payload: { toolUseId: 'tool', isError: false, text: 'Notes' } },
  ])
  expect(translate({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'in_progress' })).toEqual([])
})

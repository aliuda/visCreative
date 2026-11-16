import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { translate } from './translate'

const assistant = (content: unknown[]) => ({ type: 'assistant', uuid: 'call', parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage
const result = (toolUseId: string, content: unknown, isError = false) => ({ type: 'user', uuid: 'result', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } }) as unknown as SDKMessage
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }

it('adds the matching Read path to successful image results and preserves it on redelivery', () => {
  const readPaths = new Map<string, string>()
  const call = assistant([{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/project/frame.png' } }])
  expect(translate(call, readPaths)[0]?.payload).toEqual({ toolUseId: 'read', name: 'Read', input: { file_path: '/project/frame.png' } })
  const message = result('read', [image, { type: 'text', text: 'Image loaded' }])
  const expected = [{ itemId: 'result:0', revision: 1, kind: 'tool_result', payload: { toolUseId: 'read', isError: false, text: '[图片]\nImage loaded', viewedImages: [{ path: '/project/frame.png' }] } }]
  expect(translate(message, readPaths)).toEqual(expected)
  expect(translate(message, readPaths)).toEqual(expected)
  expect(translate(message, new Map())[0]?.payload).not.toHaveProperty('viewedImages')
})

it('does not count text reads, failed reads, other tools, or unmatched image results as viewed images', () => {
  const readPaths = new Map<string, string>()
  translate(assistant([
    { type: 'tool_use', id: 'text', name: 'Read', input: { file_path: '/project/notes.txt' } },
    { type: 'tool_use', id: 'error', name: 'Read', input: { file_path: '/project/missing.png' } },
    { type: 'tool_use', id: 'other', name: 'Other', input: { file_path: '/project/other.png' } },
    { type: 'tool_use', id: 'no-path', name: 'Read', input: {} },
  ]), readPaths)
  expect(translate(result('text', [{ type: 'text', text: 'Notes' }]), readPaths)[0]?.payload).toEqual({ toolUseId: 'text', isError: false, text: 'Notes' })
  expect(translate(result('error', [image], true), readPaths)[0]?.payload).toEqual({ toolUseId: 'error', isError: true, text: '[图片]' })
  for (const id of ['other', 'no-path', 'unknown']) expect(translate(result(id, [image]), readPaths)[0]?.payload).not.toHaveProperty('viewedImages')
})

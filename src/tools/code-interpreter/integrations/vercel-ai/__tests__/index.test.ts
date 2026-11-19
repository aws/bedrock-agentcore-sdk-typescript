import { describe, it, expect, vi } from 'vitest'
import * as vercelAi from '../index.js'

vi.mock('ai', () => ({
  tool: vi.fn((config) => config),
}))

describe('vercel-ai entry point', () => {
  it('exports CodeInterpreterTools and the tool factories', () => {
    expect(Object.keys(vercelAi).sort()).toEqual([
      'CodeInterpreterTools',
      'createExecuteCodeTool',
      'createExecuteCommandTool',
      'createFileOperationsTool',
    ])
  })

  it('creates tools from a CodeInterpreter instance', () => {
    // The factories only capture the interpreter; no call is made at creation time.
    const interpreter = {} as Parameters<typeof vercelAi.createExecuteCodeTool>[0]
    expect(vercelAi.createExecuteCodeTool(interpreter)).toHaveProperty('execute')
    expect(vercelAi.createExecuteCommandTool(interpreter)).toHaveProperty('execute')
    expect(vercelAi.createFileOperationsTool(interpreter)).toHaveProperty('execute')
  })
})

/**
 * Integration tests for ToolLoopAgent with CodeInterpreter and Browser tools
 *
 * These tests validate end-to-end agent functionality with real AWS services.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { CodeInterpreterTools } from '../src/tools/code-interpreter/integrations/vercel-ai/index.js'
import { BrowserTools } from '../src/tools/browser/integrations/vercel-ai/index.js'

const testRegion = process.env.AWS_REGION || 'us-west-2'

describe('ToolLoopAgent with CodeInterpreter', () => {
  let codeInterpreter: CodeInterpreterTools

  beforeAll(() => {
    codeInterpreter = new CodeInterpreterTools({ region: testRegion })
  })

  afterAll(async () => {
    await codeInterpreter.stopSession()
  })

  it('executes code via generate()', async () => {
    const agent = new ToolLoopAgent({
      model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
      instructions: 'You are a helpful assistant. Execute code when asked.',
      tools: { executeCode: codeInterpreter.executeCode },
    })

    const result = await agent.generate({
      prompt: 'Use Python to calculate 2 + 2 and print the result.',
    })

    expect(result.text).toBeDefined()
    expect(typeof result.text).toBe('string')
    expect(result.text.length).toBeGreaterThan(0)
  }, 60000)

  it('handles file operations', async () => {
    const agent = new ToolLoopAgent({
      model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
      instructions: 'You can work with files and execute code.',
      tools: codeInterpreter.tools,
    })

    const result = await agent.generate({
      prompt: 'Write "Hello World" to a file called test.txt, then read it back.',
    })

    expect(result.text).toBeDefined()
    expect(result.text.toLowerCase()).toMatch(/hello world/i)
  }, 90000)
})

describe('ToolLoopAgent with Browser', () => {
  let browser: BrowserTools

  beforeAll(() => {
    browser = new BrowserTools({ region: testRegion })
  })

  afterAll(async () => {
    await browser.stopSession()
  })

  it('navigates and extracts content', async () => {
    const agent = new ToolLoopAgent({
      model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
      instructions: 'Navigate to websites and extract content.',
      tools: browser.tools,
    })

    const result = await agent.generate({
      prompt: 'Go to https://example.com and tell me the main heading.',
    })

    expect(result.text).toBeDefined()
    expect(result.text.toLowerCase()).toContain('example')
  }, 60000)
})

describe('ToolLoopAgent with Combined Tools', () => {
  let codeInterpreter: CodeInterpreterTools
  let browser: BrowserTools

  beforeAll(() => {
    codeInterpreter = new CodeInterpreterTools({ region: testRegion })
    browser = new BrowserTools({ region: testRegion })
  })

  afterAll(async () => {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  })

  it('uses both tools together', async () => {
    const agent = new ToolLoopAgent({
      model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
      instructions: 'You can browse the web and execute code.',
      tools: {
        ...browser.tools,
        ...codeInterpreter.tools,
      },
    })

    const result = await agent.generate({
      prompt: 'Go to https://example.com, get the title, then use Python to count its characters.',
    })

    expect(result.text).toBeDefined()
    expect(result.text.length).toBeGreaterThan(0)
  }, 120000)
})
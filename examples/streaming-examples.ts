/**
 * AI SDK v6 Streaming Examples
 *
 * This example demonstrates various streaming patterns with ToolLoopAgent
 * using CodeInterpreter and Browser tools.
 *
 * Streaming is essential for:
 * - Real-time user feedback during long operations
 * - Progressive UI updates
 * - Efficient handling of large responses
 *
 * Prerequisites:
 * - AWS credentials configured
 * - Access to Claude Sonnet 4 on AWS Bedrock
 * - Node.js >= 20.0.0
 *
 * Run with: npx tsx examples/streaming-examples.ts
 */

/// <reference types="node" />

import './setup.js'
import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { CodeInterpreterTools } from '../src/tools/code-interpreter/integrations/vercel-ai/index.js'
import { BrowserTools } from '../src/tools/browser/integrations/vercel-ai/index.js'

/**
 * Example 1: Basic Text Streaming
 *
 * Demonstrates the simplest streaming pattern with textStream.
 */
async function basicTextStreamingExample() {
  console.log('\n=== Example 1: Basic Text Streaming ===\n')

  const codeInterpreter = new CodeInterpreterTools({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'You are a helpful assistant. Explain your reasoning step by step.',
    tools: codeInterpreter.tools,
  })

  try {
    const result = await agent.stream({
      prompt: 'Write a Python function to check if a number is prime, then test it with 17.',
    })

    // Simple streaming with textStream
    for await (const text of result.textStream) {
      process.stdout.write(text)
    }
    console.log('\n')

    // Access final result after streaming
    const final = await result
    console.log(`\n✓ Completed in ${final.steps.length} steps`)
  } finally {
    await codeInterpreter.stopSession()
  }
}

/**
 * Example 2: Streaming with Progress Tracking
 *
 * Shows how to track streaming progress and tool executions.
 */
async function streamingWithProgressExample() {
  console.log('\n=== Example 2: Streaming with Progress Tracking ===\n')

  const codeInterpreter = new CodeInterpreterTools({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  let charCount = 0
  let lastUpdate = Date.now()

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'You are a data analyst. Execute code to solve problems.',
    tools: codeInterpreter.tools,
    onStepFinish: (step) => {
      const toolNames = step.toolCalls?.map((tc) => tc.toolName).join(', ') || 'text only'
      console.log(`\n  📍 Step completed: ${toolNames}`)
    },
  })

  try {
    const result = await agent.stream({
      prompt: 'Calculate the factorial of 10 using Python, then explain what factorial means.',
    })

    process.stdout.write('Response: ')

    for await (const text of result.textStream) {
      process.stdout.write(text)
      charCount += text.length

      // Show progress every second
      if (Date.now() - lastUpdate > 1000) {
        process.stdout.write(` [${charCount} chars]`)
        lastUpdate = Date.now()
      }
    }

    console.log(`\n\n✓ Total characters: ${charCount}`)
  } finally {
    await codeInterpreter.stopSession()
  }
}

/**
 * Example 3: Browser Streaming with Navigation Events
 *
 * Demonstrates streaming while browsing the web.
 */
async function browserStreamingExample() {
  console.log('\n=== Example 3: Browser Streaming ===\n')

  const browser = new BrowserTools({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'You are a web researcher. When browsing, describe what you see.',
    tools: browser.tools,
    onStepFinish: (step) => {
      for (const toolCall of step.toolCalls || []) {
        // Safely access args with null checks
        const args = toolCall.args as Record<string, unknown> | undefined

        if (toolCall.toolName === 'navigate' && args?.url) {
          console.log(`\n  🌐 Navigated to: ${args.url}`)
        } else if (toolCall.toolName === 'getText') {
          console.log('\n  📄 Extracted text content')
        } else if (toolCall.toolName === 'getHtml') {
          console.log('\n  📝 Retrieved HTML content')
        }
      }
    },
  })

  try {
    const result = await agent.stream({
      prompt: 'Visit https://example.com and describe what you see on the page.',
    })

    console.log('Streaming response:')
    console.log('-'.repeat(40))

    for await (const text of result.textStream) {
      process.stdout.write(text)
    }

    console.log('\n' + '-'.repeat(40))

    // Consume the result but don't need to use it
    await result
    console.log('\n✓ Completed')
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\n❌ Error: ${error.message}`)
    } else {
      console.error('\n❌ Error:', error)
    }
  } finally {
    await browser.stopSession()
  }
}

/**
 * Example 4: Combined Tools Streaming
 *
 * Shows streaming with multiple tool types working together.
 */
async function combinedToolsStreamingExample() {
  console.log('\n=== Example 4: Combined Tools Streaming ===\n')

  const codeInterpreter = new CodeInterpreterTools({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  const browser = new BrowserTools({
    region: process.env.AWS_REGION || 'us-west-2',
  })

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'You are a research assistant with browser and code execution capabilities.',
    tools: {
      ...codeInterpreter.tools,
      ...browser.tools,
    },
    onStepFinish: (step) => {
      const tools = step.toolCalls?.map((tc) => tc.toolName) || []
      if (tools.length > 0) {
        const browserTools = ['navigate', 'getText', 'getHtml', 'click', 'type']
        const hasB = tools.some((t) => browserTools.includes(t))
        const hasC = tools.some((t) => !browserTools.includes(t))
        const icon = hasB && hasC ? '🔀' : hasB ? '🌐' : '💻'
        console.log(`\n  ${icon} Tools: ${tools.join(', ')}`)
      }
    },
  })

  try {
    const result = await agent.stream({
      prompt: `Do the following:
      1. Go to https://example.com and get the page title
      2. Use Python to format the title in uppercase
      3. Show me the result`,
    })

    console.log('Streaming combined response:')
    console.log('='.repeat(40))

    for await (const text of result.textStream) {
      process.stdout.write(text)
    }

    console.log('\n' + '='.repeat(40))

    const final = await result
    console.log(`\n✓ Completed in ${final.steps.length} steps`)

    // Usage summary
    console.log(`\n📊 Usage: ${final.usage?.inputTokens ?? 0} input, ${final.usage?.outputTokens ?? 0} output tokens`)
  } finally {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  }
}

/**
 * Main function to run all examples
 */
async function main() {
  console.log('📡 AI SDK v6 Streaming Examples')
  console.log('='.repeat(60))

  const examples = [
    { name: 'Basic', fn: basicTextStreamingExample },
    { name: 'Progress', fn: streamingWithProgressExample },
    { name: 'Browser', fn: browserStreamingExample },
    { name: 'Combined', fn: combinedToolsStreamingExample },
  ]

  // Run all examples or a specific one
  const exampleToRun = process.argv[2]

  if (exampleToRun) {
    const example = examples.find((ex) => ex.name.toLowerCase().includes(exampleToRun.toLowerCase()))
    if (example) {
      await example.fn()
    } else {
      console.error(`Example "${exampleToRun}" not found`)
      console.log('Available examples:', examples.map((ex) => ex.name).join(', '))
      process.exit(1)
    }
  } else {
    // Run all examples
    for (const example of examples) {
      try {
        await example.fn()
      } catch (error) {
        console.error(`\n❌ Error in ${example.name}:`, error)
      }
    }
  }

  console.log('\n✅ All streaming examples completed!')
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export {
  basicTextStreamingExample,
  streamingWithProgressExample,
  browserStreamingExample,
  combinedToolsStreamingExample,
}

/**
 * AI SDK v6 Agent with Browser Example
 *
 * This example demonstrates how to use the AI SDK v6 beta's new Agent API
 * with the AWS Bedrock AgentCore Browser tool for web automation.
 *
 * Prerequisites:
 * - AWS credentials configured (for Bedrock and Browser)
 * - Access to Claude Sonnet 4 on AWS Bedrock
 * - Node.js >= 20.0.0
 *
 * Run with: npx tsx examples/agent-with-browser.ts
 */

/// <reference types="node" />

import './setup.js'

import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { BrowserTools } from '../src/tools/browser/integrations/vercel-ai/index.js'

// Initialize Browser tools
const browser = new BrowserTools({
  region: process.env.AWS_REGION || 'us-west-2',
})

/**
 * Example 1: Basic Web Scraping Agent
 *
 * Navigates to a simple page and extracts content.
 */
async function basicWebScrapingExample() {
  console.log('\n=== Example 1: Basic Web Scraping ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Browse websites and extract information. Be concise.',
    tools: {
      navigate: browser.navigate,
      getText: browser.getText,
    },
    maxSteps: 4,
  })

  try {
    const result = await agent.generate({
      prompt: 'Go to https://example.com and tell me the main heading.',
    })

    console.log('Response:', result.text)
    console.log('\n✅ Example 1 completed')
  } catch (error) {
    handleError(error, 'Example 1')
  } finally {
    await browser.stopSession()
  }
}

/**
 * Example 2: Extract Page Details
 *
 * Gets more detailed information from a page.
 */
async function extractPageDetailsExample() {
  console.log('\n=== Example 2: Extract Page Details ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Extract information from web pages. Be brief.',
    tools: {
      navigate: browser.navigate,
      getText: browser.getText,
      evaluate: browser.evaluate,
    },
    maxSteps: 4,
  })

  try {
    const result = await agent.generate({
      prompt: 'Go to https://example.com, get the page title using JavaScript, and summarize in one sentence.',
    })

    console.log('Response:', result.text)
    console.log('\n✅ Example 2 completed')
  } catch (error) {
    handleError(error, 'Example 2')
  } finally {
    await browser.stopSession()
  }
}

/**
 * Example 3: Streaming Response
 *
 * Demonstrates streaming output while browsing.
 */
async function streamingExample() {
  console.log('\n=== Example 3: Streaming Browser Response ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Browse and describe pages briefly.',
    tools: {
      navigate: browser.navigate,
      getText: browser.getText,
    },
    maxSteps: 3,
  })

  try {
    const result = await agent.stream({
      prompt: 'Visit https://example.com and describe what you see in 2-3 sentences.',
    })

    process.stdout.write('Response: ')
    for await (const text of result.textStream) {
      process.stdout.write(text)
    }
    console.log('\n\n✅ Example 3 completed')
  } catch (error) {
    handleError(error, 'Example 3')
  } finally {
    await browser.stopSession()
  }
}

function handleError(error: unknown, exampleName: string) {
  if (error instanceof Error) {
    if (error.message.includes('Too many tokens') || error.message.includes('rate limit')) {
      console.error(`\n⚠️  ${exampleName}: Rate limit hit. Try running a single example:`)
      console.error('   npx tsx examples/agent-with-browser.ts basic')
    } else {
      console.error(`\n❌ ${exampleName} error:`, error.message.slice(0, 150))
    }
  } else {
    console.error(`\n❌ ${exampleName} error:`, error)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function main() {
  console.log('🌐 AI SDK v6 Agent + Browser Examples')
  console.log('='.repeat(50))
  console.log('\n💡 Run single example: npx tsx examples/agent-with-browser.ts basic\n')

  const examples = [
    { name: 'basic', desc: 'Basic Web Scraping', fn: basicWebScrapingExample },
    { name: 'details', desc: 'Extract Page Details', fn: extractPageDetailsExample },
    { name: 'stream', desc: 'Streaming Response', fn: streamingExample },
  ]

  const arg = process.argv[2]?.toLowerCase()

  if (arg) {
    const example = examples.find((ex) => ex.name.includes(arg))
    if (example) {
      await example.fn()
    } else {
      console.log('Available examples: basic, details, stream')
    }
  } else {
    // Run all with delays
    for (let i = 0; i < examples.length; i++) {
      await examples[i].fn()
      if (i < examples.length - 1) {
        console.log('\n⏳ Waiting 10 seconds...\n')
        await delay(10000)
      }
    }
  }

  console.log('\n✅ Done!')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export { basicWebScrapingExample, extractPageDetailsExample, streamingExample }

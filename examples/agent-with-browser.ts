/**
 * AI SDK v6 Agent with Browser Example
 *
 * This example demonstrates how to use the AI SDK v6 beta's new Agent API
 * with the AWS Bedrock AgentCore Browser tool for web automation.
 *
 * Features demonstrated:
 * - ToolLoopAgent with browser automation tools
 * - Web navigation, content extraction, and interaction
 * - Error handling and session management
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

// Initialize Browser tools - provides all browser automation and session management
const browser = new BrowserTools({
  region: process.env.AWS_REGION || 'us-west-2',
})

/**
 * Example 1: Basic Web Scraping Agent
 *
 * Creates an agent that can navigate to websites and extract information.
 */
async function basicWebScrapingExample() {
  console.log('\n=== Example 1: Basic Web Scraping Agent ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are a web research assistant with access to a browser.
    You can navigate to websites and extract information from them.
    Always describe what you find in a clear and organized way.`,
    tools: {
      navigate: browser.navigate,
      getText: browser.getText,
      getHtml: browser.getHtml,
    },
  })

  try {
    const result = await agent.generate({
      prompt: `Go to https://en.wikipedia.org/wiki/TypeScript and extract:
      1. The main title of the article
      2. The first paragraph describing what TypeScript is
      Provide a brief summary of what you found.`,
    })

    console.log('Agent Response:')
    console.log(result.text)
    console.log('\nCompleted in', result.steps.length, 'steps')
  } finally {
    await browser.stopSession()
  }
}

/**
 * Example 2: Interactive Web Agent
 *
 * Demonstrates an agent that can interact with web pages (click, type).
 */
async function interactiveWebExample() {
  console.log('\n=== Example 2: Interactive Web Agent ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are a web automation assistant that can navigate websites,
    click on elements, type into forms, and extract information.
    Describe each action you take.`,
    tools: browser.tools,
  })

  try {
    const result = await agent.generate({
      prompt: `Go to Wikipedia's main page (https://www.wikipedia.org).
      Find and use the search functionality to look up "Rust programming language".
      Then extract the first paragraph from the search result article.`,
    })

    console.log('Agent Response:')
    console.log(result.text)
    console.log('\nCompleted in', result.steps.length, 'steps')
  } finally {
    await browser.stopSession()
  }
}

/**
 * Example 3: Streaming Web Research
 *
 * Demonstrates streaming output while the agent browses the web.
 */
async function streamingWebResearchExample() {
  console.log('\n=== Example 3: Streaming Web Research ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are a research assistant that browses the web to gather information.
    Explain your research process as you go.`,
    tools: browser.tools,
  })

  try {
    const result = await agent.stream({
      prompt: `Research the Node.js runtime by visiting its Wikipedia page
      (https://en.wikipedia.org/wiki/Node.js).
      Extract key information about:
      1. What Node.js is
      2. When it was created
      3. Who created it
      Summarize your findings.`,
    })

    console.log('Streaming Response:')
    console.log('-'.repeat(50))

    for await (const textPart of result.textStream) {
      process.stdout.write(textPart)
    }

    console.log('\n' + '-'.repeat(50))

    const finalResult = await result
    console.log('\n📊 Completed in', finalResult.steps.length, 'steps')
  } finally {
    await browser.stopSession()
  }
}

/**
 * Main function to run all examples
 */
async function main() {
  console.log('🌐 AI SDK v6 Agent + Browser Examples')
  console.log('='.repeat(60))

  const examples = [
    { name: 'Basic Scraping', fn: basicWebScrapingExample },
    { name: 'Interactive', fn: interactiveWebExample },
    { name: 'Streaming', fn: streamingWebResearchExample },
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

  console.log('\n✅ All examples completed!')
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export { basicWebScrapingExample, interactiveWebExample, streamingWebResearchExample }

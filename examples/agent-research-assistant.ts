/**
 * AI SDK v6 Research Assistant Agent
 *
 * A real research assistant that combines web browsing and code analysis
 * to conduct actual research tasks.
 *
 * Run with: npx tsx examples/agent-research-assistant.ts
 */

/// <reference types="node" />

import './setup.js'

import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { CodeInterpreterTools } from '../src/tools/code-interpreter/integrations/vercel-ai/index.js'
import { BrowserTools } from '../src/tools/browser/integrations/vercel-ai/index.js'

const codeInterpreter = new CodeInterpreterTools({
  region: process.env.AWS_REGION || 'us-west-2',
})

const browser = new BrowserTools({
  region: process.env.AWS_REGION || 'us-west-2',
})

const allTools = {
  ...codeInterpreter.tools,
  ...browser.tools,
}

/**
 * Example 1: Wikipedia Research with Data Extraction
 */
async function wikipediaResearchExample() {
  console.log('\n=== Example 1: Wikipedia Research with Data Extraction ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Research topics by browsing Wikipedia and analyzing data with Python.',
    tools: allTools,
    maxSteps: 8,
  })

  try {
    const result = await agent.generate({
      prompt: `Research the Fibonacci sequence:
1. Go to https://en.wikipedia.org/wiki/Fibonacci_sequence
2. Extract the definition and first 10 numbers
3. Use Python to verify the sequence is correct by computing it
4. Save your findings to a file called fibonacci_research.txt`,
    })

    console.log(result.text)
    console.log('\n✅ Example 1 completed')
  } catch (error) {
    handleError(error, 'Example 1')
  } finally {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  }
}

/**
 * Example 2: Programming Language Comparison
 */
async function languageComparisonExample() {
  console.log('\n=== Example 2: Programming Language Comparison ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Research programming languages and create comparison reports.',
    tools: allTools,
    maxSteps: 10,
  })

  try {
    const result = await agent.generate({
      prompt: `Compare Python and JavaScript:
1. Visit their Wikipedia pages
2. Extract: release year, creator, and main use case for each
3. Use Python to create a comparison table (CSV format)
4. Save the table to languages_comparison.csv`,
    })

    console.log(result.text)
    console.log('\n✅ Example 2 completed')
  } catch (error) {
    handleError(error, 'Example 2')
  } finally {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  }
}

/**
 * Example 3: Live Data Analysis
 */
async function liveDataAnalysisExample() {
  console.log('\n=== Example 3: Live Web Data Analysis ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Scrape web data and perform statistical analysis.',
    tools: allTools,
    maxSteps: 8,
  })

  try {
    const result = await agent.generate({
      prompt: `Analyze Example.com:
1. Navigate to https://example.com
2. Extract all text content from the page
3. Use Python to:
   - Count total words
   - Find the 5 most common words
   - Calculate average word length
4. Present findings in a structured format`,
    })

    console.log(result.text)
    console.log('\n✅ Example 3 completed')
  } catch (error) {
    handleError(error, 'Example 3')
  } finally {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  }
}

/**
 * Example 4: Data Pipeline Demo
 */
async function dataPipelineExample() {
  console.log('\n=== Example 4: Web Scraping Data Pipeline ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('us.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: 'Build data pipelines: scrape → process → analyze → report.',
    tools: allTools,
    maxSteps: 10,
  })

  try {
    const result = await agent.generate({
      prompt: `Build a mini data pipeline:
1. Visit https://example.com
2. Scrape the page title and main heading
3. Create a JSON file with: {url, title, heading, scraped_at: timestamp}
4. Read the JSON back and verify the data
5. Generate a summary report`,
    })

    console.log(result.text)
    console.log('\n✅ Example 4 completed')
  } catch (error) {
    handleError(error, 'Example 4')
  } finally {
    await Promise.all([codeInterpreter.stopSession(), browser.stopSession()])
  }
}

function handleError(error: unknown, exampleName: string) {
  if (error instanceof Error) {
    if (error.message.includes('Too many tokens') || error.message.includes('rate limit')) {
      console.error(`\n⚠️  ${exampleName}: Rate limit hit. Wait 60 seconds and try again.`)
      console.error('   Run single example: npx tsx examples/agent-research-assistant.ts "example1"')
    } else if (error.message.includes('too long')) {
      console.error(`\n⚠️  ${exampleName}: Input too long.`)
    } else {
      console.error(`\n❌ ${exampleName} failed:`, error.message.slice(0, 200))
    }
  } else {
    console.error(`\n❌ ${exampleName} failed:`, error)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

async function main() {
  console.log('🔬 AI SDK v6 Research Assistant Agent')
  console.log('     Real-world research tasks with Browser + CodeInterpreter')
  console.log('='.repeat(70))
  console.log('\n💡 Tip: Run one example at a time to avoid rate limits:')
  console.log('   npx tsx examples/agent-research-assistant.ts "example1"')
  console.log('   npx tsx examples/agent-research-assistant.ts "example2"\n')

  const examples = [
    { name: 'Example1', desc: 'Wikipedia Research', fn: wikipediaResearchExample },
    { name: 'Example2', desc: 'Language Comparison', fn: languageComparisonExample },
    { name: 'Example3', desc: 'Data Analysis', fn: liveDataAnalysisExample },
    { name: 'Example4', desc: 'Data Pipeline', fn: dataPipelineExample },
  ]

  const exampleToRun = process.argv[2]?.toLowerCase()

  if (exampleToRun) {
    const example = examples.find((ex) => ex.name.toLowerCase().includes(exampleToRun))
    if (example) {
      console.log(`\n🚀 Running: ${example.desc}\n`)
      await example.fn()
    } else {
      console.error(`❌ Example "${exampleToRun}" not found`)
      console.log('\nAvailable:')
      examples.forEach((ex) => console.log(`  - ${ex.name}: ${ex.desc}`))
      process.exit(1)
    }
  } else {
    console.log('⚠️  Running all examples with 15-second delays between them...\n')

    for (let i = 0; i < examples.length; i++) {
      const example = examples[i]
      console.log(`\n[${i + 1}/${examples.length}] ${example.desc}`)

      try {
        await example.fn()
      } catch (error) {
        console.error(`Failed: ${error}`)
      }

      if (i < examples.length - 1) {
        console.log('\n⏳ Waiting 15 seconds to avoid rate limits...')
        await delay(15000)
      }
    }
  }

  console.log('\n' + '='.repeat(70))
  console.log('✅ All requested examples completed!')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error)
}

export { wikipediaResearchExample, languageComparisonExample, liveDataAnalysisExample, dataPipelineExample }

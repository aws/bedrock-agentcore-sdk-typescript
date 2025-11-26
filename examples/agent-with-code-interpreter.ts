/**
 * AI SDK v6 Agent with CodeInterpreter Example
 *
 * This example demonstrates how to use the AI SDK v6 beta's new Agent API
 * with the AWS Bedrock AgentCore CodeInterpreter tool.
 *
 * Features demonstrated:
 * - ToolLoopAgent with automatic tool execution loop
 * - CodeInterpreter integration as a tool
 * - Error handling and session management
 *
 * Prerequisites:
 * - AWS credentials configured (for Bedrock and CodeInterpreter)
 * - Access to Claude Sonnet 4 on AWS Bedrock
 * - Node.js >= 20.0.0
 *
 * Run with: tsx examples/agent-with-code-interpreter.ts
 */

/// <reference types="node" />
import './setup.js'

import { ToolLoopAgent } from 'ai'
import { bedrock } from '@ai-sdk/amazon-bedrock'
import { CodeInterpreterTools } from '../src/tools/code-interpreter/integrations/vercel-ai/index.js'

// Initialize CodeInterpreter tools - provides all tools and session management
const codeInterpreter = new CodeInterpreterTools({
  region: process.env.AWS_REGION || 'us-west-2',
})

/**
 * Example 1: Basic Agent with CodeInterpreter
 *
 * Creates an agent that can execute Python code to solve problems.
 */
async function basicAgentExample() {
  console.log('\n=== Example 1: Basic Agent with CodeInterpreter ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are a helpful coding assistant with access to a Python code interpreter.
    When asked to solve problems, write and execute Python code to find the answer.
    Always show your work and explain the results.`,
    tools: {
      executeCode: codeInterpreter.executeCode,
    },
    // Enable detailed logging of agent steps
    onStepFinish: (step) => {
      console.log('\n[Agent Step]:', JSON.stringify(step, null, 2).substring(0, 500))
    },
  })

  try {
    const result = await agent.generate({
      prompt: 'Calculate the first 10 Fibonacci numbers and find their sum. Show the calculation.',
    })

    console.log('\n[Final Agent Response]:')
    console.log(result.text)
    console.log('\n[Steps taken]:', result.steps.length)
  } finally {
    // Clean up the default session (gracefully handles non-existent sessions)
    await codeInterpreter.stopSession()
  }
}

/**
 * Example 2: Agent with File Operations
 *
 * Demonstrates an agent that can manage files and execute code that uses those files.
 */
async function fileOperationsExample() {
  console.log('\n=== Example 2: Agent with File Operations ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are a data processing assistant that can work with files.
    You can write data to files, read them, and process them with Python code.`,
    tools: {
      executeCode: codeInterpreter.executeCode,
      fileOps: codeInterpreter.fileOperations,
    },
  })

  try {
    const result = await agent.generate({
      prompt: `Create a CSV file called 'sales_data.csv' with sample monthly sales data (6 months),
      then read it and calculate the total sales and average. Show the results in a clear format.`,
    })

    console.log('Agent Response:')
    console.log(result.text)
    console.log('\nCompleted in', result.steps.length, 'steps')
  } finally {
    await codeInterpreter.stopSession()
  }
}

/**
 * Example 3: Complex Data Analysis Agent
 *
 * Demonstrates a more sophisticated agent that performs multi-step data analysis.
 */
async function complexAnalysisExample() {
  console.log('\n=== Example 3: Complex Data Analysis ===\n')

  const agent = new ToolLoopAgent({
    model: bedrock('global.anthropic.claude-sonnet-4-20250514-v1:0'),
    instructions: `You are an expert data scientist with access to Python and file operations.
    Break down complex problems into steps, execute code to analyze data, and provide insights.`,
    tools: {
      executeCode: codeInterpreter.executeCode,
      fileOps: codeInterpreter.fileOperations,
    },
  })

  try {
    const result = await agent.generate({
      prompt: `Analyze this scenario: A company has quarterly revenue data:
      Q1: $125,000, Q2: $150,000, Q3: $175,000, Q4: $200,000

      1. Calculate the total annual revenue
      2. Find the quarter-over-quarter growth rates
      3. Calculate the average quarterly revenue
      4. Determine if the company is on track to reach $1M in annual revenue within 5 years
         assuming the average growth rate continues

      Present your findings with clear explanations.`,
    })

    console.log('Analysis Result:')
    console.log(result.text)
    console.log('\n📊 Analysis completed in', result.steps.length, 'steps')
  } finally {
    await codeInterpreter.stopSession()
  }
}

/**
 * Main function to run all examples
 */
async function main() {
  console.log('🤖 AI SDK v6 Agent + CodeInterpreter Examples')
  console.log('='.repeat(60))

  const examples = [
    { name: 'Basic Agent', fn: basicAgentExample },
    { name: 'File Operations', fn: fileOperationsExample },
    { name: 'Complex Analysis', fn: complexAnalysisExample },
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

export { basicAgentExample, fileOperationsExample, complexAnalysisExample }

# Agent Development Guide - AWS Bedrock AgentCore TypeScript SDK

This document provides guidance specifically for AI agents working on the AWS Bedrock AgentCore TypeScript SDK codebase. For human contributor guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Purpose and Scope

**AGENTS.md** contains agent-specific repository information including:
- Directory structure with summaries of what is included in each directory
- Development workflow instructions for agents to follow when developing features
- Coding patterns and testing patterns to follow when writing code
- Style guidelines, organizational patterns, and best practices

**For human contributors**: See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and contribution guidelines.

## Directory Structure

```
bedrock-agentcore-sdk-typescript/
├── .github/                      # GitHub Actions workflows and templates
│   ├── ISSUE_TEMPLATE/           # GitHub issue templates
│   │   ├── bug_report.md         # Bug report template
│   │   ├── custom.md             # Custom issue template
│   │   └── feature_request.md    # Feature request template
│   ├── workflows/                # CI/CD workflow definitions
│   │   ├── integration-testing.yml  # Integration test workflow
│   │   ├── pr-automerge.yml      # Auto-merge workflow for PRs
│   │   ├── pr-validation.yml     # PR validation checks
│   │   ├── release.yml           # Release automation workflow
│   │   └── security-scanning.yml # Security scanning workflow
│   ├── dependabot.yml            # Dependabot configuration
│   └── labeler.yml               # Auto-labeling configuration
│
├── .husky/                       # Git hooks (pre-commit checks)
│   └── pre-commit                # Pre-commit hook script
│
├── docs/                         # Documentation files
│   ├── PR.md                     # Pull request guidelines and template
│   └── TESTING.md                # Comprehensive testing guidelines
│
├── src/                          # Source code (all production code)
│   └── tools/                    # Tool definitions and types
│       ├── browser/              # Browser automation tool
│       │   ├── __tests__/        # Unit tests for browser tool
│       │   ├── integrations/     # Framework-specific integrations
│       │   ├── client.ts         # Browser client implementation
│       │   ├── index.ts          # Browser tool exports
│       │   └── types.ts          # Browser tool type definitions
│       └── code-interpreter/     # Code interpreter tool
│           ├── __tests__/        # Unit tests for code interpreter
│           ├── integrations/     # Framework-specific integrations
│           ├── client.ts         # Code interpreter client implementation
│           ├── index.ts          # Code interpreter exports
│           └── types.ts          # Code interpreter type definitions
│
├── examples/                     # Example applications and usage demos
│   ├── deep-research-ui/         # Next.js UI for deep research workflows
│   │   ├── app/                  # Next.js app directory structure
│   │   │   ├── api/              # API route handlers
│   │   │   ├── deep-research/    # Deep research page components
│   │   │   ├── globals.css       # Global CSS styles
│   │   │   └── layout.tsx        # Root layout component
│   │   ├── lib/                  # Utility libraries and helpers
│   │   │   └── agents/           # Agent-related utilities
│   │   ├── example_com_screenshot.png  # Example screenshot
│   │   ├── hackernews_homepage.png     # HackerNews homepage screenshot
│   │   ├── next-env.d.ts         # Next.js TypeScript declarations
│   │   ├── next.config.ts        # Next.js configuration
│   │   ├── package-lock.json     # UI dependency lock file
│   │   ├── package.json          # UI dependencies and scripts
│   │   ├── postcss.config.mjs    # PostCSS configuration
│   │   ├── README.md             # UI setup and usage instructions
│   │   ├── tailwind.config.ts    # Tailwind CSS configuration
│   │   └── tsconfig.json         # TypeScript config for UI
│   ├── agent-research-assistant.ts  # Research assistant example
│   ├── agent-with-browser.ts     # Browser integration example
│   ├── agent-with-code-interpreter.ts  # Code interpreter example
│   ├── README.md                 # Examples overview and setup
│   ├── setup.js                  # Example setup utilities
│   └── streaming-examples.ts     # Streaming usage examples
│
├── scripts/                      # Build and utility scripts
│   └── bump-version.ts           # Version bumping script
│
├── test-package/                 # Test package for verification
│   ├── package-lock.json         # Test package dependency lock file
│   ├── package.json              # Test package dependencies
│   ├── README.md                 # Test package documentation
│   └── verify.js                 # Verification script
│
├── tests_integ/                  # Integration tests
│   ├── browser.test.ts           # Browser integration tests
│   ├── code-interpreter.test.ts  # Code interpreter integration tests
│   ├── setup.ts                  # Test setup utilities and helpers
│   └── vercel-ai-agent.test.ts   # Vercel AI integration tests
│
├── .gitattributes                # Git attributes configuration
├── .gitignore                    # Git ignore rules
├── .node-version                 # Node.js version specification
├── .prettierrc                   # Code formatting configuration
├── AGENTS.md                     # Agent development guidance (legacy)
├── AGENTS_1.md                   # This file (current agent guidance)
├── AGENTS_1_OLD_DIRECTORY_STRUCTURE.md  # Previous directory structure backup
├── CHANGELOG.md                  # Version history and changes
├── CODE_OF_CONDUCT.md            # Community guidelines and conduct rules
├── CONTRIBUTING.md               # Human contributor guidelines and setup
├── eslint.config.js              # ESLint linting configuration
├── LICENSE                       # License information (Apache 2.0)
├── NOTICE                        # Legal notices and attributions
├── package.json                  # Project configuration and dependencies
├── package-lock.json             # Dependency lock file
├── README.md                     # Project overview and usage guide
├── SECURITY.md                   # Security policy and vulnerability reporting
├── tsconfig.json                 # TypeScript compiler configuration
└── vitest.config.ts              # Vitest testing framework configuration
```

### Directory Purposes

- **`.github/`**: GitHub Actions workflows, issue templates, and CI/CD automation
- **`.github/ISSUE_TEMPLATE/`**: Standardized templates for bug reports, feature requests, and custom issues
- **`.github/workflows/`**: Automated workflows for testing, validation, releases, and security scanning
- **`.husky/`**: Git hooks for pre-commit quality checks and validation
- **`docs/`**: Comprehensive documentation for development processes and guidelines
- **`src/`**: All production source code for the SDK
- **`src/tools/`**: Tool definitions and implementations for browser automation and code interpretation
- **`src/tools/browser/`**: Browser automation client with AWS Bedrock integration
- **`src/tools/code-interpreter/`**: Code execution client with sandboxed environment support
- **`examples/`**: Example applications and usage demonstrations for different use cases
- **`examples/deep-research-ui/`**: Complete Next.js UI application showcasing deep research workflows
- **`examples/deep-research-ui/app/`**: Next.js app router structure with API routes and page components
- **`examples/deep-research-ui/lib/`**: Utility libraries and agent-related helper functions
- **`scripts/`**: Build and utility scripts for development and release automation
- **`test-package/`**: Standalone test package for SDK verification and validation
- **`tests_integ/`**: Integration tests that validate public API and external service integrations

**IMPORTANT**: After making changes that affect the directory structure (adding new directories, moving files, or adding significant new files), you MUST update this directory structure section to reflect the current state of the repository.


## Architecture Overview

### Three-Layer Architecture

The SDK follows a layered integration pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER APPLICATION                              │
│  (Using Vercel AI, LangChain, LlamaIndex, or custom framework)  │
└──────────────────────────────┬──────────────────────────────────┘
                               │ imports
                               │
┌──────────────────────────────▼──────────────────────────────────┐
│          INTEGRATION LAYER (Framework-Specific)                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │  Vercel AI     │  │  LangChain     │  │  LlamaIndex    │   │
│  │  Integration   │  │  Integration   │  │  Integration   │   │
│  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘   │
│           │                   │                   │             │
│           │ wraps             │ wraps             │ wraps       │
│           ▼                   ▼                   ▼             │
│  ┌────────────────────────────────────────────────────────┐    │
│  │         BASE CLIENT LAYER (Framework-Agnostic)         │    │
│  │  • BrowserClient                                       │    │
│  │  • CodeInterpreterClient                               │    │
│  │  • MemoryClient (future)                               │    │
│  └────────────────────┬───────────────────────────────────┘    │
└───────────────────────┼────────────────────────────────────────┘
                        │ uses
                        │
┌───────────────────────▼────────────────────────────────────────┐
│                    AWS SDK LAYER                                │
│  • @aws-sdk/client-bedrock-agent-runtime                        │
│  • @aws-sdk/client-bedrock-agentcore                            │
└─────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Base clients are framework-agnostic**: Can be used directly or wrapped
2. **Integrations translate**: Convert between framework types and AWS types
3. **Clear separation**: Each framework gets its own subdirectory
4. **Testability**: Mock at client layer, not AWS SDK layer

## Development Workflow for Agents

### 1. Environment Setup

See [CONTRIBUTING.md - Development Environment](CONTRIBUTING.md#development-environment) for:
- Prerequisites (Node.js 20+, npm)
- Installation steps
- Verification commands

### 2. Making Changes

1. **Create feature branch**: `git checkout -b agent-tasks/{ISSUE_NUMBER}`
2. **Implement changes** following the patterns below
3. **Run quality checks** before committing (pre-commit hooks will run automatically)
4. **Commit with conventional commits**: `feat:`, `fix:`, `refactor:`, `docs:`, etc.
5. **Push to remote**: `git push origin agent-tasks/{ISSUE_NUMBER}`
6. **Create pull request** following [PR.md](docs/PR.md) guidelines

### 3. Pull Request Guidelines

When creating pull requests, you **MUST** follow the guidelines in [PR.md](docs/PR.md). Key principles:

- **Focus on WHY**: Explain motivation and user impact, not implementation details
- **Document public API changes**: Show before/after code examples
- **Be concise**: Use prose over bullet lists; avoid exhaustive checklists
- **Target senior engineers**: Assume familiarity with the SDK
- **Exclude implementation details**: Leave these to code comments and diffs

See [PR.md](docs/PR.md) for the complete guidance and template.

### 4. Quality Gates

Pre-commit hooks automatically run:
- Unit tests (via npm test)
- Linting (via npm run lint)
- Format checking (via npm run format:check)
- Type checking (via npm run type-check)

All checks must pass before commit is allowed.

### 5. Testing Guidelines

When writing tests, you **MUST** follow the guidelines in [docs/TESTING.md](docs/TESTING.md). Key topics covered:

- Test organization and file location
- Test batching strategy
- Object assertion best practices
- Test coverage requirements
- Multi-environment testing (Node.js and browser)

See [TESTING.md](docs/TESTING.md) for the complete testing reference.

## Coding Patterns and Best Practices

### Logging Style Guide

The SDK uses a structured logging format consistent with the Python SDK for better log parsing and searchability.

**Format**:
```typescript
// With context fields
logger.warn(`field1=<${value1}>, field2=<${value2}> | human readable message`)

// Without context fields
logger.warn('human readable message')

// Multiple statements in message (use pipe to separate)
logger.warn(`field=<${value}> | statement one | statement two`)
```

**Guidelines**:

1. **Context Fields** (when relevant):
   - Add context as `field=<value>` pairs at the beginning
   - Use commas to separate pairs
   - Enclose values in `<>` for readability (especially helpful for empty values: `field=<>`)
   - Use template literals for string interpolation

2. **Messages**:
   - Add human-readable messages after context fields
   - Use lowercase for consistency
   - Avoid punctuation (periods, exclamation points) to reduce clutter
   - Keep messages concise and focused on a single statement
   - If multiple statements are needed, separate them with pipe character (`|`)

**Examples**:

```typescript
// ✅ Good: Context fields with message
logger.warn(`stop_reason=<${stopReason}>, fallback=<${fallback}> | unknown stop reason, converting to camelCase`)
logger.warn(`event_type=<${eventType}> | unsupported bedrock event type`)

// ✅ Good: Simple message without context fields
logger.warn('cache points are not supported in openai system prompts, ignoring cache points')

// ✅ Good: Multiple statements separated by pipes
logger.warn(`request_id=<${id}> | processing request | starting validation`)

// ❌ Bad: Not using angle brackets for values
logger.warn(`stop_reason=${stopReason} | unknown stop reason`)

// ❌ Bad: Using punctuation
logger.warn(`event_type=<${eventType}> | Unsupported event type.`)
```



### File Organization Pattern

**For source files**:
```
src/
├── module.ts              # Source file
└── __tests__/
    └── module.test.ts     # Unit tests co-located
```

**Function ordering within files**:
- Functions MUST be ordered from most general to most specific (top-down reading)
- Public/exported functions MUST appear before private helper functions
- Main entry point functions MUST be at the top of the file
- Helper functions SHOULD follow in order of their usage

**Example**:
```typescript
// ✅ Good: Main function first, helpers follow
export async function* mainFunction() {
  const result = await helperFunction1()
  return helperFunction2(result)
}

async function helperFunction1() {
  // Implementation
}

function helperFunction2(input: string) {
  // Implementation
}

// ❌ Bad: Helpers before main function
async function helperFunction1() {
  // Implementation
}

export async function* mainFunction() {
  const result = await helperFunction1()
  return helperFunction2(result)
}
```

**For integration tests**:
```
test/integ/
└── feature.test.ts        # Tests public API
```

**Class structure ordering**:

Within a class, organize members in this specific order:

```typescript
export class ExampleClient {
  // 1. Private fields
  private readonly _config: Config
  private _sessions: Map<string, SessionInfo> = new Map()

  // 2. Constructor
  constructor(config: Config) {
    this._config = config
  }

  // 3. Public methods (ordered from general to specific)
  async startSession(params: StartSessionParams): Promise<SessionInfo> {
    // Implementation
  }

  async navigate(params: NavigateParams): Promise<ActionResult> {
    // Implementation
  }

  async click(params: ClickParams): Promise<ActionResult> {
    // Implementation
  }

  // 4. Private methods (ordered from general to specific)
  private _getSession(sessionName: string): SessionInfo {
    // Implementation
  }

  private _generateSessionName(): string {
    // Implementation
  }
}
```

**Rules**:
- Private fields come first
- Constructor follows private fields
- Public methods ordered from general to specific operations
- Private methods come last, also ordered from general to specific
- Static methods (if any) come after private methods

### TypeScript Type Safety

**Strict requirements**:
```typescript
// Good: Explicit return types
export function process(input: string): string {
  return input.toUpperCase()
}

// Bad: No return type
export function process(input: string) {
  return input.toUpperCase()
}

// Good: Proper typing
export function getData(): { id: number; name: string } {
  return { id: 1, name: 'test' }
}

// Bad: Using any
export function getData(): any {
  return { id: 1, name: 'test' }
}
```

**Rules**:
- Always provide explicit return types
- Never use `any` type (enforced by ESLint)
- Use TypeScript strict mode features
- Leverage type inference where appropriate

### Class Field Naming Conventions

**Private fields**: Use underscore prefix for private class fields to improve readability and distinguish them from public members.

```typescript
// ✅ Good: Private fields with underscore prefix
export class Example {
  private readonly _config: Config
  private _state: State

  constructor(config: Config) {
    this._config = config
    this._state = { initialized: false }
  }

  public getConfig(): Config {
    return this._config
  }
}

// ❌ Bad: No underscore for private fields
export class Example {
  private readonly config: Config  // Missing underscore

  constructor(config: Config) {
    this.config = config
  }
}
```

**Rules**:
- Private fields MUST use underscore prefix (e.g., `_field`)
- Public fields MUST NOT use underscore prefix
- This convention improves code readability and makes the distinction between public and private members immediately visible

### 

**Use camelCase for variables, functions, and object properties**:

```typescript
// ✅ Good: camelCase for variables and functions
const sessionName = params?.sessionName ?? DEFAULT_SESSION_NAME
const interpreterId = params?.interpreterId ?? this.identifier
let contentStr = ''

async function executeCode(params: ExecuteCodeParams): Promise<string> {
  const command = new InvokeCodeInterpreterCommand({
    codeInterpreterIdentifier: this.identifier,
    sessionId: this._session!.sessionId,
  })
  return result
}

// Object properties
const sessionInfo: SessionInfo = {
  sessionName,
  sessionId: response.sessionId!,
  createdAt: response.createdAt!,
}
```

**Use SCREAMING_SNAKE_CASE for constants**:

```typescript
// ✅ Good: Constants in SCREAMING_SNAKE_CASE
export const DEFAULT_IDENTIFIER = 'aws.browser.v1'
export const DEFAULT_SESSION_NAME = 'default'
export const DEFAULT_TIMEOUT = 3600
export const DEFAULT_REGION = 'us-west-2'
```

**Use PascalCase for classes, interfaces, and types**:

```typescript
// ✅ Good: PascalCase for types
export class CodeInterpreter { }
interface SessionInfo { }
type ExecuteCodeParams = { }
```

**Rules**:
- Variables, functions, and object properties MUST use camelCase
- Constants MUST use SCREAMING_SNAKE_CASE
- Classes, interfaces, and types MUST use PascalCase
- Private methods MUST use underscore prefix with camelCase (e.g., `_handleInvocation`)

### Documentation Requirements

**TSDoc format** (required for all exported functions):

```typescript
/**
 * Brief description of what the function does.
 * 
 * @param paramName - Description of the parameter
 * @param optionalParam - Description of optional parameter
 * @returns Description of what is returned
 * 
 * @example
 * ```typescript
 * const result = functionName('input')
 * console.log(result) // "output"
 * ```
 */
export function functionName(paramName: string, optionalParam?: number): string {
  // Implementation
}
```

**Interface property documentation**:

```typescript
/**
 * Interface description.
 */
export interface MyConfig {
  /**
   * Single-line description of the property.
   */
  propertyName: string

  /**
   * Single-line description with optional reference link.
   * @see https://docs.example.com/property-details
   */
  anotherProperty?: number
}
```

**Requirements**:
- All exported functions, classes, and interfaces must have TSDoc
- Include `@param` for all parameters
- Include `@returns` for return values
- Include `@example` only for exported classes (main SDK entry points like BedrockModel, Agent)
- Do NOT include `@example` for type definitions, interfaces, or internal types
- Interface properties MUST have single-line descriptions
- Interface properties MAY include an optional `@see` link for additional details
- TSDoc validation enforced by ESLint

### Code Style Guidelines

**Formatting** (enforced by Prettier):
- No semicolons
- Single quotes
- Line length: 120 characters
- Tab width: 2 spaces
- Trailing commas in ES5 style

**Example**:
```typescript
export function example(name: string, options?: Options): Result {
  const config = {
    name,
    enabled: true,
    settings: {
      timeout: 5000,
      retries: 3,
    },
  }

  return processConfig(config)
}
```

### Async/Await Standards

**Always use async/await**, never raw Promises:

```typescript
// ✅ Good: Use async/await
async function startSession(params: StartSessionParams): Promise<SessionInfo> {
  const response = await this._client.send(new StartSessionCommand(params))
  return { sessionId: response.sessionId! }
}

// ❌ Bad: Raw Promises
function startSession(params: StartSessionParams): Promise<SessionInfo> {
  return this._client.send(new StartSessionCommand(params))
    .then(response => ({ sessionId: response.sessionId! }))
}
```

**Rules**:
- All asynchronous operations must use async/await syntax
- Avoid Promise chains (.then(), .catch()) in favor of try/catch blocks
- This improves readability and makes error handling more consistent

### Import Organization

**Always use relative imports for internal modules** and organize imports in this order:

```typescript
// 1. External dependencies
import { something } from 'external-package'
import { z } from 'zod'

// 2. Internal modules (using relative paths)
import { Agent } from '../agent'
import { Tool } from '../tools'
import { hello } from './hello'

// 3. Types (if separate)
import type { Options, Config } from '../types'
```

**Rules**:
- External dependencies come first
- Internal modules use relative paths (`./` or `../`)
- Type-only imports come last (when separated from value imports)
- Group related imports together within each section

### Interface and Type Organization

**When defining interfaces or types, organize them so the top-level interface comes first, followed by its dependencies, and then all nested dependencies.**

```typescript
// ✅ Correct - Top-level first, then dependencies
export interface Message {
  role: Role
  content: ContentBlock[]
}

export type Role = 'user' | 'assistant'

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export class TextBlock {
  readonly type = 'textBlock' as const
  readonly text: string
  constructor(data: { text: string }) { this.text = data.text }
}

export class ToolUseBlock {
  readonly type = 'toolUseBlock' as const
  readonly name: string
  readonly toolUseId: string
  readonly input: JSONValue
  constructor(data: { name: string; toolUseId: string; input: JSONValue }) {
    this.name = data.name
    this.toolUseId = data.toolUseId
    this.input = data.input
  }
}

export class ToolResultBlock {
  readonly type = 'toolResultBlock' as const
  readonly toolUseId: string
  readonly status: 'success' | 'error'
  readonly content: ToolResultContent[]
  constructor(data: { toolUseId: string; status: 'success' | 'error'; content: ToolResultContent[] }) {
    this.toolUseId = data.toolUseId
    this.status = data.status
    this.content = data.content
  }
}

// ❌ Wrong - Dependencies before top-level
export type Role = 'user' | 'assistant'

export interface TextBlockData {
  text: string
}

export interface Message {  // Top-level should come first
  role: Role
  content: ContentBlock[]
}
```

**Rationale**: This ordering makes files more readable by providing an overview first, then details.

### Discriminated Union Naming Convention

**When creating discriminated unions with a `type` field, the type value MUST match the interface name with the first letter lowercase.**

```typescript
// ✅ Correct - type matches class name (first letter lowercase)
export class TextBlock {
  readonly type = 'textBlock' as const  // Matches 'TextBlock' class name
  readonly text: string
  constructor(data: { text: string }) { this.text = data.text }
}

export class CachePointBlock {
  readonly type = 'cachePointBlock' as const  // Matches 'CachePointBlock' class name
  readonly cacheType: 'default'
  constructor(data: { cacheType: 'default' }) { this.cacheType = data.cacheType }
}

export type ContentBlock = TextBlock | ToolUseBlock | CachePointBlock

// ❌ Wrong - type doesn't match class name
export class CachePointBlock {
  readonly type = 'cachePoint' as const  // Should be 'cachePointBlock'
  readonly cacheType: 'default'
}
```

**Rationale**: This consistent naming makes discriminated unions predictable and improves code readability. Developers can easily understand the relationship between the type value and the class.

### Error Handling

#### Error Creation

Use descriptive error messages with context:

```typescript
// ✅ Good: Descriptive error with context
private _getSession(sessionName: string): BrowserSessionInfo {
  const session = this._sessions.get(sessionName)
  if (!session) {
    throw new Error(
      `Session '${sessionName}' not found. Call startSession() first. ` +
      `Active sessions: ${Array.from(this._sessions.keys()).join(', ')}`
    )
  }
  return session
}

// ❌ Bad: Generic error without context
private _getSession(sessionName: string): BrowserSessionInfo {
  const session = this._sessions.get(sessionName)
  if (!session) {
    throw new Error('Session not found')
  }
  return session
}
```

#### Error Handling in Client Methods

**Catch AWS SDK errors and translate to user-friendly messages**:

```typescript
async navigate(params: NavigateParams): Promise<ActionResult> {
  const session = this._getSession(params.sessionName)

  try {
    await this._dataPlaneClient.send(
      new InvokeBrowserActionCommand({
        sessionId: session.sessionId,
        action: 'navigate',
        parameters: {
          url: params.url,
          waitUntil: params.waitUntil || 'load',
        },
      })
    )

    return { success: true }
  } catch (error) {
    // Translate AWS SDK errors to user-friendly messages
    let errorMessage = 'Unknown error'

    if (error instanceof Error) {
      // Extract meaningful error message
      if (error.name === 'ResourceNotFoundException') {
        errorMessage = `Browser session not found: ${params.sessionName}`
      } else if (error.name === 'TimeoutException') {
        errorMessage = `Navigation to ${params.url} timed out`
      } else {
        errorMessage = error.message
      }
    }

    return {
      success: false,
      error: errorMessage,
    }
  }
}
```

#### Basic Error Patterns

```typescript
// Good: Explicit error handling
export function process(input: string): string {
  if (!input) {
    throw new Error('Input cannot be empty')
  }
  return input.trim()
}

// Good: Custom error types
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
```

## Things to Do

✅ **Do**:
- Use relative imports for internal modules
- Co-locate unit tests with source under `__tests__` directories
- Follow nested describe pattern for test organization
- Write explicit return types for all functions
- Document all exported functions with TSDoc
- Use meaningful variable and function names
- Keep functions small and focused (single responsibility)
- Use async/await for asynchronous operations
- Handle errors explicitly

## Things NOT to Do

❌ **Don't**:
- Use `any` type (enforced by ESLint)
- Put unit tests in separate `tests/` directory (use `src/**/__tests__/**`)
- Skip documentation for exported functions
- Use semicolons (Prettier will remove them)
- Commit without running pre-commit hooks
- Ignore linting errors
- Skip type checking
- Use implicit return types

## Development Commands

For detailed command usage, see [CONTRIBUTING.md - Testing Instructions](CONTRIBUTING.md#testing-instructions-and-best-practices).

Quick reference:
```bash
npm test              # Run unit tests in Node.js
npm run test:browser  # Run unit tests in browser (Chromium via Playwright)
npm run test:all      # Run all tests in all environments
npm run test:integ    # Run integration tests
npm run test:coverage # Run tests with coverage report
npm run lint          # Check code quality
npm run format        # Auto-fix formatting
npm run type-check    # Verify TypeScript types
npm run build         # Compile TypeScript
```

## Browser Tool

When developing or working with the browser automation tool, see [docs/BROWSER_AUTOMATION_PATTERNS.md](docs/BROWSER_AUTOMATION_PATTERNS.md) for comprehensive patterns and best practices. This includes:

- Explicit waits and element interaction patterns
- Form input handling (fill() vs type())
- Navigation with fallback strategies
- Element visibility checks
- Session management and cleanup
- Integration test patterns for browser automation

## Troubleshooting

For comprehensive troubleshooting guidance, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). This includes:

- Common issues and solutions
- Debug strategies and tools
- Environment-specific problems
- Performance optimization
- AWS SDK troubleshooting
- When to seek additional help

**Quick fixes for common issues:**
- **TypeScript compilation fails**: Run `npm run type-check` to see all type errors
- **ESLint errors**: Run `npm run lint -- --fix` to auto-fix formatting issues
- **Test failures**: Ensure proper session cleanup in `afterEach` blocks
- **AWS SDK errors**: Check credentials and region configuration

## Agent-Specific Notes

### When Implementing Features

1. **Read task requirements** carefully from the GitHub issue
2. **Follow TDD approach** if appropriate:
   - Write failing tests first
   - Implement minimal code to pass tests
   - Refactor while keeping tests green
3. **Use existing patterns** as reference
4. **Document as you go** with TSDoc comments
5. **Run all checks** before committing (pre-commit hooks will enforce this)


### Writing code
- YOU MUST make the SMALLEST reasonable changes to achieve the desired outcome.
- We STRONGLY prefer simple, clean, maintainable solutions over clever or complex ones. Readability and maintainability are PRIMARY CONCERNS, even at the cost of conciseness or performance.
- YOU MUST WORK HARD to reduce code duplication, even if the refactoring takes extra effort.
- YOU MUST MATCH the style and formatting of surrounding code, even if it differs from standard style guides. Consistency within a file trumps external standards.
- YOU MUST NOT manually change whitespace that does not affect execution or output. Otherwise, use a formatting tool.
- Fix broken things immediately when you find them. Don't ask permission to fix bugs.


#### Code Comments
 - NEVER add comments explaining that something is "improved", "better", "new", "enhanced", or referencing what it used to be
 - Comments should explain WHAT the code does or WHY it exists, not how it's better than something else
 - YOU MUST NEVER add comments about what used to be there or how something has changed. 
 - YOU MUST NEVER refer to temporal context in comments (like "recently refactored" "moved") or code. Comments should be evergreen and describe the code as it is.
 - YOU MUST NEVER write overly verbose comments. Use concise language.


### Code Review Considerations

When responding to PR feedback:
- Address all review comments
- Test changes thoroughly
- Update documentation if behavior changes
- Maintain test coverage
- Follow conventional commit format for fix commits

### Integration with Other Files

- **CONTRIBUTING.md**: Contains testing/setup commands and human contribution guidelines
- **docs/TESTING.md**: Comprehensive testing guidelines (MUST follow when writing tests)
- **docs/PR.md**: Pull request guidelines and template
- **README.md**: Public-facing documentation, links to strandsagents.com
- **package.json**: Defines all npm scripts referenced in documentation

## Additional Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Vitest Documentation](https://vitest.dev/)
- [TSDoc Reference](https://tsdoc.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Strands Agents Documentation](https://strandsagents.com/)
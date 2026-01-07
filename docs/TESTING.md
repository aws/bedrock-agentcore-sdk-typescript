# Testing Guidelines - AWS Bedrock AgentCore TypeScript SDK

> **IMPORTANT**: When writing tests, you **MUST** follow the guidelines in this document. These patterns ensure consistency, maintainability, and proper test coverage across the SDK.

This document contains comprehensive testing guidelines for the Strands TypeScript SDK. For general development guidance, see [AGENTS.md](../AGENTS.md).

## Core Testing Principles

### Black-Box Testing Philosophy

**Rule**: Tests MUST validate behavior through the public API only. Do NOT access private members, internal state, or implementation details.

**Why black-box testing:**
- Tests remain valid when implementation changes
- Tests document the public contract
- Tests catch real user-facing bugs
- Refactoring is safer and easier

**✅ DO:**
- Test public methods and their return values
- Test observable side effects (HTTP responses, file changes, etc.)
- Test error conditions through public API
- Use dependency injection for testability

**❌ DON'T:**
- Access private properties or methods directly (use bracket notation if needed)
- Test internal state directly
- Use `any` type to bypass type checking unnecessarily
- Use `@ts-expect-error` to access private members

### Examples

**❌ Bad: White-box testing (accessing internals)**
```typescript
it('registers routes correctly', () => {
  const app = new BedrockAgentCoreApp({ handler })
  
  // ❌ Accessing private members
  const mockApp = app._app
  app._setupRoutes()
  
  // ❌ Testing internal implementation
  expect(mockApp.get).toHaveBeenCalledWith('/ping')
})
```

**✅ Good: Black-box testing (testing behavior)**
```typescript
it('responds to health check requests', async () => {
  const app = new BedrockAgentCoreApp({ handler })
  app.run()
  
  // ✅ Testing through public API
  const response = await request(app).get('/ping')
  
  expect(response.status).toBe(200)
  expect(response.body).toEqual({
    status: 'Healthy',
    activeTaskCount: 0
  })
})
```

**❌ Bad: Testing internal state**
```typescript
it('tracks tasks internally', () => {
  const app = new BedrockAgentCoreApp({ handler })
  
  // ❌ Accessing private state
  expect(app._activeTasksMap.size).toBe(0)
  
  app.addAsyncTask('test')
  
  // ❌ Verifying internal state
  expect(app._activeTasksMap.size).toBe(1)
})
```

**✅ Good: Testing observable behavior**
```typescript
it('reports active task count', () => {
  const app = new BedrockAgentCoreApp({ handler })
  
  // ✅ Using public API
  expect(app.getAsyncTaskInfo().activeCount).toBe(0)
  
  app.addAsyncTask('test')
  
  // ✅ Verifying through public method
  expect(app.getAsyncTaskInfo().activeCount).toBe(1)
})
```

### When You Need to Test Internals

If you find yourself needing to test internal behavior, consider:

1. **Make it public** - If it's important enough to test, it might belong in the public API
2. **Test through side effects** - Internal behavior should have observable effects
3. **Add test utilities** - Create public methods specifically for testing (e.g., `getStateForTesting()`)

### Bracket Notation for Private Access (Pragmatic Approach)

In cases where testing requires accessing private members and no public API exists, bracket notation can be used as a pragmatic solution:

```typescript
// Accessing private properties
const server = app['_app']

// Calling private methods  
app['_setupRoutes']()

// With type casting when needed
const mockApp = app['_app'] as any
mockApp.get.mock.calls // Access mock properties
```

**When this is acceptable:**
- Testing integrations with dependencies
- Testing specific error codes or internal behavior that can't be tested through public API
- Temporary solution while refactoring to more black-box approaches

**Best practices:**
- Use sparingly - prefer public API testing
- Document why private access is needed
- Consider if the behavior could be tested through side effects instead

### Type-Checking Tests

**Rule**: All test files MUST be type-checked to catch errors at compile time.

The project uses `tsconfig.test.json` to type-check test files separately from production code. This ensures test code has the same type safety as production code.

**Running type checks:**
```bash
npm run type-check        # Check production code only
npm run type-check:tests  # Check test files only
npm run type-check:all    # Check both (used in CI)
```

**Common type issues in tests:**

1. **Missing `.js` extensions in imports**
   ```typescript
   // ❌ Wrong
   import { Client } from '../client'
   
   // ✅ Correct
   import { Client } from '../client.js'
   ```

2. **Generic type inference failures**
   ```typescript
   // ❌ TypeScript can't infer types
   const wrapped = withAccessToken(config)(fn)
   
   // ✅ Provide explicit type parameters
   const wrapped = withAccessToken<[string], { result: string }>(config)(fn)
   ```

3. **Array access returns `T | undefined`**
   ```typescript
   // ❌ items[0] is possibly undefined
   expect(response.items[0].id).toBe('123')
   
   // ✅ Use non-null assertion after verifying length
   expect(response.items.length).toBeGreaterThan(0)
   expect(response.items[0]!.id).toBe('123')
   ```

4. **Mock objects don't match real types**
   ```typescript
   // When accessing mock-specific properties
   const mockApp = app['_app'] as any
   const calls = mockApp.get.mock.calls
   
   // When passing incomplete mock objects
   const mockRequest = { headers: {...}, body: {} }
   handler(mockRequest as any)
   ```

### Testing with Mocked Dependencies

**When mocking is acceptable:**
- ✅ External dependencies (AWS SDK, databases, third-party APIs)
- ✅ Handler functions to verify they're called with correct parameters
- ✅ Expensive operations in unit tests (network calls, file I/O)

**When mocking is NOT acceptable:**
- ❌ The class/function you're testing (test the real implementation)
- ❌ Internal implementation details (test behavior, not implementation)
- ❌ In integration tests (defeats the purpose of end-to-end testing)

**Example: Good use of mocking**
```typescript
it('invokes handler with correct context', async () => {
  // ✅ Mock the handler to verify it receives correct parameters
  const mockHandler = vi.fn(async (request, context) => ({ result: 'success' }))
  const app = new BedrockAgentCoreApp({ handler: mockHandler })
  
  // Test the real app behavior
  const mockApp = app['_app'] as any
  app['_setupRoutes']()
  
  const postCall = mockApp.post.mock.calls.find(call => call[0] === '/invocations')
  const invocationHandler = postCall[2]
  await invocationHandler(mockReq, mockReply)
  
  // Verify handler was called correctly
  expect(mockHandler).toHaveBeenCalledWith(
    { test: 'data' },
    expect.objectContaining({ sessionId: 'session-123' })
  )
})
```

### Write Lean, Focused Tests

Tests should be **minimal and focused** on exactly what you're testing. Avoid unnecessary complexity, boilerplate, or setup that doesn't directly contribute to validating the behavior under test.

**Key principles:**
- **Reuse expensive resources** - Don't recreate resources (like AWS services, database connections, or test infrastructure) if they can be shared across tests
- **Batch related assertions** - When setup cost exceeds test logic cost, combine related assertions into a single test
- **Minimize boilerplate** - Use fixtures, helpers, and shared setup to reduce repetitive code
- **Test one thing well** - Each test should validate a specific behavior or scenario clearly

**Example of lean vs bloated testing:**

```typescript
// ❌ BAD - Recreating expensive resource for each test
it('validates user input', async () => {
  const pool = await createCognitoUserPool() // Expensive!
  const client = await createAppClient(pool)
  // ... test logic
  await deleteUserPool(pool)
})

it('handles authentication', async () => {
  const pool = await createCognitoUserPool() // Recreating same resource!
  const client = await createAppClient(pool)
  // ... test logic
  await deleteUserPool(pool)
})

// ✅ GOOD - Reuse shared resource
let sharedPool: UserPool
let sharedClient: AppClient

beforeAll(async () => {
  // Check if pool exists, create only if needed
  sharedPool = await getOrCreateUserPool('test-pool')
  sharedClient = await getOrCreateAppClient(sharedPool)
})

it('validates user input', async () => {
  // Test logic only - no expensive setup
})

it('handles authentication', async () => {
  // Test logic only - no expensive setup
})
```

## Test Fixtures Quick Reference

All test fixtures are located in `src/__fixtures__/`. Use these helpers to reduce boilerplate and ensure consistency.

| Fixture                | File                    | When to Use                                                                          | Details                                                                     |
| ---------------------- | ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `MockMessageModel`     | `mock-message-model.ts` | Agent loop tests - specify content blocks, auto-generates stream events              | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `TestModelProvider`    | `model-test-helpers.ts` | Low-level model tests - precise control over individual `ModelStreamEvent` sequences | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `collectIterator()`    | `model-test-helpers.ts` | Collect all items from any async iterable into an array                              | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `collectGenerator()`   | `model-test-helpers.ts` | Collect yielded items AND final return value from async generators                   | [Model Fixtures](#model-fixtures-mock-message-modelts-model-test-helpersts) |
| `MockHookProvider`     | `mock-hook-provider.ts` | Record and verify hook invocations during agent execution                            | [Hook Fixtures](#hook-fixtures-mock-hook-providerts)                        |
| `createMockTool()`     | `tool-helpers.ts`       | Create mock tools with custom result behavior                                        | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createRandomTool()`   | `tool-helpers.ts`       | Create minimal mock tools when execution doesn't matter                              | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createMockContext()`  | `tool-helpers.ts`       | Create mock `ToolContext` for testing tool implementations directly                  | [Tool Fixtures](#tool-fixtures-tool-helpersts)                              |
| `createMockAgent()`    | `agent-helpers.ts`      | Create minimal mock Agent with messages and state                                    | [Agent Fixtures](#agent-fixtures-agent-helpersts)                           |
| `isNode` / `isBrowser` | `environment.ts`        | Environment detection for conditional test execution                                 | [Environment Fixtures](#environment-fixtures-environmentts)                 |

## Test Organization

### Unit Test Location

**Rule**: Unit test files are co-located with source files, grouped in a directory named `__tests__`

```
src/subdir/
├── agent.ts                    # Source file
├── model.ts                    # Source file
└── __tests__/
    ├── agent.test.ts           # Tests for agent.ts
    └── model.test.ts           # Tests for model.ts
```

### Integration Test Location

**Rule**: Integration tests are separate in `tests_integ/`

```
tests_integ/
├── api.test.ts                 # Tests public API
└── environment.test.ts         # Tests environment compatibility
```

### Test File Naming

- Unit tests: `{sourceFileName}.test.ts` in `src/**/__tests__/**`
- Integration tests: `{feature}.test.ts` in `tests_integ/`

## Integration Test Guidelines

Integration tests validate end-to-end functionality with real external services. They test the **public API** against actual AWS services, not mocked implementations.

### Resource Management in Integration Tests

**Rule**: Reuse expensive resources across tests. Don't recreate resources that can be shared.

**✅ Good: Reuse shared resources**

```typescript
describe('Identity Integration Tests', () => {
  let client: IdentityClient
  let sharedCognitoPool: CognitoUserPool
  
  beforeAll(async () => {
    client = new IdentityClient('us-west-2')
    
    // Check if pool exists, create only if needed
    sharedCognitoPool = await getOrCreateUserPool('test-pool-name')
  })
  
  // Don't delete shared resources in afterAll - reuse on next run
  
  it('performs OAuth2 M2M flow', async () => {
    // Use shared pool - no expensive setup
    const token = await client.getOAuth2Token({
      providerName: sharedCognitoPool.providerName,
      // ...
    })
    expect(token).toBeDefined()
  })
  
  it('handles concurrent token requests', async () => {
    // Reuse same pool - fast test execution
    const promises = Array(5).fill(null).map(() => 
      client.getOAuth2Token({ /* ... */ })
    )
    const tokens = await Promise.all(promises)
    expect(tokens).toHaveLength(5)
  })
})
```

**❌ Bad: Recreate expensive resources**

```typescript
describe('Identity Integration Tests', () => {
  it('performs OAuth2 M2M flow', async () => {
    // ❌ Creates new pool every time - slow and wasteful
    const pool = await createCognitoUserPool(`test-${Date.now()}`)
    const domain = await createDomain(pool)
    await waitForDomainActive(domain) // 5+ seconds!
    
    // Test logic...
    
    // ❌ Deletes pool - next test will recreate it
    await deleteUserPool(pool)
  })
  
  it('handles concurrent token requests', async () => {
    // ❌ Recreates everything again!
    const pool = await createCognitoUserPool(`test-${Date.now()}`)
    const domain = await createDomain(pool)
    await waitForDomainActive(domain) // Another 5+ seconds!
    
    // Test logic...
    
    await deleteUserPool(pool)
  })
})
```

**Key principles:**
- Use stable resource names (not `Date.now()` suffixes)
- Check if resource exists before creating
- Don't delete shared resources after tests
- Clean up only test-specific resources (like temporary identities or providers)

### What to Include in Integration Tests

**✅ DO test:**
- Real service integration (actual AWS Bedrock calls)
- Public API validation (main client classes)
- Complete user workflows
- Session management and lifecycle
- Cross-operation workflows
- Error scenarios with real services
- Framework integrations (Vercel AI, LangChain, etc.)

**❌ DON'T test:**
- Internal helper functions
- Mocked services (defeats the purpose)
- Unit-level logic
- TypeScript type checking

### Integration Test Structure

```typescript
/**
 * Integration tests for [FeatureName]
 *
 * Prerequisites:
 * - AWS credentials configured
 * - Access to AWS Bedrock [ServiceName] service
 * - Required permissions: [list permissions]
 *
 * To run: npm run test:integ
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ClientClass } from '../src/path/to/client'

describe('[FeatureName] Integration Tests', () => {
  let client: ClientClass
  const testRegion = process.env.AWS_REGION || 'us-west-2'

  beforeAll(() => {
    client = new ClientClass({ region: testRegion })
  })

  afterAll(async () => {
    // Cleanup resources
  })

  describe('Basic Functionality', () => {
    it('performs core operation', async () => {
      const result = await client.coreMethod()
      expect(result).toBeDefined()
      // Validate actual service response structure
    }, 30000) // Longer timeout for real service calls
  })

  describe('Error Handling', () => {
    it('handles service errors gracefully', async () => {
      await expect(client.invalidOperation()).rejects.toThrow()
    })
  })
})
```

### Prerequisites for Integration Tests

**AWS Credentials:**
- Configure via environment variables or AWS config
- Ensure credentials have required permissions
- Tests will fail with `AccessDeniedException` if credentials are expired

**Service Access:**
- Access to AWS Bedrock AgentCore service
- Valid runtime ARNs (for runtime client tests)
- Appropriate service quotas and limits

**Environment Variables:**
```bash
AWS_REGION=us-west-2
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
# Or use AWS profiles, IAM roles, etc.
```

### Common Integration Test Patterns

**Session Lifecycle Testing:**
```typescript
describe('Session Management', () => {
  it('creates and manages sessions', async () => {
    const session = await client.startSession({ name: 'test-session' })
    expect(session.sessionId).toBeDefined()
    
    // Use session
    const result = await client.performOperation({ sessionId: session.sessionId })
    expect(result).toBeDefined()
    
    // Cleanup
    await client.stopSession()
  })
})
```

**Multi-Step Workflows:**
```typescript
describe('Real-World Workflows', () => {
  it('performs complete workflow', async () => {
    // Step 1: Setup
    await client.initialize()
    
    // Step 2: Execute
    const result1 = await client.step1()
    const result2 = await client.step2(result1)
    
    // Step 3: Validate
    expect(result2).toMatchObject({
      status: 'success',
      data: expect.any(Object)
    })
  })
})
```

**Error Scenario Testing:**
```typescript
describe('Error Handling', () => {
  it('handles invalid parameters', async () => {
    await expect(client.method({
      invalidParam: 'bad-value'
    })).rejects.toThrow('Invalid parameter')
  })
  
  it('handles service unavailable', async () => {
    // Test with invalid region or credentials
    const invalidClient = new ClientClass({ region: 'invalid-region' })
    await expect(invalidClient.method()).rejects.toThrow()
  })
})
```

### Running Integration Tests

```bash
# Run all integration tests
npm run test:integ

# Run specific integration test
npm run test:integ -- runtime-client

# Run with verbose output
npm run test:integ -- --reporter=verbose
```

### Integration Test Best Practices

1. **Use longer timeouts** (30-60 seconds) for real service calls - add explicit timeout to each test: `it('test name', async () => { ... }, 30000)`
2. **Clean up test-specific resources** in `afterAll` or `afterEach` hooks, but reuse shared infrastructure
3. **Test realistic scenarios** that users would actually perform
4. **Validate complete response structures** using object assertions, not just existence checks
5. **Handle flaky network conditions** with appropriate retries where needed
6. **Use environment variables** for configuration (AWS_REGION, credentials)
7. **Document prerequisites** clearly in test file comments
8. **Avoid unnecessary boilerplate** - don't add comments that restate what the code already says

**❌ Bad: Unnecessary boilerplate and comments**

```typescript
afterAll(async () => {
  // Cleanup - delete test resources
  try {
    await client.deleteProvider(providerName)
  } catch (e) {
    // Ignore if doesn't exist
  }
  try {
    await client.deleteIdentity(identityName)
  } catch (e) {
    // Ignore if doesn't exist
  }
  try {
    await client.deleteWorkload(workloadName)
  } catch (e) {
    // Ignore if doesn't exist
  }
})
```

**✅ Good: Clean, self-explanatory code**

```typescript
afterAll(async () => {
  // Cleanup test-specific resources
  await Promise.allSettled([
    client.deleteProvider(providerName),
    client.deleteIdentity(identityName),
    client.deleteWorkload(workloadName),
  ])
})
```

## Test Structure Pattern

Follow this nested describe pattern for consistency:

### For Functions

```typescript
import { describe, it, expect } from 'vitest'
import { functionName } from '../module'

describe('functionName', () => {
  describe('when called with valid input', () => {
    it('returns expected result', () => {
      const result = functionName('input')
      expect(result).toBe('expected')
    })
  })

  describe('when called with edge case', () => {
    it('handles gracefully', () => {
      const result = functionName('')
      expect(result).toBeDefined()
    })
  })
})
```

### For Classes

```typescript
import { describe, it, expect } from 'vitest'
import { ClassName } from '../module'

describe('ClassName', () => {
  describe('methodName', () => {
    it('returns expected result', () => {
      const instance = new ClassName()
      const result = instance.methodName()
      expect(result).toBe('expected')
    })

    it('handles error case', () => {
      const instance = new ClassName()
      expect(() => instance.methodName()).toThrow()
    })
  })

  describe('anotherMethod', () => {
    it('performs expected action', () => {
      // Test implementation
    })
  })
})
```

### Key Principles

- Top-level `describe` uses the function/class name
- Nested `describe` blocks group related test scenarios
- **Use descriptive test names WITHOUT "should" prefix** - Write `it('returns the sum', ...)` not `it('should return the sum', ...)`
- Group tests by functionality or scenario

## Writing Effective Tests

```typescript
// Good: Clear, specific test without "should" prefix
describe('calculateTotal', () => {
  describe('when given valid numbers', () => {
    it('returns the sum', () => {
      expect(calculateTotal([1, 2, 3])).toBe(6)
    })
  })

  describe('when given empty array', () => {
    it('returns zero', () => {
      expect(calculateTotal([])).toBe(0)
    })
  })
})

// Bad: Uses "should" prefix (violates guideline)
describe('calculateTotal', () => {
  it('should work', () => {
    expect(calculateTotal([1, 2, 3])).toBeTruthy()
  })
  
  it('should return the sum', () => { // ❌ Don't use "should"
    expect(calculateTotal([1, 2, 3])).toBe(6)
  })
})
```

## Test Batching Strategy

**Rule**: When test setup cost exceeds test logic cost, you MUST batch related assertions into a single test.

**You MUST batch when**:

- Setup complexity > test logic complexity
- Multiple assertions verify the same object state
- Related behaviors share expensive context (AWS service calls, database connections, browser sessions, etc.)

**You SHOULD keep separate tests for**:

- Distinct behaviors or execution paths
- Error conditions
- Different input scenarios

**Bad - Redundant expensive setup**:

```typescript
// ❌ Each test creates expensive browser session
it('navigates to page', async () => {
  await browser.navigate({ url: 'https://example.com' }) // Expensive!
  const html = await browser.getHtml()
  expect(html).toContain('Example')
}, 90000)

it('extracts page title', async () => {
  await browser.navigate({ url: 'https://example.com' }) // Recreating same state!
  const title = await browser.getText({ selector: 'h1' })
  expect(title).toBeTruthy()
}, 90000)

it('takes screenshot', async () => {
  await browser.navigate({ url: 'https://example.com' }) // Again!
  const screenshot = await browser.screenshot()
  expect(screenshot).toBeDefined()
}, 90000)
```

**Good - Batched related operations**:

```typescript
// ✅ Single expensive setup, multiple related assertions
it('performs navigation and content extraction', async () => {
  await browser.navigate({ url: 'https://example.com' })
  
  const html = await browser.getHtml()
  expect(html).toContain('Example')
  
  const title = await browser.getText({ selector: 'h1' })
  expect(title).toBeTruthy()
  
  const screenshot = await browser.screenshot()
  expect(screenshot).toBeDefined()
}, 90000)
```

**Good - Batched error cases**:

```typescript
// ✅ Batch related error scenarios
it('throws errors for invalid ARN formats', () => {
  expect(() => parseArn('invalid')).toThrow('Invalid ARN format')
  expect(() => parseArn('arn:aws:wrong::')).toThrow('Wrong service')
  expect(() => parseArn('arn:aws:service:::')).toThrow('Missing region')
  expect(() => parseArn('arn:aws:service:region::')).toThrow('Missing account')
})
```

## Object Assertion Best Practices

**Prefer testing entire objects at once** instead of individual properties for better readability and test coverage.

```typescript
// ✅ Good: Verify entire object at once
it('returns expected user object', () => {
  const user = getUser('123')
  expect(user).toEqual({
    id: '123',
    name: 'John Doe',
    email: 'john@example.com',
    isActive: true,
  })
})

// ✅ Good: Verify entire array of objects
it('yields expected stream events', async () => {
  const events = await collectIterator(stream)
  expect(events).toEqual([
    { type: 'streamEvent', data: 'Starting...' },
    { type: 'streamEvent', data: 'Processing...' },
    { type: 'streamEvent', data: 'Complete!' },
  ])
})

// ❌ Bad: Testing individual properties
it('returns expected user object', () => {
  const user = getUser('123')
  expect(user).toBeDefined()
  expect(user.id).toBe('123')
  expect(user.name).toBe('John Doe')
  expect(user.email).toBe('john@example.com')
  expect(user.isActive).toBe(true)
})

// ❌ Bad: Testing array elements individually
it('yields expected stream events', async () => {
  const events = await collectIterator(stream)
  expect(events[0].type).toBe('streamEvent')
  expect(events[0].data).toBe('Starting...')
  expect(events[1].type).toBe('streamEvent')
  expect(events[1].data).toBe('Processing...')
  // ...
})
```

**Benefits of testing entire objects**:

- **More concise**: Single assertion instead of multiple
- **Better test coverage**: Catches unexpected additional or missing properties
- **More readable**: Clear expectation of the entire structure
- **Easier to maintain**: Changes to the object require updating one place

**Use cases**:

- Always use `toEqual()` for object and array comparisons
- Use `toBe()` only for primitive values and reference equality
- When testing error objects, verify the entire structure including message and type
- Use `expect.any(Type)` for dynamic values like timestamps or IDs

## What to Test

**Testing Approach:**

- You **MUST** write tests for implementations (functions, classes, methods)
- You **SHOULD NOT** write tests for interfaces or TypeScript types - the TypeScript compiler already enforces type correctness
- You **SHOULD** write Vitest type tests (`*.test-d.ts`) for complex types to ensure backwards compatibility

**❌ Don't test TypeScript types:**

```typescript
// ❌ Bad: Unnecessary type testing
it('exports correct types', () => {
  const _request: OAuth2TokenRequest = {
    providerName: 'test',
    scopes: ['read'],
    authFlow: 'M2M',
  }
  const _response: OAuth2TokenResponse = { token: 'abc' }
  expect(true).toBe(true) // Meaningless assertion
})
```

**✅ Do test implementations:**

```typescript
// ✅ Good: Test actual behavior
it('retrieves OAuth2 token', async () => {
  const client = new IdentityClient('us-west-2')
  const token = await client.getOAuth2Token({
    providerName: 'test-provider',
    scopes: ['read'],
    authFlow: 'M2M',
    workloadIdentityToken: 'token-123',
  })
  
  expect(token).toBeDefined()
  expect(typeof token).toBe('string')
})
```

## Test Coverage

- **Minimum**: 80% coverage required (enforced by Vitest)
- **Target**: Aim for high coverage on critical paths
- **Exclusions**: Test files, config files, generated code

## Test Model Providers

**When to use each test provider:**

- **`MockMessageModel`**: For agent loop tests and high-level flows - focused on content blocks
- **`TestModelProvider`**: For low-level event streaming tests where you need precise control over individual events

### MockMessageModel - Content-Focused Testing

For tests focused on messages, you SHOULD use `MockMessageModel` with a content-focused API that eliminates boilerplate:

```typescript
import { MockMessageModel } from '../__fixtures__/mock-message-model'

// ✅ RECOMMENDED - Single content block (most common)
const provider = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Hello' })

// ✅ RECOMMENDED - Array of content blocks
const provider = new MockMessageModel().addTurn([
  { type: 'textBlock', text: 'Let me help' },
  { type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} },
])

// ✅ RECOMMENDED - Multi-turn with builder pattern
const provider = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} }) // Auto-derives 'toolUse'
  .addTurn({ type: 'textBlock', text: 'The answer is 42' }) // Auto-derives 'endTurn'

// ✅ OPTIONAL - Explicit stopReason when needed
const provider = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Partial response' }, 'maxTokens')

// ✅ OPTIONAL - Error handling
const provider = new MockMessageModel()
  .addTurn({ type: 'textBlock', text: 'Success' })
  .addTurn(new Error('Model failed'))
```

## Testing Hooks

When testing hook behavior, you **MUST** use `agent.hooks.addCallback()` for registering single callbacks when `agent.hooks` is available. Do NOT create inline `HookProvider` objects — this is an anti-pattern for single callbacks.

```typescript
// ✅ CORRECT - Use agent.hooks.addCallback() for single callbacks
const agent = new Agent({ model, tools: [tool] })

agent.hooks.addCallback(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
  event.toolUse = {
    ...event.toolUse,
    input: { value: 42 },
  }
})

// ✅ CORRECT - Use MockHookProvider to record and verify hook invocations
const hookProvider = new MockHookProvider()
const agent = new Agent({ model, hooks: [hookProvider] })
await agent.invoke('Hi')
expect(hookProvider.invocations).toContainEqual(new BeforeInvocationEvent({ agent }))

// ❌ WRONG - Do NOT create inline HookProvider objects
const switchToolHook = {
  registerCallbacks: (registry: HookRegistry) => {
    registry.addCallback(BeforeToolCallEvent, (event: BeforeToolCallEvent) => {
      if (event.toolUse.name === 'tool1') {
        event.tool = tool2
      }
    })
  },
}
```

**When to use each approach:**

- **`agent.hooks.addCallback()`** - For adding a single callback to verify hook behavior (e.g., modifying tool input, switching tools)
- **`MockHookProvider`** - For recording and verifying hook lifecycle behavior and that specific hook events fired during execution

## Mock Providers

Create reusable mock providers for testing:

```typescript
// __tests__/mocks/aws-sdk.ts
import { vi } from 'vitest'

export function createMockBedrockClient() {
  return {
    send: vi.fn().mockImplementation((command) => {
      if (command instanceof StartBrowserSessionCommand) {
        return Promise.resolve({ sessionId: 'mock-session-id' })
      }
      if (command instanceof InvokeBrowserActionCommand) {
        return Promise.resolve({ success: true })
      }
      return Promise.reject(new Error('Unknown command'))
    }),
  }
}

// client.test.ts
import { createMockBedrockClient } from './mocks/aws-sdk'

describe('BrowserClient', () => {
  it('starts session successfully', async () => {
    const mockClient = createMockBedrockClient()
    const client = new BrowserClient({ region: 'us-east-1' })
    // Inject mock (implementation detail depends on your dependency injection)
  })
})
```

## Test Fixtures Reference

All test fixtures are located in `src/__fixtures__/`. Use these helpers to reduce boilerplate and ensure consistency.

### Model Fixtures (`mock-message-model.ts`, `model-test-helpers.ts`)

- **`MockMessageModel`** - Content-focused model for agent loop tests. Use `addTurn()` with content blocks.
- **`TestModelProvider`** - Low-level model for precise control over `ModelStreamEvent` sequences.
- **`collectIterator(stream)`** - Collects all items from an async iterable into an array.
- **`collectGenerator(generator)`** - Collects yielded items and final return value from an async generator.

```typescript
// MockMessageModel for agent tests
const model = new MockMessageModel()
  .addTurn({ type: 'toolUseBlock', name: 'calc', toolUseId: 'id-1', input: {} })
  .addTurn({ type: 'textBlock', text: 'Done' })

// collectIterator for stream results
const events = await collectIterator(agent.stream('Hi'))
```

### Hook Fixtures (`mock-hook-provider.ts`)

- **`MockHookProvider`** - Records all hook invocations for verification. Pass to `Agent({ hooks: [provider] })`.
  - Use `{ includeModelEvents: false }` to exclude `ModelStreamEventHook` from recordings.
  - Access `provider.invocations` to verify hook events fired.

```typescript
// Record and verify hook invocations
const hookProvider = new MockHookProvider({ includeModelEvents: false })
const agent = new Agent({ model, hooks: [hookProvider] })

await agent.invoke('Hi')

expect(hookProvider.invocations[0]).toEqual(new BeforeInvocationEvent({ agent }))
```

### Tool Fixtures (`tool-helpers.ts`)

- **`createMockTool(name, resultFn)`** - Creates a mock tool with custom result behavior.
- **`createRandomTool(name?)`** - Creates a minimal mock tool (use when tool execution doesn't matter).
- **`createMockContext(toolUse, agentState?)`** - Creates a mock `ToolContext` for testing tool implementations directly.

```typescript
// Mock tool with custom result
const tool = createMockTool(
  'calculator',
  () => new ToolResultBlock({ toolUseId: 'id', status: 'success', content: [new TextBlock('42')] })
)

// Minimal tool when execution doesn't matter
const tool = createRandomTool('myTool')
```

**When to use fixtures vs `FunctionTool` directly:**

Use `createMockTool()` or `createRandomTool()` when tools are incidental to the test. Use `FunctionTool` or `tool()` directly only when testing tool-specific behavior.

```typescript
// ✅ Use fixtures when testing agent/hook behavior
const tool = createMockTool('testTool', () => ({
  type: 'toolResultBlock',
  toolUseId: 'tool-1',
  status: 'success' as const,
  content: [new TextBlock('Success')],
}))
const agent = new Agent({ model, tools: [tool] })

// ❌ Don't use FunctionTool when tool behavior is irrelevant to the test
const tool = new FunctionTool({ name: 'testTool', description: '...', inputSchema: {...}, callback: ... })
```

### Agent Fixtures (`agent-helpers.ts`)

- **`createMockAgent(data?)`** - Creates a minimal mock Agent with messages and state. Use for testing components that need an Agent reference without full agent behavior.

```typescript
const agent = createMockAgent({
  messages: [new Message({ role: 'user', content: [new TextBlock('Hi')] })],
  state: { key: 'value' },
})
```

### Environment Fixtures (`environment.ts`)

- **`isNode`** - Boolean that detects if running in Node.js environment.
- **`isBrowser`** - Boolean that detects if running in a browser environment.

Use these for conditional test execution when tests depend on environment-specific features.

```typescript
import { isNode } from '../__fixtures__/environment'

// Skip tests that require Node.js features in browser
describe.skipIf(!isNode)('Node.js specific features', () => {
  it('uses environment variables', () => {
    expect(process.env.NODE_ENV).toBeDefined()
  })
})
```

## Multi-Environment Testing

The SDK is designed to work seamlessly in both Node.js and browser environments. Our test suite validates this by running tests in both environments using Vitest's browser mode with Playwright.

### Test Projects

The test suite is organized into three projects:

1. **unit-node** (green): Unit tests running in Node.js environment
2. **unit-browser** (cyan): Same unit tests running in Chromium browser
3. **integ** (magenta): Integration tests running in Node.js

### Environment-Specific Test Patterns

- You MUST write tests that are environment-agnostic unless they depend on Node.js features like filesystem or env-vars

Some tests require Node.js-specific features (like process.env, AWS SDK) and should be skipped in browser environments:

```typescript
import { describe, it, expect } from 'vitest'
import { isNode } from '../__fixtures__/environment'

// Tests will run in Node.js, skip in browser
describe.skipIf(!isNode)('Node.js specific features', () => {
  it('uses environment variables', () => {
    // This test accesses process.env
    expect(process.env.NODE_ENV).toBeDefined()
  })
})
```

## Development Commands

```bash
npm test              # Run unit tests in Node.js
npm run test:browser  # Run unit tests in browser (Chromium via Playwright)
npm run test:all      # Run all tests in all environments
npm run test:integ    # Run integration tests
npm run test:coverage # Run tests with coverage report
```

For detailed command usage, see [CONTRIBUTING.md - Testing Instructions](../CONTRIBUTING.md#testing-instructions-and-best-practices).

## Checklist Items

Before submitting tests, verify:

- [ ] Do the tests use relevant helpers from `src/__fixtures__/` as noted in the "Test Fixtures Quick Reference" table above?
- [ ] Are recurring code or patterns extracted to functions for better usability/readability?
- [ ] Are tests focused on verifying one or two things only?
- [ ] Are tests written concisely with minimal boilerplate?
- [ ] Are tests asserting on the entire object instead of specific fields?
- [ ] Do test names avoid the "should" prefix? (Use `it('returns the sum', ...)` not `it('should return the sum', ...)`)
- [ ] Are expensive resources (AWS services, browser sessions, etc.) reused across tests instead of recreated?
- [ ] Are related assertions batched into single tests when setup cost exceeds test logic cost?
- [ ] Do integration tests document prerequisites clearly?
- [ ] Do integration tests use explicit timeouts (30-60s) for real service calls?
- [ ] Are unnecessary comments and boilerplate removed?
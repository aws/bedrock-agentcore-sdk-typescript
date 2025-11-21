# Security Policy

## Reporting a Vulnerability

If you discover a potential security issue in this project, we ask that you notify AWS Security via our [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/) or directly via email to [aws-security@amazon.com](mailto:aws-security@amazon.com). Please do **not** create a public GitHub issue for security vulnerabilities.

When reporting, please include:
- Type of issue (e.g., credential exposure, injection vulnerability, etc.)
- Full paths of source file(s) related to the issue
- Location of affected source code (tag/branch/commit or direct URL)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

We will acknowledge your report within 48 hours and provide an initial assessment within 5 business days.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Best Practices

### 1. Credential Management

**❌ NEVER hardcode AWS credentials:**

```typescript
// BAD - Never do this
const codeInterpreter = new CodeInterpreterTools({
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  }
})
```

**✅ Use AWS credential provider chain:**

```typescript
// GOOD - Let AWS SDK handle credentials
const codeInterpreter = new CodeInterpreterTools({
  region: 'us-east-1'
  // Credentials loaded from environment, IAM role, or AWS config
})
```

**✅ Use environment variables:**

```bash
export AWS_ACCESS_KEY_ID=your-key-id
export AWS_SECRET_ACCESS_KEY=your-secret-key
export AWS_REGION=us-east-1
```

**✅ Use IAM roles for EC2/Lambda:**

```typescript
// No credentials needed - IAM role provides them automatically
const codeInterpreter = new CodeInterpreterTools()
```

### 2. Session Management

Always clean up sessions to prevent resource leaks and unauthorized access:

```typescript
const codeInterpreter = new CodeInterpreterTools()

try {
  await codeInterpreter.startSession()

  const result = await codeInterpreter.executeCode({
    code: 'print("Hello, secure world!")',
    language: 'python'
  })

  console.log(result)
} finally {
  // Always cleanup, even on error
  await codeInterpreter.stopSession()
}
```

### 3. Input Validation

The SDK uses Zod for runtime input validation:

```typescript
import { z } from 'zod'

// All tool inputs are validated against schemas
// Example from execute-code-tool.ts:
const inputSchema = z.object({
  code: z.string().describe('The code to execute'),
  language: z.enum(['python', 'javascript', 'typescript'])
    .default('python')
})

// Invalid inputs are automatically rejected before execution
```

### 4. Secure Communication

**HTTPS Enforcement:**
- All AWS API calls use HTTPS by default
- TLS 1.2+ required
- AWS Signature Version 4 authentication

**Request Signing:**
```typescript
// SDK automatically signs all requests with AWS SigV4
// No manual signing needed - handled by @aws-sdk/client-bedrock-agentcore
```

### 5. Logging Safety

**❌ NEVER log sensitive data:**

```typescript
// BAD - Logs credentials
console.log('Session started with token:', sessionToken)
console.log('AWS credentials:', credentials)
```

**✅ Log only non-sensitive metadata:**

```typescript
// GOOD - Logs session ID only
console.log('Session started:', sessionId)
console.log('Execution completed in', duration, 'ms')
```

The SDK has been cleaned to avoid debug logging that could leak sensitive information. Error logging is preserved for debugging failures without exposing credentials.

### 6. Code Execution Safety

When using CodeInterpreter, untrusted code runs in an isolated AWS-managed sandbox:

```typescript
const codeInterpreter = new CodeInterpreterTools()

// Sandboxed execution - isolated from your infrastructure
const result = await agent.run({
  prompt: 'Analyze this CSV data: ' + userProvidedData,
  tools: codeInterpreter.tools
})
```

**Best practices:**
- Validate user inputs before passing to agent prompts
- Set execution timeouts to prevent resource exhaustion
- Monitor costs and usage patterns
- Review generated code before production deployment

### 7. Browser Automation Safety

When using Browser tools, be cautious with user-provided URLs:

```typescript
const browser = new BrowserTools()

// Validate URLs before navigation
function isAllowedDomain(url: string): boolean {
  const allowed = ['example.com', 'trusted-site.com']
  const hostname = new URL(url).hostname
  return allowed.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

// Only navigate to validated URLs
if (isAllowedDomain(userUrl)) {
  await browser.navigate({ url: userUrl })
} else {
  throw new Error('Domain not allowed')
}
```

## Built-in Security Features

- **AWS SDK Integration**: Leverages AWS SDK's credential provider chain and request signing
- **Input Validation**: Zod schemas validate all tool inputs at runtime
- **Session Isolation**: Each CodeInterpreter/Browser session is isolated in AWS infrastructure
- **HTTPS Only**: All communication with AWS services uses HTTPS
- **No Credential Storage**: SDK never persists credentials to disk

## Security Tools & Scanning

**Recommended tools for your projects using this SDK:**

```bash
# Dependency vulnerability scanning
npm audit

# Check for outdated/vulnerable packages
npm outdated

# Static analysis with ESLint security plugin
npm install --save-dev eslint-plugin-security
```

**GitHub Security Features:**
- Enable Dependabot alerts in your repository
- Use CodeQL for automated security scanning
- Configure secret scanning to prevent credential commits

## Compliance & Standards

This SDK follows:
- [AWS Well-Architected Security Pillar](https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/welcome.html)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/) guidelines
- AWS SDK security best practices

## Security Updates

Security patches are released as soon as possible after discovery. Subscribe to this repository's releases to stay informed about security updates.

## Additional Resources

- [AWS Security Best Practices](https://aws.amazon.com/security/security-resources/)
- [Bedrock AgentCore Security](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/security.html)
- [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/)

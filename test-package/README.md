# Test Package

This package verifies that the `@bedrock-agentcore/sdk` can be imported and used correctly without a bundler in a pure Node.js ES module environment.

## Purpose

- Ensures the build output is correctly configured for ES module consumption
- Validates that all exports are accessible
- Verifies that the package can be used via `file:..` dependency
- Tests basic instantiation and API surface

## Usage

1. **Build the SDK first:**

   ```bash
   cd ..
   npm run build
   ```

2. **Install dependencies:**

   ```bash
   cd test-package
   npm install
   ```

3. **Run verification:**
   ```bash
   node verify.js
   ```

## Expected Output

```
✓ Import from code-interpreter entry point successful
✓ CodeInterpreter instantiation successful
✓ CodeInterpreter region property accessible
✓ CodeInterpreter identifier property accessible
✓ CodeInterpreter defaultSessionName property accessible
✓ startSession method exists
✓ stopSession method exists
✓ listSessions method exists
✓ executeCode method exists
✓ executeCommand method exists
✓ withSession method exists

✅ All verification checks passed!
```

## What It Tests

1. **Import Resolution**: Verifies that `@bedrock-agentcore/sdk/code-interpreter` can be imported
2. **Class Instantiation**: Creates a `CodeInterpreter` instance
3. **Configuration**: Validates that constructor parameters are properly set
4. **API Surface**: Confirms all expected methods are present
5. **No Bundler Required**: Runs in pure Node.js without webpack/rollup/vite

## When to Use

Run this test after making changes to:

- Package exports in `package.json`
- Build configuration in `tsconfig.json`
- Module structure or entry points
- Any refactoring that might affect the public API

## Troubleshooting

If verification fails:

1. **Build Error**: Make sure you've run `npm run build` in the parent directory
2. **Import Error**: Check that `package.json` exports are correctly configured
3. **Missing Methods**: Verify the class implementation matches the expected API
4. **Type Error**: Ensure TypeScript compilation completed successfully

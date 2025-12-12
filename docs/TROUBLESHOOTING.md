# Troubleshooting Guide

This document contains troubleshooting guidance extracted from the development documentation.

## Common Issues

**Issue**: Tests failing with "Session not found"
**Solution**: Ensure session is created in `beforeEach` and cleaned up in `afterEach`

**Issue**: TypeScript errors about missing types
**Solution**: Run `npm install` to update `@types` packages

**Issue**: ESLint errors about semicolons
**Solution**: Run `npm run lint -- --fix` to auto-fix

**Issue**: AWS SDK errors in tests
**Solution**: Use mock providers from `__tests__/mocks/` directory

**Issue**: Integration tests failing
**Solution**: Check AWS credentials and region configuration

## Debug Strategies

1. **Check AWS SDK calls**: Log commands before sending
2. **Verify session state**: Log active sessions with `listSessions()`
3. **Test with base client**: Isolate framework integration issues
4. **Use mock clients**: Test logic without AWS calls
5. **Check error messages**: AWS SDK errors contain useful context

## Getting Help

1. **Search codebase**: Look for similar implementations
2. **Check tests**: Examples of how code should be used
3. **Review examples**: Working code in `examples/` directory
4. **Consult Python SDK**: Reference implementation patterns
5. **Review AGENTS_1.md**: This document contains all development patterns
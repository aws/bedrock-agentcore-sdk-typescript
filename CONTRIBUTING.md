# Contributing Guidelines

Thank you for your interest in contributing to the AWS Bedrock AgentCore SDK TypeScript! Whether it's a bug report, new feature, correction, or additional documentation, we greatly value feedback and contributions from our community.

Please read through this document before submitting any issues or pull requests.

> **Note**: For AI agent-specific development patterns and guidelines, see [AGENTS.md](AGENTS.md).

## Development Environment

### Prerequisites

- **Node.js**: Version 20.0.0 or higher
- **npm**: Version 9.0.0 or higher

### Setup

1. Clone the repository and install dependencies:

   ```bash
   git clone <repository-url>
   cd bedrock-agentcore-sdk-typescript
   npm install
   ```

2. Verify your setup by running the test suite:

   ```bash
   npm test
   npm run lint
   npm run format:check
   npm run type-check:all
   ```

3. Install git hooks for automatic quality checks:
   ```bash
   npm run prepare
   ```

This installs a pre-commit hook that runs `lint-staged`, which applies `eslint --fix` and `prettier --write` to staged files. It does not run tests or type-check; run `npm run check` (or `npm run ci`, which adds the build and integration tests) before opening a PR, because PR CI runs lint but not unit tests or type-check.

## Testing Instructions and Best Practices

### Running Tests

```bash
# Run unit tests only (Node.js environment)
npm test

# Run tests with coverage (fails below the thresholds in vitest.config.ts)
npm run test:coverage

# Run tests in watch mode during development
npm run test:watch

# Run only integration tests
npm run test:integ
```

### Test Requirements

- **Coverage**: `npm run test:coverage` fails below 60% lines, functions and statements, or 50% branches
- **Unit Tests**: Test individual functions in `src/**/__tests__/**` directories
- **Integration Tests**: Test complete workflows against live AgentCore in `tests_integ/`
- **TSDoc Coverage**: All exported functions must have complete documentation

For detailed testing patterns and examples, see [docs/TESTING.md](docs/TESTING.md).

### Documentation Updates

**Important**: When implementing changes that impact the following files, you must update them:

- **AGENTS.md**: Agent-specific development guidance (directory structure, coding patterns, testing patterns, things to do/not do)
- **README.md**: Project overview, getting started guide, usage examples, public API documentation
- **CONTRIBUTING.md**: Human contribution guidelines (development requirements, testing procedures, PR process)

## Reporting Bugs/Feature Requests

We welcome you to use the GitHub issue tracker to report bugs or suggest features.

When filing an issue, please check existing open, or recently closed, issues to make sure somebody else hasn't already reported the issue. Please try to include as much information as you can. Details like these are incredibly useful:

- A reproducible test case or series of steps
- The version of our code being used
- Any modifications you've made relevant to the bug
- Anything unusual about your environment or deployment

## Contributing via Pull Requests

Contributions via pull requests are much appreciated. Before sending us a pull request, please ensure that:

1. You are working against the latest source on the _main_ branch.
2. You check existing open, and recently merged, pull requests to make sure someone else hasn't addressed the problem already.
3. You open an issue to discuss any significant work - we would hate for your time to be wasted.

To send us a pull request, please:

1. Fork the repository.
2. Create a feature branch from `main`.
3. Make your changes, ensuring code quality and test coverage.
4. Run the quality checks. The pre-commit hook only lints and formats staged files, so run the rest yourself:
   ```bash
   npm run test:coverage  # Unit tests, must meet the coverage thresholds
   npm run lint           # No linting errors allowed
   npm run format:check   # Code must be properly formatted
   npm run type-check:all # Source and tests must type-check
   ```
5. Update relevant documentation files (see Documentation Updates section above).
6. Commit to your fork using clear, conventional commit messages.
7. Send us a pull request, answering any default questions in the pull request interface.
8. Pay attention to any automated CI failures reported in the pull request, and stay involved in the conversation.

### Pull Request Requirements

- **All tests pass**: coverage thresholds in `vitest.config.ts` maintained
- **Code quality**: ESLint passes with no errors
- **Documentation**: TSDoc comments for all exported functions
- **Formatting**: Prettier formatting applied consistently
- **Type safety**: No `any` types allowed, explicit return types required
- **Conventional commits**: Use conventional commit message format

GitHub provides additional documentation on [forking a repository](https://help.github.com/articles/fork-a-repo/) and
[creating a pull request](https://help.github.com/articles/creating-a-pull-request/).

## Finding contributions to work on

Looking at the existing issues is a great way to find something to contribute on. As our projects, by default, use the default GitHub issue labels (enhancement/bug/duplicate/help wanted/invalid/question/wontfix), looking at any 'help wanted' issues is a great place to start.

## Code of Conduct

This project has adopted the [Amazon Open Source Code of Conduct](https://aws.github.io/code-of-conduct).
For more information see the [Code of Conduct FAQ](https://aws.github.io/code-of-conduct-faq) or contact
opensource-codeofconduct@amazon.com with any additional questions or comments.

## Security issue notifications

If you discover a potential security issue in this project we ask that you notify AWS/Amazon Security via our [vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do **not** create a public github issue.

## Licensing

See the [LICENSE](LICENSE) file for our project's licensing. We will ask you to confirm the licensing of your contribution.

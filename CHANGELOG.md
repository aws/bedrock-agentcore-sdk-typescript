# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).






## [0.4.0] - 2026-06-30

### Added
- feat: add extractionMode support to AgentCoreEventSender (#200) (e46b183)

### Fixed
- fix: govcloud support (#206) (3558f03)

## [0.3.0] - 2026-06-25

### Other Changes
- fix(runtime/shell): apply prettier formatting to session.ts (#201) (4e65fe0)
- fix(runtime/shell): make reconnect spec-conformant (#199) (a59fdb0)
- feat(memory): add AgentCore Memory Strands integration (experimental) (#187) (773c6cc)
- feat(runtime): add interactive shell support (InvokeAgentRuntimeCommandShell) (#197) (67fbfb5)
- ci: add Claude Code /security-review workflow on PRs (#188) (22a2fac)
- feat(workflows): add closed-PR comment redirect (#179) (fc0b7ae)
- test: add integration tests asserting no user content in OTEL spans (#176) (8fe9106)
- chore: replace all github.token/GITHUB_TOKEN with GitHub App token (#167) (2e4adf4)

## [0.2.4] - 2026-05-12

### Fixed
- fix: resolve tsdoc lint error blocking release workflow (#169) (093e76d)

### Other Changes
- chore(deps): bump fast-uri from 3.1.0 to 3.1.2 (#162) (aae7635)
- chore(deps): bump fast-xml-builder from 1.1.5 to 1.2.0 (#161) (8092844)
- chore: replace PAT token with GitHub App token (#166) (1d57d60)
- fix(runtime): read PORT from environment instead of hardcoding 8080 (#148) (25a5ef7)

## [0.2.3] - 2026-04-30

### Added
- feat: support on-behalf-of token exchange and additional parameters (#149) (91d7e0a)

### Fixed
- fix: return time_of_last_update as Unix timestamp in seconds (#129) (05b59d1)
- fix: prevent FST_ERR_REP_INVALID_PAYLOAD_TYPE when streaming SSE responses (#66) (#118) (4bb857e)
- fix: split labeler into separate workflow with pull_request_target for fork PR permissions (#109) (223d85e)

### Other Changes
- revert: bump version to 0.2.3 (#152) (0af605c)
- chore: bump version to 0.2.3 (#150) (a28acfa)
- chore(deps-dev): bump eslint from 9.39.1 to 10.0.3 (#105) (942e7e3)
- chore(deps-dev): bump the development-dependencies group across 1 directory with 12 updates (#113) (c3a63a0)
- chore(deps): bump fast-xml-parser, @aws-sdk/xml-builder, @aws-sdk/client-cognito-identity-provider and @aws-sdk/client-bedrock-runtime (#112) (5cf7d5c)
- ci(deps): bump actions/checkout from 4 to 6 (#99) (06a3207)
- ci(deps): bump amannn/action-semantic-pull-request from 5 to 6 (#101) (80e315c)
- ci(deps): bump trufflesecurity/trufflehog from 3.91.1 to 3.93.8 (#100) (08c23c4)
- ci(deps): bump slackapi/slack-github-action from 2.0.0 to 3.0.1 (#102) (6f7eda8)
- chore(deps-dev): bump hono from 4.11.5 to 4.12.7 (#93) (f82f168)
- chore(deps): bump the production-dependencies group with 10 updates (#104) (3e5a9ae)
- chore(deps-dev): bump jsdom from 28.1.0 to 29.0.0 (#106) (0b15c39)
- chore(deps-dev): bump @types/supertest from 6.0.3 to 7.2.0 (#107) (6adc508)
- feat(browser): support multiple BrowserLiveView instances per page (#97) (975cd37)
- docs(browser): remove multi-instance section from live-view README (#96) (8778c4e)
- docs(browser): Add live-view README with usage guide (#95) (095d913)

## [0.2.2] - 2026-03-12

### Added
- feat: add Slack notification workflow for new issues (#56) (ca67c52)

### Fixed
- fix: escape special characters in Slack notification payload (#58) (abdbb84)

### Other Changes
- feat(browser): Add BrowserLiveView component for DCV live-view streaming (#92) (5e89b17)
- Clarify framework compatibility in README (#91) (c5b3843)
- ci(deps): bump actions/github-script from 7 to 8 (#28) (2f80f49)
- chore(deps-dev): bump @modelcontextprotocol/sdk from 1.25.3 to 1.26.0 (#65) (8be8c30)
- chore(deps-dev): bump minimatch from 3.1.2 to 3.1.5 (#76) (98ed027)
- chore(deps-dev): bump @hono/node-server from 1.19.9 to 1.19.10 (#80) (c680614)
- chore(deps-dev): bump @types/express from 4.17.25 to 5.0.6 (#53) (d106e82)
- chore(deps): bump qs from 6.14.1 to 6.14.2 (#69) (d81342e)
- chore(deps): bump rollup from 4.53.3 to 4.59.0 (#74) (a77ea1f)
- chore(deps-dev): bump ajv from 6.12.6 to 6.14.0 (#89) (0c2a42d)
- chore(deps): bump fast-xml-parser and @aws-sdk/client-bedrock-runtime (#90) (d469924)
- ci(deps): bump aws-actions/configure-aws-credentials from 4 to 5 (#26) (dc98844)
- chore(deps-dev): bump the development-dependencies group across 1 directory with 13 updates (#88) (10db53c)
- ci(deps): bump actions/setup-node from 4 to 6 (#29) (2bfc14f)
- ci(deps): bump actions/upload-artifact from 4 to 5 (#27) (0b0a175)
- ci(deps): bump actions/download-artifact from 4 to 6 (#25) (da80efc)
- chore(deps): bump fastify from 5.7.4 to 5.8.1 (#83) (42bbe18)
- chore(deps-dev): bump hono from 4.11.5 to 4.12.7 (#85) (026909b)
- chore(deps): bump the production-dependencies group across 1 directory with 10 updates (#78) (b948dcc)
- chore(deps-dev): bump @types/node from 24.10.9 to 25.0.10 (#54) (e2d0926)
- Fix PR list formatting in Slack notification (#86) (b178b9a)
- Add daily Slack notification for open PRs (#84) (caaef3a)
- Add proxy, extensions, and profile configuration support to TypeScript SDK (#72) (1453a15)
- chore: bump version to 0.2.1 (#63) (e87908c)
- docs(readme): fix incorrect code examples    (#50) (5e3cf94)

## [Unreleased]

### Added
- Add proxy, extensions, and profile configuration support for browser sessions (#72)


## [0.2.1] - 2026-02-03

### Added
- feat: add Slack notification workflow for new issues (#56) (ca67c52)

### Fixed
- fix: escape special characters in Slack notification payload (#58) (abdbb84)

### Other Changes
- docs(readme): fix incorrect code examples    (#50) (5e3cf94)

## [0.2.0] - 2026-01-22

### Added
- feat: add AsyncLocalStorage-based request context system (14ddf41)
- feat: enhance logging configuration with FastifyLoggerOptions (0a54bb9)
- feat: add request-scoped logger to handler context (b9261dd)
- feat: mark Strands SDK integration as experimental (#53) (60c3e87)
- feat: add Strands SDK integration for CodeInterpreter and Browser tools (#38) (cc64712)
- feat: Allowed Customers to specify request object using zod  (#34) (c442424)
- feat: add session management features for Python SDK parity (3c71667)
- feat:  Added Websocket integration, refactored runtime's integ tests and refactor BedrockAgentCoreRuntimeApp's Constructor (#16) (18af927)
- feat: add authorizationServerMetadata support for OAuth2 providers (af1ff3b)
- feat: implement AgentCore Identity SDK (692b6e2)
- feat: add OAuth bearer token authentication to RuntimeClient (0161e61)
- feat: implement RuntimeClient for WebSocket authentication (a67d746)
- feat: Added integ test instructions (c7c5a20)
- feat: add client disconnect handling for streaming responses (d17b8aa)
- feat: add BedrockAgentCoreApp HTTP server for runtime hosting (15e5282)
- feat: Updated to use local agent runner (c463f5f)
- feat: Added Strands Agent runners (24c15b3)
- feat: Added a new AGENTS.md for github workflow agents (5a5f0d3)

### Fixed
- fix: preserve AsyncLocalStorage context during async generator streaming (1bff14a)
- fix: respect Accept header for non-streaming responses in SSE mode (869e8a0)
- fix: handle non-streaming responses when SSE mode is active (e6f77b7)
- fix: use toMatchObject in integration tests for AWS SDK responses (d083702)
- fix: testing updates and typing fixes, constructor object usage fix, and update TESTING.md (#32) (a30c2ea)
- fix: Update Handler type to yield SSESource and add comprehensive SSE tests (#27) (ae88d87)
- fix: Return a 406 when streaming request is missing Accept header (#24) (bf1715f)
- fix: update workloadAccessToken tests for Fastify (680e17b)
- fix: Fixed Websocket functions in RuntimeClient (9b55862)
- fix: Update lock package and linted package (8647581)
- fix: Added global types URL (39dd49b)
- fix: actually apply constructor API changes to BedrockAgentCoreApp (9120fc5)
- fix: address review comments and add streaming support (88be5c0)
- fix: Update issueNumber to grab from github.event.pull_request.number too in cjs (eaebef9)
- fix: Update issueNumber to grab from github.event.pull_request.number too (51d6a46)
- fix: enable /strands commands in inline PR review comments (344dc67)
- fix: Added additional tools to agent runner (820f068)
- fix: Updated to use more control github tool (ed565b0)
- fix: Updated to use more control github tool (674cf1f)
- fix: Using Strands-agent for agent-runners (bae7727)
- fix: Updated TESTING.md to use vitest (16ad3b4)
- fix: Added PR Template (905847d)
- fix: enable manual approval for PRs modifying sensitive files (#47) (294c122)
- fix: improve examples reliability and reduce token usage and update release workflow to remove dry run (#23) (d8b2778)

### Documentation
- docs: readme rewrite (#45) (0c785ae)
- docs: update identity README to reflect public API changes (d36a64e)

### Other Changes
- fix(code-interpreter): use directoryPath parameter for listFiles command (#44) (63d64aa)
- test: add unit tests for SSE non-streaming response handling (6c8a5b7)
- Updating not sure if this is what we want (8336da1)
- refactor: simplify SSE non-streaming response handling (3ca9904)
- test: add comprehensive context flow tests for identity wrappers (af9f170)
- chore: upgrade Fastify to 5.7.1 (031270e)
- refactor: improve logging with Fastify logger best practices (a2d3e17)
- fix(docs): correct package name in JSDoc examples (#37) (c2c0e32)
- fix(jsdoc): correct API examples to use invocationHandler (#39) (38447bd)
- fix(code-interpreter): handle binary blob in readFiles response (#42) (8bcb614)
- fix(identity): improve HOF wrapper type inference (7b67887)
- chore: remove examples directory (#36) (06c78ba)
- refactor: remove IdentityClient from public API and clean up unused types (fc0f720)
- refactor(identity): remove thin wrapper methods from IdentityClient (394d8aa)
- Move ping handler to constructor (a5b5287)
- Update to use Fastify type (a9c0d0f)
- Support content type parser (53700cc)
- test: add concurrent request tests for Identity client (26e80c5)
- test: add concurrency tests for runtime app (5c5ebf3)
- test: add comprehensive unit tests for endpoints utility (5e1ad94)
- Replace unreliable OAuth2 tests with complete M2M integration test (cd4944d)
- feat(runtime): add validation to asyncTask decorator (f90e78f)
- feat(runtime): add tests and documentation for dynamic health check (Phase 4) (3338fd9)
- feat(runtime): add developer features for health check (Phase 2) (d104332)
- feat(runtime): implement dynamic health check status (Phase 1) (7b865fb)
- Fix identity integration tests (dc4dca6)
- Accidentally forgot to add the word run to the command (200624c)
- Update to use npm clean (28e7d70)
- Fix Rollup dependency issue in CI workflow (5185f7c)
- refactor(identity): use discriminated union for OAuth2ProviderConfig (d05a6e8)
- refactor: address PR review feedback (a282be4)
- Use Fastify (#20) (a39aab8)
- test: update integration tests to use new constructor API (17bb607)
- refactor!: constructor takes handler parameter, improve type safety (7706703)
- refactor: extract route handlers and simplify disconnect checks (476e516)
- Updated AGENTS.md to include naming conventions (23d71ed)
- Updated integration testing workflow (02e67d6)
- add use_github to agent-restricted.yml (e700767)
- add agent_runner.py to tools (ff08fd1)
- Make agent-restricted work in this package (39103d3)
- add agent-restricted and action.yml (97447dc)
- fix(code-interpreter): use directoryPath parameter for listFiles command (#44) (5e8ccef)
- Remove bedrock-agent-runtime dependency (#24) (38c92a5)

## [0.1.1] - 2025-11-26

### Added
- feat: add comprehensive Vercel AI SDK examples and tests (e6d43d5)

### Fixed
- fix: release workflow (fcdfe5f)

### Documentation
- docs: improve SDK scope visibility and browser automation description (#17) (39a3b3d)
- docs: fix double slash in AWS CLI documentation URL (5175eb9)
- docs: update README links to TypeScript repository (71aad2d)

### Other Changes
- chore: bump version to 0.1.0 (#20) (1543943)
- chore: reset version for automated release (#19) (d096378)
- Merge pull request #15 from aws/feat/add-vercel-ai-examples (f65370c)
- chore: update package-lock.json for tsx dependency (9af2dad)
- Merge pull request #14 from aws/feat/add-integration-test (540a9e7)
- add integration tests with vercel ai agent (f7fb7e7)
- Merge pull request #13 from aws/feat/add-release-workflows (117d6a8)
- Merge pull request #9 from aws/dependabot/npm_and_yarn/production-dependencies-ead6c4027e (a98a304)
- Merge pull request #8 from aws/dependabot/npm_and_yarn/development-dependencies-15e84b682e (6b847c8)
- chore(deps): bump the production-dependencies group with 4 updates (5ff3c30)
- chore(deps-dev): bump the development-dependencies group with 4 updates (dbbbcf4)
- Merge pull request #10 from aws/dependabot/npm_and_yarn/ai-sdk/amazon-bedrock-4.0.0-beta.67 (0376419)
- Merge pull request #5 from aws/dependabot/github_actions/actions/checkout-6 (8fb10f2)
- Merge pull request #6 from aws/dependabot/github_actions/actions/upload-artifact-5 (846cda3)
- Merge pull request #4 from aws/dependabot/github_actions/actions/setup-node-6 (573044b)

## [0.1.0] - 2025-11-26

### Added
- feat: add comprehensive Vercel AI SDK examples and tests (e6d43d5)

### Fixed
- fix: release workflow (fcdfe5f)

### Documentation
- docs: improve SDK scope visibility and browser automation description (#17) (39a3b3d)
- docs: fix double slash in AWS CLI documentation URL (5175eb9)
- docs: update README links to TypeScript repository (71aad2d)

### Other Changes
- chore: reset version for automated release (#19) (d096378)
- Merge pull request #15 from aws/feat/add-vercel-ai-examples (f65370c)
- chore: update package-lock.json for tsx dependency (9af2dad)
- Merge pull request #14 from aws/feat/add-integration-test (540a9e7)
- add integration tests with vercel ai agent (f7fb7e7)
- Merge pull request #13 from aws/feat/add-release-workflows (117d6a8)
- Merge pull request #9 from aws/dependabot/npm_and_yarn/production-dependencies-ead6c4027e (a98a304)
- Merge pull request #8 from aws/dependabot/npm_and_yarn/development-dependencies-15e84b682e (6b847c8)
- chore(deps): bump the production-dependencies group with 4 updates (5ff3c30)
- chore(deps-dev): bump the development-dependencies group with 4 updates (dbbbcf4)
- Merge pull request #10 from aws/dependabot/npm_and_yarn/ai-sdk/amazon-bedrock-4.0.0-beta.67 (0376419)
- Merge pull request #5 from aws/dependabot/github_actions/actions/checkout-6 (8fb10f2)
- Merge pull request #6 from aws/dependabot/github_actions/actions/upload-artifact-5 (846cda3)
- Merge pull request #4 from aws/dependabot/github_actions/actions/setup-node-6 (573044b)
- Merge pull request #3 from aws/dependabot/github_actions/actions/labeler-6 (ecb05c3)

## [Unreleased]

### Added

- Initial release of Bedrock AgentCore SDK for TypeScript/JavaScript
- Browser tool with Playwright integration for web automation
- Code Interpreter tool for secure sandboxed code execution
- Vercel AI SDK integrations for both tools
- Comprehensive test suite with unit and integration tests
- TypeScript type definitions and Zod schemas for validation

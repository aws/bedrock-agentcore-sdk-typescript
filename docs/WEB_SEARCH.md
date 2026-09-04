# AgentCore Web Search

How to run web searches from TypeScript against
[Amazon Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/) Web
Search. The per-call API reference lives alongside the code in
[`src/tools/web-search/`](../src/tools/web-search/index.ts).

## What you get

`WebSearchClient` gives you a plain `search(query, options)` that returns typed results:

```typescript
import { WebSearchClient } from 'bedrock-agentcore/web-search'

const client = new WebSearchClient({ region: 'us-east-1', gatewayId: 'my-gateway-abc123' })

const response = await client.search('what shipped in node 24', { maxResults: 5 })
for (const result of response.results) {
  console.log(result.title, result.url)
}

client.close()
```

Calls are authenticated with SigV4 using ordinary AWS credentials, resolved from the Node provider
chain by default. There is no web search API key.

## Prerequisite: a gateway with a web search target

Web search is reachable as an AgentCore Gateway **connector target**, which an agent calls as an MCP
tool. That target has to exist before this client can be used: create a gateway, then add a target
whose connector is `web-search`. The connector only accepts `GATEWAY_IAM_ROLE` as its credential
provider. See "Web search" under Gateway in the
[AgentCore developer guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/).

This SDK does not yet have gateway control-plane helpers (see **Gateway** in the README's feature
list), so create the gateway and the target with the console, the CLI, or
`@aws-sdk/client-bedrock-agentcore-control`. Once it exists, everything below is data plane only.

Web search is offered in `us-east-1`, `eu-west-1` and `ap-northeast-1`. Another region is not
blocked, only warned about, so a newly added region does not need an SDK release.

## Naming the gateway

Pass exactly one of:

| Option            | Use when                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `gatewayId`       | Usual case. The MCP endpoint is derived from the ID and the region.    |
| `gatewayArn`      | You have the ARN. The ID and the region are read out of it.            |
| `gatewayEndpoint` | You already have an MCP endpoint URL, including a local test endpoint. |

`region` is required unless a `gatewayArn` supplies it.

## Tool naming, and why `targetName` saves a round trip

Gateway prefixes every tool it exposes with the name of the target the tool came from, joined by
three underscores. A web search target named `amazon-web-search` surfaces as
`amazon-web-search___WebSearch`, not `WebSearch`.

Give the client `targetName` and it derives that name directly. Leave it out and the first search
spends a `tools/list` call finding a tool named `WebSearch` or ending in `___WebSearch`. Discovery
fails loudly rather than guessing: no match and more than one match both throw, and the
more-than-one message names the candidates.

```typescript
// No tools/list round trip.
const client = new WebSearchClient({
  region: 'us-east-1',
  gatewayId: 'my-gateway-abc123',
  targetName: 'amazon-web-search',
})
```

## Filters

```typescript
const response = await client.search('agentcore release notes', {
  maxResults: 10,
  includeDomains: ['aws.amazon.com'],
  excludeDomains: ['example.com'],
  publishedAfter: '2026-01-01T00:00:00Z',
  publishedBefore: '2026-06-01T00:00:00Z',
})
```

The documented limits are enforced before a request is signed and sent: `query` is 200 characters or
fewer, `maxResults` is 1 to 25 (the service default is 10), and each domain list holds up to 100
entries. A root domain matches its subdomains. The date filters are inclusive, ISO-8601 UTC, and
apply to web results only.

Filter options need connector version 1.2.0 or later on the target. On an earlier version the tool
accepts only `query` and `maxResults`.

**Filters compose with the target's own rules and can never widen them.** A domain is dropped if it
appears on either exclude list, and returned only if it appears on every include list that is set.
So passing `includeDomains` against a target that already has one narrows to the intersection, and
two disjoint include lists return zero results without raising an error. Check the target's
configuration when a filtered search comes back empty.

## Results, and the citation requirement

```typescript
interface WebSearchResult {
  text: string // the snippet relevant to the query, always present
  url?: string
  title?: string
  publishedDate?: string
}
```

`url`, `title` and `publishedDate` are optional because the service reports them only when the index
has them. They are kept on the type because AgentCore's acceptable use terms require source
citations and links to be retained and displayed in any output shown to end users. Bulk extraction,
storage or reproduction, and building a competing index, are not allowed.

`response.searchId` carries the service-assigned identifier for the search, when present.

## IAM

The gateway's service role needs both of:

- `bedrock-agentcore:InvokeGateway` on `arn:aws:bedrock-agentcore:<region>:<account>:gateway/*`
- `bedrock-agentcore:InvokeWebSearch` on the service-owned
  `arn:aws:bedrock-agentcore:<region>:aws:tool/web-search.v1`

The credentials this client resolves need to be allowed to invoke the gateway. An `AccessDenied` on a
search is almost always one of those permissions missing.

## Transport

`GatewayMcpBackend` speaks the subset of MCP streamable HTTP that one tool call needs: `initialize`,
the initialized notification, optionally `tools/list`, then `tools/call`, signing each request with
SigV4. It is deliberately narrow, it is not a general MCP client, and it adds no dependency the SDK
does not already have.

Notes:

- **One session is reused.** `initialize` runs once per backend, including when two searches start
  concurrently. `close()` forgets the session so the next search starts a new one.
- **Both response framings are handled.** A gateway may answer a POST with `application/json` or
  with `text/event-stream`.
- **Per-request timeout** defaults to 30 seconds, set with `timeout`.
- **`fetchImpl`** replaces the fetch implementation, which is how the unit tests run with neither a
  network nor credentials.

## Using a different transport

`search()` and `WebSearchResult` sit above the transport, behind the `WebSearchBackend` interface:

```typescript
export interface WebSearchBackend {
  search(args: WebSearchToolArguments): Promise<unknown>
  close(): void
}
```

Pass `backend` to `WebSearchClient` and it is used as is, with every gateway option rejected. That
keeps a future access path an addition rather than a break for callers. A client that did not create
its backend does not close it.

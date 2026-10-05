import { describe, it, expect } from 'vitest'
import { buildUserAgentSuffix } from '../user-agent.js'
import { SDK_VERSION } from '../version.js'

describe('buildUserAgentSuffix', () => {
  it('reports the SDK and its version', () => {
    expect(buildUserAgentSuffix()).toBe(`bedrock-agentcore/${SDK_VERSION}`)
  })

  it('names the calling framework when one is given', () => {
    expect(buildUserAgentSuffix('langchain')).toBe(`bedrock-agentcore/${SDK_VERSION} (integration_source=langchain)`)
  })

  it('lowercases the framework name so one integration reports one value', () => {
    expect(buildUserAgentSuffix('LangChain')).toContain('(integration_source=langchain)')
  })

  it('keeps hyphens and underscores, which appear in real package names', () => {
    expect(buildUserAgentSuffix('llama-index_v2')).toContain('(integration_source=llama-index_v2)')
  })

  it('drops characters that would let a caller forge headers', () => {
    // A newline here would split the request; a space would end the token early.
    expect(buildUserAgentSuffix('lang\r\nchain: evil')).toContain('(integration_source=langchainevil)')
    expect(buildUserAgentSuffix('a b')).toContain('(integration_source=ab)')
  })

  it('omits the clause when nothing usable is left', () => {
    expect(buildUserAgentSuffix('!!!')).toBe(`bedrock-agentcore/${SDK_VERSION}`)
  })

  it('treats an empty string as no integration source', () => {
    expect(buildUserAgentSuffix('')).toBe(`bedrock-agentcore/${SDK_VERSION}`)
  })
})

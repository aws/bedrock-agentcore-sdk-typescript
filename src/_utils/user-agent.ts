/**
 * User-Agent construction, so calls this SDK makes are identifiable as its own.
 */

import { SDK_VERSION } from './version.js'

/**
 * Characters kept from a caller-supplied integration source.
 *
 * The value reaches an HTTP header, so anything outside this set is dropped rather
 * than escaped: a header carrying a newline is a request-splitting vector, and no
 * legitimate framework name needs more than these characters.
 */
const ALLOWED_INTEGRATION_SOURCE = /[^a-z0-9\-_]/g

/**
 * Builds the token identifying this SDK, optionally naming the framework calling it.
 *
 * Mirrors `build_user_agent_suffix` in the Python SDK so traffic from the two is
 * attributable the same way.
 *
 * @param integrationSource - Framework calling this SDK, for example `langchain`,
 * `crewai` or `strands`. Lowercased, and reduced to letters, digits, hyphens and
 * underscores.
 * @returns A User-Agent token, such as `bedrock-agentcore/0.5.0 (integration_source=langchain)`.
 *
 * @internal
 */
export function buildUserAgentSuffix(integrationSource?: string | undefined): string {
  const base = `bedrock-agentcore/${SDK_VERSION}`

  if (!integrationSource) {
    return base
  }

  const sanitized = integrationSource.toLowerCase().replace(ALLOWED_INTEGRATION_SOURCE, '')

  // An input of only disallowed characters leaves nothing to report, and
  // `(integration_source=)` says less than omitting the clause.
  if (!sanitized) {
    return base
  }

  return `${base} (integration_source=${sanitized})`
}

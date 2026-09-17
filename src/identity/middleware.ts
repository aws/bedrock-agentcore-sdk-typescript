import { HttpRequest } from '@aws-sdk/protocol-http'
import type {
  FinalizeHandler,
  FinalizeHandlerArguments,
  FinalizeHandlerOutput,
  HandlerExecutionContext,
  MetadataBearer,
  MiddlewareStack,
} from '@smithy/types'
import { getContext } from '../runtime/context.js'
import { IDENTITY_WAT_HEADER } from '../runtime/constants.js'

// AWS SDK v3 does not export a generic client interface.
// https://github.com/aws/aws-sdk-js-v3/issues/5856#issuecomment-2096950979
interface AwsClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  middlewareStack: MiddlewareStack<any, MetadataBearer>
}

/**
 * Registers middleware that attaches the WAT header to outbound AWS SDK requests.
 * Only applies to Invoke* operations. No-ops when no WAT is present in context.
 *
 * @param client - Any AWS SDK v3 client instance
 *
 * @example
 * ```typescript
 * import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore'
 * import { withWatPropagation } from 'bedrock-agentcore/identity'
 *
 * const client = new BedrockAgentCoreClient({ region: 'us-west-2' })
 * withWatPropagation(client)
 * ```
 */
export function withWatPropagation(client: AwsClient): void {
  client.middlewareStack.add(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (next: FinalizeHandler<any, any>, context: HandlerExecutionContext): FinalizeHandler<any, any> =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (args: FinalizeHandlerArguments<any>): Promise<FinalizeHandlerOutput<any>> => {
        if (!context.commandName?.startsWith('Invoke')) {
          return next(args)
        }
        const wat = getContext()?.workloadAccessToken
        if (wat && HttpRequest.isInstance(args.request)) {
          args.request.headers[IDENTITY_WAT_HEADER] = wat
        }
        return next(args)
      },
    { step: 'finalizeRequest', priority: 'high', name: 'identityWatPropagation' }
  )
}

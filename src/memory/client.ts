import { BedrockAgentCore, type Conversational } from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControl,
  type CreateMemoryCommandInput,
  type CreateMemoryCommandOutput,
  type GetMemoryCommandInput,
} from '@aws-sdk/client-bedrock-agentcore-control'
import type {
  MemoryClientConfig,
  WaitOptions,
  WaitForMemoriesParams,
  GetLastKTurnsParams,
  BranchInfo,
  DataPlaneMethods,
  ControlPlaneMethods,
} from './types.js'
import { DATA_PLANE_METHODS, CONTROL_PLANE_METHODS } from './types.js'
import { paginateAll, DEFAULT_PAGE_SIZE } from '../_utils/pagination.js'
import { pollUntil } from '../_utils/polling.js'

const DEFAULT_REGION = 'us-west-2'
const DATA_PLANE_SET: Set<string> = new Set(DATA_PLANE_METHODS)
const CONTROL_PLANE_SET: Set<string> = new Set(CONTROL_PLANE_METHODS)

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
interface MemoryPassthroughClient extends DataPlaneMethods, ControlPlaneMethods {}

/**
 * Passthrough layer that routes method calls to the appropriate AWS SDK client.
 * Uses a Proxy to forward calls listed in DATA_PLANE_METHODS and CONTROL_PLANE_METHODS.
 * See: https://www.typescriptlang.org/docs/handbook/declaration-merging.html
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
class MemoryPassthroughClient {
  protected readonly dataPlane: BedrockAgentCore
  protected readonly controlPlane: BedrockAgentCoreControl

  constructor(config?: MemoryClientConfig) {
    const region = config?.region ?? process.env.AWS_REGION ?? DEFAULT_REGION
    const clientConfig = {
      region,
      ...(config?.credentialsProvider && { credentials: config.credentialsProvider }),
    }
    this.dataPlane = config?.dataPlaneClient ?? new BedrockAgentCore(clientConfig)
    this.controlPlane = config?.controlPlaneClient ?? new BedrockAgentCoreControl(clientConfig)

    return new Proxy(this, {
      get(target, prop, receiver): unknown {
        if (typeof prop === 'string') {
          if (DATA_PLANE_SET.has(prop)) {
            const method = (target.dataPlane as unknown as Record<string, (...args: unknown[]) => unknown>)[prop]!
            return method.bind(target.dataPlane)
          }
          if (CONTROL_PLANE_SET.has(prop)) {
            const method = (target.controlPlane as unknown as Record<string, (...args: unknown[]) => unknown>)[prop]!
            return method.bind(target.controlPlane)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
  }
}

/**
 * Client for AWS Bedrock AgentCore Memory.
 *
 * Passthrough methods from both AWS SDK clients are available directly on this
 * class (e.g. `client.createEvent(...)`, `client.createMemory(...)`).
 *
 * @example
 * ```typescript
 * const client = new MemoryClient({ region: 'us-west-2' });
 *
 * await client.createMemory({ name: 'my-mem', eventExpiryDuration: 30, memoryStrategies: [] });
 * await client.createEvent({ memoryId: 'mem-123', actorId: 'u1', sessionId: 's1', payload: [], eventTimestamp: new Date() });
 * ```
 */
class MemoryClient extends MemoryPassthroughClient {
  constructor(config?: MemoryClientConfig) {
    super(config)
  }

  async createMemoryAndWait(input: CreateMemoryCommandInput, opts?: WaitOptions): Promise<CreateMemoryCommandOutput> {
    const created = await this.controlPlane.createMemory(input)
    const memoryId = created.memory!.id!
    await this.controlPlane.waitUntilMemoryCreated({ memoryId } satisfies GetMemoryCommandInput, {
      maxWaitTime: opts?.maxWaitSeconds ?? 300,
      minDelay: opts?.pollIntervalMs ? opts.pollIntervalMs / 1000 : 10,
    })
    const refreshed = await this.controlPlane.getMemory({ memoryId })
    return { memory: refreshed.memory, $metadata: refreshed.$metadata }
  }

  async createOrGetMemory(input: CreateMemoryCommandInput): Promise<CreateMemoryCommandOutput> {
    try {
      return await this.controlPlane.createMemory(input)
    } catch (err: unknown) {
      if (hasName(err, 'ValidationException') && String(err).includes('already exists')) {
        const existingId = await findMemoryIdByName(this.controlPlane, input.name!)
        if (!existingId) throw err
        const resp = await this.controlPlane.getMemory({ memoryId: existingId })
        return { memory: resp.memory, $metadata: resp.$metadata }
      }
      throw err
    }
  }

  async deleteMemoryAndWait(memoryId: string, opts?: WaitOptions): Promise<void> {
    await this.controlPlane.deleteMemory({ memoryId })
    await pollUntil(
      async () => {
        try {
          await this.controlPlane.getMemory({ memoryId })
          return false
        } catch (err: unknown) {
          if (hasName(err, 'ResourceNotFoundException')) return true
          throw err
        }
      },
      {
        maxWaitSeconds: opts?.maxWaitSeconds ?? 300,
        pollIntervalMs: opts?.pollIntervalMs ?? 10_000,
        timeoutErrorMessage: `Memory ${memoryId} was not deleted within ${opts?.maxWaitSeconds ?? 300}s`,
      }
    )
  }

  async waitForMemories(params: WaitForMemoriesParams): Promise<boolean> {
    return pollUntil(
      async () => {
        const resp = await this.dataPlane.retrieveMemoryRecords({
          memoryId: params.memoryId,
          namespace: params.namespace,
          searchCriteria: { searchQuery: params.testQuery ?? 'test' },
        })
        return (resp.memoryRecordSummaries?.length ?? 0) > 0
      },
      {
        maxWaitSeconds: params.maxWaitSeconds ?? 180,
        pollIntervalMs: params.pollIntervalMs ?? 15_000,
        shouldSwallowError: () => true,
      }
    )
  }

  async getLastKTurns(params: GetLastKTurnsParams): Promise<Conversational[][]> {
    const listParams: Record<string, unknown> = {
      memoryId: params.memoryId,
      actorId: params.actorId,
      sessionId: params.sessionId,
      includePayloads: true,
      maxResults: DEFAULT_PAGE_SIZE,
    }

    if (params.branchName && params.branchName !== 'main') {
      listParams.filter = {
        branch: { name: params.branchName, includeParentBranches: params.includeParentBranches ?? false },
      }
    }

    const turns: Conversational[][] = []
    let currentTurn: Conversational[] = []
    let nextToken: string | undefined

    while (turns.length < params.k) {
      const response = await this.dataPlane.listEvents({ ...listParams, nextToken } as Parameters<
        BedrockAgentCore['listEvents']
      >[0])
      const events = response.events ?? []
      if (events.length === 0) break

      for (const event of events) {
        for (const payloadItem of event.payload ?? []) {
          if (payloadItem.conversational) {
            if (payloadItem.conversational.role === 'USER' && currentTurn.length > 0) {
              turns.push(currentTurn)
              currentTurn = []
            }
            currentTurn.push(payloadItem.conversational)
          }
        }
        if (turns.length >= params.k) break
      }

      nextToken = response.nextToken
      if (!nextToken) break
    }

    if (currentTurn.length > 0 && turns.length < params.k) {
      turns.push(currentTurn)
    }

    return turns.slice(0, params.k)
  }

  async listBranches(params: { memoryId: string; actorId: string; sessionId: string }): Promise<BranchInfo[]> {
    const allEvents = await paginateAll(
      (nextToken) =>
        this.dataPlane.listEvents({
          memoryId: params.memoryId,
          actorId: params.actorId,
          sessionId: params.sessionId,
          includePayloads: false,
          nextToken,
        }),
      (page) => page.events,
      (page) => page.nextToken
    )

    const branches = new Map<string, BranchInfo>()
    for (const event of allEvents) {
      const name = event.branch?.name ?? 'main'
      const existing = branches.get(name)
      if (existing) {
        existing.eventCount++
      } else {
        branches.set(name, {
          name,
          rootEventId: event.branch?.rootEventId,
          eventCount: 1,
        })
      }
    }
    return Array.from(branches.values())
  }
}

function hasName(err: unknown, name: string): boolean {
  return typeof err === 'object' && err !== null && 'name' in err && (err as { name: unknown }).name === name
}

async function findMemoryIdByName(controlPlane: BedrockAgentCoreControl, name: string): Promise<string | undefined> {
  let nextToken: string | undefined
  do {
    const resp = await controlPlane.listMemories({ nextToken })
    const match = resp.memories?.find((m) => m.id?.startsWith(`${name}-`) || m.id === name)
    if (match?.id) return match.id
    nextToken = resp.nextToken
  } while (nextToken)
  return undefined
}

export { MemoryClient }

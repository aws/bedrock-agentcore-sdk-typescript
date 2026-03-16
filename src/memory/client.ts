import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import {
  BedrockAgentCoreControlClient,
  CreateMemoryCommand,
  GetMemoryCommand,
  ListMemoriesCommand,
  UpdateMemoryCommand,
  DeleteMemoryCommand,
} from '@aws-sdk/client-bedrock-agentcore-control'
import { v4 as uuidv4 } from 'uuid'

import {
  StrategyType,
  MemoryStatus,
  MessageRole,
  DEFAULT_NAMESPACES,
  DEFAULT_REGION,
  DEFAULT_MAX_WAIT,
  DEFAULT_POLL_INTERVAL,
} from './constants.js'
import type {
  MemoryClientConfig,
  CreateMemoryParams,
  CreateEventParams,
  RetrieveMemoriesParams,
  StrategyConfig,
  NormalizedMemory,
  NormalizedStrategy,
  WaitOptions,
} from './types.js'
import type { StrategyTypeValue } from './constants.js'

/**
 * High-level Bedrock AgentCore Memory client with essential operations.
 *
 * This SDK handles the asymmetric API where:
 * - Input parameters use old field names (memoryStrategies, memoryStrategyId, etc.)
 * - Output responses use new field names (strategies, strategyId, etc.)
 *
 * The SDK automatically normalizes responses to provide both field names for
 * backward compatibility.
 *
 * @example
 * ```typescript
 * const client = new MemoryClient({ region: 'us-west-2' })
 *
 * // Create memory with strategy
 * const memory = await client.createMemoryAndWait({
 *   name: 'my-memory',
 *   strategies: [{
 *     semanticMemoryStrategy: {
 *       name: 'semantic',
 *       description: 'Extract important information'
 *     }
 *   }]
 * })
 *
 * // Save conversation
 * await client.createEvent({
 *   memoryId: memory.memoryId,
 *   actorId: 'user-123',
 *   sessionId: 'session-456',
 *   messages: [
 *     ['Hello', 'USER'],
 *     ['Hi there!', 'ASSISTANT']
 *   ]
 * })
 * ```
 */
export class MemoryClient {
  readonly region: string

  private readonly _controlPlaneClient: BedrockAgentCoreControlClient
  private readonly _dataPlaneClient: BedrockAgentCoreClient

  constructor(config: MemoryClientConfig = {}) {
    this.region = config.region ?? process.env.AWS_REGION ?? DEFAULT_REGION

    const clientConfig = {
      region: this.region,
      ...(config.credentialsProvider && { credentials: config.credentialsProvider }),
    }

    this._controlPlaneClient = new BedrockAgentCoreControlClient(clientConfig)
    this._dataPlaneClient = new BedrockAgentCoreClient(clientConfig)
  }

  // ===========================================================================
  // Memory Management (Control Plane)
  // ===========================================================================

  /**
   * Create a memory with simplified configuration.
   *
   * @param params - Memory creation parameters
   * @returns Created memory (status may be CREATING)
   *
   * @example
   * ```typescript
   * const memory = await client.createMemory({
   *   name: 'my-memory',
   *   strategies: [{
   *     semanticMemoryStrategy: { name: 'semantic' }
   *   }]
   * })
   * ```
   */
  async createMemory(params: CreateMemoryParams): Promise<NormalizedMemory> {
    const { name, strategies = [], description, eventExpiryDays = 90, memoryExecutionRoleArn } = params

    const processedStrategies = this._addDefaultNamespaces(strategies)

    const commandParams: Record<string, unknown> = {
      name,
      eventExpiryDuration: eventExpiryDays,
      memoryStrategies: processedStrategies, // Using old field name for input
      clientToken: uuidv4(),
    }

    if (description !== undefined) {
      commandParams.description = description
    }

    if (memoryExecutionRoleArn !== undefined) {
      commandParams.memoryExecutionRoleArn = memoryExecutionRoleArn
    }

    const response = await this._controlPlaneClient.send(new CreateMemoryCommand(commandParams as any))

    return this._normalizeMemoryResponse(response.memory as unknown as Record<string, unknown>)
  }

  /**
   * Create a memory and wait for it to become ACTIVE.
   *
   * @param params - Memory creation parameters
   * @param options - Wait options
   * @returns Created memory in ACTIVE status
   * @throws TimeoutError if memory doesn't become ACTIVE within maxWait
   * @throws RuntimeError if memory creation fails
   */
  async createMemoryAndWait(params: CreateMemoryParams, options?: WaitOptions): Promise<NormalizedMemory> {
    const memory = await this.createMemory(params)
    const memoryId = memory.memoryId
    return this._waitForMemoryActive(memoryId, options)
  }

  /**
   * Create a memory or return existing one if name already exists.
   */
  async createOrGetMemory(params: CreateMemoryParams): Promise<NormalizedMemory> {
    try {
      return await this.createMemoryAndWait(params)
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'ValidationException' &&
        error.message.includes('already exists')
      ) {
        const memories = await this.listMemories()
        const existing = memories.find((m) => m.name === params.name || m.id.startsWith(params.name))
        if (existing) {
          return existing
        }
      }
      throw error
    }
  }

  /**
   * Get current memory status.
   */
  async getMemoryStatus(memoryId: string): Promise<string> {
    const response = await this._controlPlaneClient.send(new GetMemoryCommand({ memoryId }))
    return (response.memory as unknown as Record<string, unknown>).status as string
  }

  /**
   * List all memories for the account.
   */
  async listMemories(maxResults: number = 100): Promise<NormalizedMemory[]> {
    const memories: NormalizedMemory[] = []
    let nextToken: string | undefined

    while (memories.length < maxResults) {
      const response = await this._controlPlaneClient.send(
        new ListMemoriesCommand({
          maxResults: Math.min(100, maxResults - memories.length),
          ...(nextToken && { nextToken }),
        })
      )

      const items = (response.memories ?? []) as unknown as Record<string, unknown>[]
      for (const memory of items) {
        memories.push(this._normalizeMemoryResponse(memory))
      }

      nextToken = response.nextToken
      if (!nextToken || memories.length >= maxResults) {
        break
      }
    }

    return memories.slice(0, maxResults)
  }

  /**
   * Delete a memory resource.
   */
  async deleteMemory(memoryId: string): Promise<void> {
    await this._controlPlaneClient.send(
      new DeleteMemoryCommand({
        memoryId,
        clientToken: uuidv4(),
      })
    )
  }

  /**
   * Delete a memory and wait for deletion to complete.
   */
  async deleteMemoryAndWait(memoryId: string, options?: WaitOptions): Promise<void> {
    await this.deleteMemory(memoryId)

    const maxWait = options?.maxWait ?? DEFAULT_MAX_WAIT
    const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait * 1000) {
      try {
        await this._controlPlaneClient.send(new GetMemoryCommand({ memoryId }))
        // Still exists, wait
        await this._sleep(pollInterval * 1000)
      } catch (error) {
        if (error instanceof Error && error.name === 'ResourceNotFoundException') {
          return // Successfully deleted
        }
        throw error
      }
    }

    throw new Error(`Memory ${memoryId} was not deleted within ${maxWait} seconds`)
  }

  // ===========================================================================
  // Event Management (Data Plane)
  // ===========================================================================

  /**
   * Save an event of an agent interaction or conversation.
   *
   * This is the basis of short-term memory. If you configured your Memory resource
   * to have MemoryStrategies, then events will be used to extract long-term memory records.
   *
   * @example
   * ```typescript
   * const event = await client.createEvent({
   *   memoryId: 'mem-123',
   *   actorId: 'user-456',
   *   sessionId: 'session-789',
   *   messages: [
   *     ['What is the weather?', 'USER'],
   *     ['Today is sunny!', 'ASSISTANT']
   *   ]
   * })
   * ```
   */
  async createEvent(params: CreateEventParams): Promise<Record<string, unknown>> {
    const { memoryId, actorId, sessionId, messages, eventTimestamp = new Date(), branch } = params

    if (!messages || messages.length === 0) {
      throw new Error('At least one message is required')
    }

    const payload = messages.map(([text, role]) => {
      const roleUpper = role.toUpperCase()
      if (!Object.values(MessageRole).includes(roleUpper as (typeof MessageRole)[keyof typeof MessageRole])) {
        throw new Error(`Invalid role '${role}'. Must be one of: ${Object.values(MessageRole).join(', ')}`)
      }

      return {
        conversational: {
          content: { text },
          role: roleUpper,
        },
      }
    })

    const commandParams: Record<string, unknown> = {
      memoryId,
      actorId,
      sessionId,
      eventTimestamp,
      payload,
    }

    if (branch) {
      commandParams.branch = branch
    }

    const response = await this._dataPlaneClient.send(new CreateEventCommand(commandParams as any))
    return response.event as unknown as Record<string, unknown>
  }

  /**
   * Save a blob event to AgentCore Memory.
   */
  async createBlobEvent(params: {
    memoryId: string
    actorId: string
    sessionId: string
    blobData: unknown
    eventTimestamp?: Date
    branch?: { rootEventId?: string; name: string }
  }): Promise<Record<string, unknown>> {
    const { memoryId, actorId, sessionId, blobData, eventTimestamp = new Date(), branch } = params

    const commandParams: Record<string, unknown> = {
      memoryId,
      actorId,
      sessionId,
      eventTimestamp,
      payload: [{ blob: blobData }],
    }

    if (branch) {
      commandParams.branch = branch
    }

    const response = await this._dataPlaneClient.send(new CreateEventCommand(commandParams as any))
    return response.event as unknown as Record<string, unknown>
  }

  /**
   * List all events in a session.
   */
  async listEvents(params: {
    memoryId: string
    actorId: string
    sessionId: string
    branchName?: string
    includeParentBranches?: boolean
    maxResults?: number
    includePayload?: boolean
  }): Promise<Record<string, unknown>[]> {
    const {
      memoryId,
      actorId,
      sessionId,
      branchName,
      includeParentBranches = false,
      maxResults = 100,
      includePayload = true,
    } = params

    const allEvents: Record<string, unknown>[] = []
    let nextToken: string | undefined

    while (allEvents.length < maxResults) {
      const commandParams: Record<string, unknown> = {
        memoryId,
        actorId,
        sessionId,
        maxResults: Math.min(100, maxResults - allEvents.length),
        includePayloads: includePayload,
      }

      if (nextToken) {
        commandParams.nextToken = nextToken
      }

      // Add branch filter if specified (but not for "main")
      if (branchName && branchName !== 'main') {
        commandParams.filter = {
          branch: { name: branchName, includeParentBranches },
        }
      }

      const response = await this._dataPlaneClient.send(new ListEventsCommand(commandParams as any))

      const events = (response.events ?? []) as unknown as Record<string, unknown>[]
      allEvents.push(...events)

      nextToken = response.nextToken
      if (!nextToken || allEvents.length >= maxResults) {
        break
      }
    }

    return allEvents.slice(0, maxResults)
  }

  /**
   * List all branches in a session.
   */
  async listBranches(params: { memoryId: string; actorId: string; sessionId: string }): Promise<
    Array<{
      name: string
      rootEventId?: string
      firstEventId: string
      eventCount: number
      created: Date | string
    }>
  > {
    const { memoryId, actorId, sessionId } = params

    // Get all events
    const allEvents = await this.listEvents({
      memoryId,
      actorId,
      sessionId,
      maxResults: 10000,
    })

    const branches: Record<
      string,
      {
        name: string
        rootEventId?: string
        firstEventId: string
        eventCount: number
        created: Date | string
      }
    > = {}
    const mainBranchEvents: Record<string, unknown>[] = []

    for (const event of allEvents) {
      const branchInfo = event.branch as Record<string, unknown> | undefined
      if (branchInfo) {
        const branchName = branchInfo.name as string
        if (!branches[branchName]) {
          branches[branchName] = {
            name: branchName,
            ...(typeof branchInfo.rootEventId === 'string' ? { rootEventId: branchInfo.rootEventId } : {}),
            firstEventId: event.eventId as string,
            eventCount: 1,
            created: event.eventTimestamp as Date | string,
          }
        } else {
          branches[branchName].eventCount += 1
        }
      } else {
        mainBranchEvents.push(event)
      }
    }

    const result: Array<{
      name: string
      rootEventId?: string
      firstEventId: string
      eventCount: number
      created: Date | string
    }> = []

    if (mainBranchEvents.length > 0 && mainBranchEvents[0]) {
      result.push({
        name: 'main',
        firstEventId: mainBranchEvents[0].eventId as string,
        eventCount: mainBranchEvents.length,
        created: mainBranchEvents[0].eventTimestamp as Date | string,
      })
    }

    result.push(...Object.values(branches))

    return result
  }

  /**
   * Get the last K conversation turns.
   */
  async getLastKTurns(params: {
    memoryId: string
    actorId: string
    sessionId: string
    k?: number
    branchName?: string
    maxResults?: number
  }): Promise<Array<Array<{ role: string; content: Record<string, unknown> }>>> {
    const { memoryId, actorId, sessionId, k = 5, branchName, maxResults = 100 } = params

    const events = await this.listEvents({
      memoryId,
      actorId,
      sessionId,
      ...(branchName && { branchName }),
      maxResults,
    })

    if (events.length === 0) {
      return []
    }

    const turns: Array<Array<{ role: string; content: Record<string, unknown> }>> = []
    let currentTurn: Array<{ role: string; content: Record<string, unknown> }> = []

    for (const event of events) {
      if (turns.length >= k) {
        break
      }

      const payload = (event.payload ?? []) as Array<Record<string, unknown>>
      for (const item of payload) {
        if (item.conversational) {
          const conv = item.conversational as Record<string, unknown>
          const role = conv.role as string

          // Start new turn on USER message
          if (role === 'USER' && currentTurn.length > 0) {
            turns.push(currentTurn)
            currentTurn = []
          }

          currentTurn.push({
            role,
            content: conv.content as Record<string, unknown>,
          })
        }
      }
    }

    // Don't forget the last turn
    if (currentTurn.length > 0) {
      turns.push(currentTurn)
    }

    return turns.slice(0, k)
  }

  /**
   * Fork a conversation from a specific event to create a new branch.
   */
  async forkConversation(params: {
    memoryId: string
    actorId: string
    sessionId: string
    rootEventId: string
    branchName: string
    messages: [string, string][]
    eventTimestamp?: Date
  }): Promise<Record<string, unknown>> {
    return this.createEvent({
      memoryId: params.memoryId,
      actorId: params.actorId,
      sessionId: params.sessionId,
      messages: params.messages,
      ...(params.eventTimestamp && { eventTimestamp: params.eventTimestamp }),
      branch: {
        rootEventId: params.rootEventId,
        name: params.branchName,
      },
    })
  }

  // ===========================================================================
  // Memory Retrieval (Data Plane)
  // ===========================================================================

  /**
   * Retrieve relevant memories from a namespace.
   *
   * Note: Wildcards (*) are NOT supported in namespaces. You must provide the
   * exact namespace path with all variables resolved.
   *
   * @example
   * ```typescript
   * const memories = await client.retrieveMemories({
   *   memoryId: 'mem-123',
   *   namespace: 'support/facts/session-456',
   *   query: 'customer preferences'
   * })
   * ```
   */
  async retrieveMemories(params: RetrieveMemoriesParams): Promise<Record<string, unknown>[]> {
    const { memoryId, namespace, query, topK = 3 } = params

    if (namespace.includes('*')) {
      console.error('Wildcards are not supported in namespaces. Please provide exact namespace.')
      return []
    }

    try {
      const response = await this._dataPlaneClient.send(
        new RetrieveMemoryRecordsCommand({
          memoryId,
          namespace,
          searchCriteria: {
            searchQuery: query,
            topK,
          },
        })
      )

      return (response.memoryRecordSummaries ?? []) as unknown as Record<string, unknown>[]
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'ResourceNotFoundException') {
          console.warn(`Memory or namespace not found: ${memoryId}, ${namespace}`)
        } else if (error.name === 'ValidationException') {
          console.warn(`Invalid search parameters: ${error.message}`)
        }
      }
      return []
    }
  }

  /**
   * Wait for memory extraction to complete by polling.
   *
   * IMPORTANT: This only works reliably on empty namespaces.
   */
  async waitForMemories(params: {
    memoryId: string
    namespace: string
    testQuery?: string
    maxWait?: number
    pollInterval?: number
  }): Promise<boolean> {
    const { memoryId, namespace, testQuery = 'test', maxWait = 180, pollInterval = 15 } = params

    if (namespace.includes('*')) {
      console.error('Wildcards are not supported in namespaces.')
      return false
    }

    const startTime = Date.now()

    while (Date.now() - startTime < maxWait * 1000) {
      try {
        const memories = await this.retrieveMemories({
          memoryId,
          namespace,
          query: testQuery,
          topK: 1,
        })

        if (memories.length > 0) {
          return true
        }
      } catch {
        // Continue polling
      }

      await this._sleep(pollInterval * 1000)
    }

    return false
  }

  /**
   * Complete conversation turn with LLM callback integration.
   */
  async processTurnWithLlm(params: {
    memoryId: string
    actorId: string
    sessionId: string
    userInput: string
    llmCallback: (userInput: string, memories: Record<string, unknown>[]) => string | Promise<string>
    retrievalNamespace?: string
    retrievalQuery?: string
    topK?: number
    eventTimestamp?: Date
  }): Promise<{
    memories: Record<string, unknown>[]
    response: string
    event: Record<string, unknown>
  }> {
    const { memoryId, actorId, sessionId, userInput, llmCallback, retrievalNamespace, retrievalQuery, topK = 3, eventTimestamp } = params

    // Step 1: Retrieve relevant memories
    let retrievedMemories: Record<string, unknown>[] = []
    if (retrievalNamespace) {
      const searchQuery = retrievalQuery ?? userInput
      retrievedMemories = await this.retrieveMemories({
        memoryId,
        namespace: retrievalNamespace,
        query: searchQuery,
        topK,
      })
    }

    // Step 2: Invoke LLM callback
    const response = await llmCallback(userInput, retrievedMemories)
    if (typeof response !== 'string') {
      throw new Error('LLM callback must return a string response')
    }

    // Step 3: Save the conversation turn
    const event = await this.createEvent({
      memoryId,
      actorId,
      sessionId,
      messages: [
        [userInput, 'USER'],
        [response, 'ASSISTANT'],
      ],
      ...(eventTimestamp && { eventTimestamp }),
    })

    return { memories: retrievedMemories, response, event }
  }

  // ===========================================================================
  // Strategy Management (Control Plane)
  // ===========================================================================

  /**
   * Get all strategies for a memory.
   */
  async getMemoryStrategies(memoryId: string): Promise<NormalizedStrategy[]> {
    const response = await this._controlPlaneClient.send(new GetMemoryCommand({ memoryId }))
    const memory = response.memory as unknown as Record<string, unknown>

    const strategies = (memory.strategies ?? memory.memoryStrategies ?? []) as Record<string, unknown>[]

    return strategies.map((s) => this._normalizeStrategyResponse(s))
  }

  /**
   * Add a semantic memory strategy.
   */
  async addSemanticStrategy(params: {
    memoryId: string
    name: string
    description?: string
    namespaces?: string[]
  }): Promise<NormalizedMemory> {
    const strategy: StrategyConfig = {
      [StrategyType.SEMANTIC]: {
        name: params.name,
        ...(params.description && { description: params.description }),
        ...(params.namespaces && { namespaces: params.namespaces }),
      },
    }

    return this._addStrategy(params.memoryId, strategy)
  }

  /**
   * Add a semantic strategy and wait for memory to return to ACTIVE.
   */
  async addSemanticStrategyAndWait(
    params: { memoryId: string; name: string; description?: string; namespaces?: string[] },
    options?: WaitOptions
  ): Promise<NormalizedMemory> {
    await this.addSemanticStrategy(params)
    return this._waitForMemoryActive(params.memoryId, options)
  }

  /**
   * Add a summary memory strategy.
   */
  async addSummaryStrategy(params: {
    memoryId: string
    name: string
    description?: string
    namespaces?: string[]
  }): Promise<NormalizedMemory> {
    const strategy: StrategyConfig = {
      [StrategyType.SUMMARY]: {
        name: params.name,
        ...(params.description && { description: params.description }),
        ...(params.namespaces && { namespaces: params.namespaces }),
      },
    }

    return this._addStrategy(params.memoryId, strategy)
  }

  /**
   * Add a summary strategy and wait for memory to return to ACTIVE.
   */
  async addSummaryStrategyAndWait(
    params: { memoryId: string; name: string; description?: string; namespaces?: string[] },
    options?: WaitOptions
  ): Promise<NormalizedMemory> {
    await this.addSummaryStrategy(params)
    return this._waitForMemoryActive(params.memoryId, options)
  }

  /**
   * Add a user preference memory strategy.
   */
  async addUserPreferenceStrategy(params: {
    memoryId: string
    name: string
    description?: string
    namespaces?: string[]
  }): Promise<NormalizedMemory> {
    const strategy: StrategyConfig = {
      [StrategyType.USER_PREFERENCE]: {
        name: params.name,
        ...(params.description && { description: params.description }),
        ...(params.namespaces && { namespaces: params.namespaces }),
      },
    }

    return this._addStrategy(params.memoryId, strategy)
  }

  /**
   * Add a user preference strategy and wait for memory to return to ACTIVE.
   */
  async addUserPreferenceStrategyAndWait(
    params: { memoryId: string; name: string; description?: string; namespaces?: string[] },
    options?: WaitOptions
  ): Promise<NormalizedMemory> {
    await this.addUserPreferenceStrategy(params)
    return this._waitForMemoryActive(params.memoryId, options)
  }

  /**
   * Add a custom semantic strategy with prompts.
   */
  async addCustomSemanticStrategy(params: {
    memoryId: string
    name: string
    extractionConfig: { prompt: string; modelId: string }
    consolidationConfig: { prompt: string; modelId: string }
    description?: string
    namespaces?: string[]
  }): Promise<NormalizedMemory> {
    const strategy: StrategyConfig = {
      [StrategyType.CUSTOM]: {
        name: params.name,
        configuration: {
          semanticOverride: {
            extraction: {
              appendToPrompt: params.extractionConfig.prompt,
              modelId: params.extractionConfig.modelId,
            },
            consolidation: {
              appendToPrompt: params.consolidationConfig.prompt,
              modelId: params.consolidationConfig.modelId,
            },
          },
        },
        ...(params.description && { description: params.description }),
        ...(params.namespaces && { namespaces: params.namespaces }),
      },
    }

    return this._addStrategy(params.memoryId, strategy)
  }

  /**
   * Modify an existing strategy.
   */
  async modifyStrategy(params: {
    memoryId: string
    strategyId: string
    description?: string
    namespaces?: string[]
    configuration?: Record<string, unknown>
  }): Promise<NormalizedMemory> {
    const modifyConfig: Record<string, unknown> = {
      memoryStrategyId: params.strategyId, // Using old field name for input
    }

    if (params.description !== undefined) {
      modifyConfig.description = params.description
    }
    if (params.namespaces !== undefined) {
      modifyConfig.namespaces = params.namespaces
    }
    if (params.configuration !== undefined) {
      modifyConfig.configuration = params.configuration
    }

    return this.updateMemoryStrategies({
      memoryId: params.memoryId,
      modifyStrategies: [modifyConfig],
    })
  }

  /**
   * Delete a strategy from a memory.
   */
  async deleteStrategy(memoryId: string, strategyId: string): Promise<NormalizedMemory> {
    return this.updateMemoryStrategies({
      memoryId,
      deleteStrategyIds: [strategyId],
    })
  }

  /**
   * Update memory strategies - add, modify, or delete.
   */
  async updateMemoryStrategies(params: {
    memoryId: string
    addStrategies?: StrategyConfig[]
    modifyStrategies?: Record<string, unknown>[]
    deleteStrategyIds?: string[]
  }): Promise<NormalizedMemory> {
    const { memoryId, addStrategies, modifyStrategies, deleteStrategyIds } = params

    const memoryStrategies: Record<string, unknown> = {}

    if (addStrategies && addStrategies.length > 0) {
      const processed = this._addDefaultNamespaces(addStrategies)
      memoryStrategies.addMemoryStrategies = processed // Using old field name
    }

    if (modifyStrategies && modifyStrategies.length > 0) {
      memoryStrategies.modifyMemoryStrategies = modifyStrategies // Using old field name
    }

    if (deleteStrategyIds && deleteStrategyIds.length > 0) {
      memoryStrategies.deleteMemoryStrategies = deleteStrategyIds.map((id) => ({
        memoryStrategyId: id, // Using old field name
      }))
    }

    if (Object.keys(memoryStrategies).length === 0) {
      throw new Error('No strategy operations provided')
    }

    const response = await this._controlPlaneClient.send(
      new UpdateMemoryCommand({
        memoryId,
        memoryStrategies, // Using old field name for input
        clientToken: uuidv4(),
      })
    )

    return this._normalizeMemoryResponse(response.memory as unknown as Record<string, unknown>)
  }

  /**
   * Update memory strategies and wait for memory to return to ACTIVE.
   */
  async updateMemoryStrategiesAndWait(
    params: {
      memoryId: string
      addStrategies?: StrategyConfig[]
      modifyStrategies?: Record<string, unknown>[]
      deleteStrategyIds?: string[]
    },
    options?: WaitOptions
  ): Promise<NormalizedMemory> {
    await this.updateMemoryStrategies(params)
    return this._waitForMemoryActive(params.memoryId, options)
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Normalize memory response to include both old and new field names.
   */
  private _normalizeMemoryResponse(memory: Record<string, unknown>): NormalizedMemory {
    const normalized: Record<string, unknown> = { ...memory }

    // Ensure both versions of memory ID exist
    if ('id' in normalized && !('memoryId' in normalized)) {
      normalized.memoryId = normalized.id
    } else if ('memoryId' in normalized && !('id' in normalized)) {
      normalized.id = normalized.memoryId
    }

    // Ensure both versions of strategies exist
    if ('strategies' in normalized && !('memoryStrategies' in normalized)) {
      normalized.memoryStrategies = normalized.strategies
    } else if ('memoryStrategies' in normalized && !('strategies' in normalized)) {
      normalized.strategies = normalized.memoryStrategies
    }

    // Normalize strategies within memory
    if (Array.isArray(normalized.strategies)) {
      const normalizedStrategies = (normalized.strategies as Record<string, unknown>[]).map((s) =>
        this._normalizeStrategyResponse(s)
      )
      normalized.strategies = normalizedStrategies
      normalized.memoryStrategies = normalizedStrategies
    }

    return normalized as unknown as NormalizedMemory
  }

  /**
   * Normalize strategy response.
   */
  private _normalizeStrategyResponse(strategy: Record<string, unknown>): NormalizedStrategy {
    const normalized: Record<string, unknown> = { ...strategy }

    // Ensure both field name versions exist
    if ('strategyId' in normalized && !('memoryStrategyId' in normalized)) {
      normalized.memoryStrategyId = normalized.strategyId
    } else if ('memoryStrategyId' in normalized && !('strategyId' in normalized)) {
      normalized.strategyId = normalized.memoryStrategyId
    }

    if ('type' in normalized && !('memoryStrategyType' in normalized)) {
      normalized.memoryStrategyType = normalized.type
    } else if ('memoryStrategyType' in normalized && !('type' in normalized)) {
      normalized.type = normalized.memoryStrategyType
    }

    return normalized as unknown as NormalizedStrategy
  }

  /**
   * Add default namespaces to strategies that don't have them.
   */
  private _addDefaultNamespaces(strategies: StrategyConfig[]): StrategyConfig[] {
    return strategies.map((strategy) => {
      const strategyTypeKey = Object.keys(strategy)[0] as keyof StrategyConfig
      const strategyConfig = { ...strategy[strategyTypeKey] } as Record<string, unknown>

      if (!strategyConfig.namespaces) {
        const defaults = DEFAULT_NAMESPACES[strategyTypeKey as StrategyTypeValue]
        if (defaults) {
          strategyConfig.namespaces = defaults
        } else {
          strategyConfig.namespaces = ['/custom/{actorId}/{sessionId}']
        }
      }

      return { [strategyTypeKey]: strategyConfig } as StrategyConfig
    })
  }

  /**
   * Wait for memory to return to ACTIVE state.
   */
  private async _waitForMemoryActive(memoryId: string, options?: WaitOptions): Promise<NormalizedMemory> {
    const maxWait = options?.maxWait ?? DEFAULT_MAX_WAIT
    const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL
    const startTime = Date.now()

    while (Date.now() - startTime < maxWait * 1000) {
      const status = await this.getMemoryStatus(memoryId)

      if (status === MemoryStatus.ACTIVE) {
        const response = await this._controlPlaneClient.send(new GetMemoryCommand({ memoryId }))
        return this._normalizeMemoryResponse(response.memory as unknown as Record<string, unknown>)
      }

      if (status === MemoryStatus.FAILED) {
        const response = await this._controlPlaneClient.send(new GetMemoryCommand({ memoryId }))
        const memory = response.memory as unknown as Record<string, unknown>
        const failureReason = (memory.failureReason as string) ?? 'Unknown'
        throw new Error(`Memory creation/update failed: ${failureReason}`)
      }

      await this._sleep(pollInterval * 1000)
    }

    throw new Error(`Memory ${memoryId} did not become ACTIVE within ${maxWait} seconds`)
  }

  /**
   * Add a single strategy.
   */
  private async _addStrategy(memoryId: string, strategy: StrategyConfig): Promise<NormalizedMemory> {
    return this.updateMemoryStrategies({
      memoryId,
      addStrategies: [strategy],
    })
  }

  /**
   * Sleep for specified milliseconds.
   */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

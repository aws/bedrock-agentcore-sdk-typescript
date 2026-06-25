import type { MessageData, Role, TextBlockData } from '@strands-agents/sdk'

/** AgentCore conversational role. Mirrors the SDK `Role` enum values we emit. */
export type AgentCoreRole = 'USER' | 'ASSISTANT'

/**
 * Map a Strands message role to the AgentCore conversational role.
 *
 * Strands roles are `'user' | 'assistant'`; AgentCore's `Role` enum also has `OTHER`/`TOOL`, but the
 * conversation-ingestion path only ever produces user/assistant turns, so we map to that subset.
 */
export function mapRole(message: Pick<MessageData, 'role'>): AgentCoreRole {
  return message.role === ('user' satisfies Role) ? 'USER' : 'ASSISTANT'
}

function isTextBlock(block: unknown): block is TextBlockData {
  return typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
}

/**
 * Extract the plain-text content of a message, concatenating its text blocks.
 *
 * AgentCore's conversational payload is text-based, so non-text blocks (tool use/result, images,
 * etc.) contribute nothing here. The coordinator's message filter already strips tool traffic before
 * a message reaches us; this is a defensive flatten of whatever text remains.
 */
export function extractText(message: Pick<MessageData, 'content'>): string {
  // Drop empty/blank text blocks before joining so an empty middle block doesn't leave a stray blank
  // line in the concatenation (mirrors the upstream renderer).
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text.trim())
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * Whether a message is a user/assistant turn carrying extractable text. Tool-only or empty messages
 * yield no useful AgentCore event, so the sender skips them.
 */
export function isUserOrAssistantWithText(message: MessageData): boolean {
  return (message.role === 'user' || message.role === 'assistant') && extractText(message).length > 0
}

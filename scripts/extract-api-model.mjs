#!/usr/bin/env node
// =============================================================================
// extract-api-model.mjs  —  TypeScript SDK -> doc-model JSON
// =============================================================================
// Consumes TypeDoc's JSON output for the `bedrock-agentcore` TS SDK and emits
// the SAME shared doc-model schema (v1) the Python extractor emits, so the one
// shared renderer (_shared/render_adoc.py) produces consistent .adoc.
//
// Upstream step (in the workflow):
//   npx typedoc --json typedoc.json --entryPointStrategy expand src
//
// The TS SDK's tsconfig already has `declaration: true` and
// `removeComments: false`, and classes carry TSDoc (`/** ... @param ... @returns
// ... @example */`), so TypeDoc has everything it needs.
//
// NOTE: if these workflows are later consolidated into a single shared reusable
// workflow, this script is vendored there and selected via `language:
// typescript`. Standalone here for the draft.
// =============================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'

// group id -> title. Decision: include ALL modules.
// Keyed by the source subpath TypeDoc reports so we can bucket entries.
const GROUP_MAP = [
  { id: 'runtime', title: 'Runtime', match: /\/runtime\// },
  { id: 'memory', title: 'Memory', match: /\/memory\// },
  { id: 'identity', title: 'Identity', match: /\/identity\// },
  { id: 'browser-tool', title: 'Browser Tool', match: /\/tools\/browser\// },
  { id: 'code-interpreter', title: 'Code Interpreter', match: /\/tools\/code-interpreter\// },
]

// TypeDoc ReflectionKind values we care about.
const KIND = { Class: 128, Method: 2048, Function: 64, Constructor: 512 }

function getArg(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// Flatten TypeDoc comment summary + block tags into plain text.
function commentText(comment) {
  if (!comment) return ''
  return (comment.summary || [])
    .map((p) => p.text || '')
    .join('')
    .trim()
}

// Split a comment into first-paragraph summary and the remaining description,
// so the renderer doesn't print the same first paragraph twice.
function splitSummaryDescription(comment) {
  const full = commentText(comment)
  const parts = full.split('\n\n')
  return { summary: (parts[0] || '').trim(), description: parts.slice(1).join('\n\n').trim() }
}

function blockTag(comment, tag) {
  if (!comment || !comment.blockTags) return []
  return comment.blockTags
    .filter((t) => t.tag === tag)
    .map((t) =>
      (t.content || [])
        .map((p) => p.text || '')
        .join('')
        .trim()
    )
}

function typeParameterList(typeParameters) {
  if (!typeParameters || typeParameters.length === 0) return ''
  const rendered = typeParameters.map((parameter) => {
    const constraint = parameter.type ? ` extends ${typeToString(parameter.type)}` : ''
    const defaultType = parameter.default ? ` = ${typeToString(parameter.default)}` : ''
    return `${parameter.name}${constraint}${defaultType}`
  })
  return `<${rendered.join(', ')}>`
}

function callableType(signature) {
  const params = (signature.parameters || []).map((parameter) => {
    const rest = parameter.flags?.isRest ? '...' : ''
    const optional = parameter.flags?.isOptional ? '?' : ''
    const renderedType = typeToString(parameter.type) || 'unknown'
    return `${rest}${parameter.name}${optional}: ${renderedType}`
  })
  const result = typeToString(signature.type) || 'void'
  return `${typeParameterList(signature.typeParameters)}(${params.join(', ')}) => ${result}`
}

function reflectionType(declaration) {
  if (!declaration) return 'object'
  if (declaration.signatures?.length) {
    return declaration.signatures.map(callableType).join(' & ')
  }
  if (declaration.children?.length) {
    const properties = declaration.children.map((property) => {
      const optional = property.flags?.isOptional ? '?' : ''
      return `${property.name}${optional}: ${typeToString(property.type) || 'unknown'}`
    })
    return `{ ${properties.join('; ')} }`
  }
  return 'object'
}

export function typeToString(type) {
  if (!type) return null
  switch (type.type) {
    case 'array':
      return `${typeToString(type.elementType) || 'unknown'}[]`
    case 'intersection':
      return (type.types || []).map(typeToString).join(' & ')
    case 'intrinsic':
      return type.name
    case 'literal':
      return type.value === null ? 'null' : JSON.stringify(type.value)
    case 'reference': {
      const name =
        type.qualifiedName && !type.qualifiedName.startsWith('__global.') ? type.qualifiedName : type.name || 'unknown'
      const args = type.typeArguments?.length ? `<${type.typeArguments.map(typeToString).join(', ')}>` : ''
      return `${name}${args}`
    }
    case 'reflection':
      return reflectionType(type.declaration)
    case 'rest':
      return `...${typeToString(type.elementType) || 'unknown'}`
    case 'tuple':
      return `[${(type.elements || []).map(typeToString).join(', ')}]`
    case 'typeOperator':
      return `${type.operator} ${typeToString(type.target) || 'unknown'}`
    case 'union':
      return (type.types || []).map(typeToString).join(' | ')
    default:
      return type.name || type.type || null
  }
}

function signatureText(name, sig) {
  const params = (sig.parameters || []).map((p) => `${p.name}: ${typeToString(p.type) || 'unknown'}`).join(', ')
  const ret = typeToString(sig.type) || 'void'
  return `${name}(${params}): ${ret}`
}

const PARAMETER_DESCRIPTION_OVERRIDES = new Map([
  ['__namedParameters', 'The named browser live view properties.'],
  ['actorId', 'The actor ID.'],
  ['args', 'The arguments to pass.'],
  ['authObj', 'The authentication object to use.'],
  ['config', 'The configuration to use.'],
  ['conn', 'The connection to use.'],
  ['containerHeight', 'The container height in pixels.'],
  ['containerWidth', 'The container width in pixels.'],
  ['customLogger', 'The custom logger to use.'],
  ['data', 'The data to process.'],
  ['displays', 'The displays to use.'],
  ['error', 'The error to process.'],
  ['expectExtraction', 'Specifies whether extraction is expected.'],
  ['field', 'The field to process.'],
  ['fn', 'The function to invoke.'],
  ['frame', 'The frame data to process.'],
  ['height', 'The height in pixels.'],
  ['input', 'The input parameters.'],
  ['message', 'The message to process.'],
  ['messages', 'The messages to send.'],
  ['ns', 'The namespace to use.'],
  ['options', 'The options to use.'],
  ['opts', 'The options to use.'],
  ['params', 'The connection parameters.'],
  ['props', 'The viewer properties.'],
  ['protocols', 'The WebSocket protocols to use.'],
  ['query', 'The search query.'],
  ['reason', 'The reason for the operation.'],
  ['reconnected', 'Specifies whether the connection was reestablished.'],
  ['remoteHeight', 'The remote display height in pixels.'],
  ['remoteWidth', 'The remote display width in pixels.'],
  ['request', 'The incoming request.'],
  ['resolved', 'The resolved value.'],
  ['result', 'The result to process.'],
  ['sequenceNumbers', 'The optional sequence numbers for the messages.'],
  ['sessionId', 'The session ID.'],
  ['shellId', 'The shell ID.'],
  ['socket', 'The WebSocket connection to use.'],
  ['storeConfig', 'The memory store configuration.'],
  ['stores', 'The memory stores to validate. At most one store may be writable.'],
  ['template', 'The template to process.'],
  ['url', 'The URL to use.'],
  ['value', 'The value to process.'],
  ['width', 'The width in pixels.'],
])

function parameterDescription(parameter) {
  const documented = commentText(parameter.comment)
  if (documented) return documented
  if (parameter.name === 'client' && typeToString(parameter.type) === 'PlaywrightBrowser') {
    return 'The PlaywrightBrowser instance to use for browser automation.'
  }
  if (parameter.name === 'client') return 'The client instance to use.'
  return PARAMETER_DESCRIPTION_OVERRIDES.get(parameter.name) || 'The parameter value.'
}

const CALLABLE_DESCRIPTION_OVERRIDES = new Map([
  [
    'assertWritableTopology',
    {
      summary:
        'Validates the memory store topology. At most one store may be writable, ' +
        'and a writable store must be present when extraction is expected.',
      description: '',
    },
  ],
  [
    'createAgentCoreMemoryStores',
    {
      summary: 'Creates AgentCore memory stores for an actor and session.',
      description: '',
    },
  ],
  [
    'isUserOrAssistantWithText',
    {
      summary: 'Checks whether a message contains extractable user or assistant text.',
      description: '',
    },
  ],
  [
    'mapRole',
    {
      summary: 'Maps a Strands message role to an AgentCore conversational role.',
      description: '',
    },
  ],
  [
    'assertResolvedNamespace',
    {
      summary: 'Validates that a resolved namespace contains no unresolved placeholders or braces.',
      description: '',
    },
  ],
  [
    'resolveNamespace',
    {
      summary: 'Resolves actor and session placeholders in a namespace template.',
      description: '',
    },
  ],
  [
    'slugifyNamespace',
    {
      summary: 'Creates a store name from a namespace template.',
      description: '',
    },
  ],
  [
    'runWithContext',
    {
      summary: 'Runs a function within a request context scope.',
      description: '',
    },
  ],
])

const CLASS_DESCRIPTION_OVERRIDES = new Map([
  [
    'BedrockAgentCoreApp',
    {
      summary: 'Hosts agents on Amazon Bedrock AgentCore runtime.',
      description:
        'Provides health check and invocation endpoints for deploying agent handlers. ' +
        'Supports JSON and Server-Sent Events (SSE) response modes.',
    },
  ],
  [
    'AgentCoreRuntimeClient',
    {
      summary: 'Generates WebSocket authentication for Amazon Bedrock AgentCore runtime.',
      description: '',
    },
  ],
  [
    'RuntimeClient',
    {
      summary: 'Generates WebSocket authentication for Amazon Bedrock AgentCore runtime.',
      description: '',
    },
  ],
])

// Build a doc-model entry from a callable reflection (method/function).
function entryFromCallable(refl) {
  const sig = (refl.signatures && refl.signatures[0]) || {}
  const comment = sig.comment || refl.comment
  const params = (sig.parameters || []).map((p) => ({
    name: p.name,
    type: typeToString(p.type),
    required: !(p.flags && p.flags.isOptional),
    description: parameterDescription(p),
  }))
  const returnsDesc = blockTag(comment, '@returns')[0] || ''
  const examples = blockTag(comment, '@example').map((code) => ({
    lang: 'typescript',
    // strip ```typescript fences TSDoc authors often include
    code: code.replace(/^```\w*\n?|\n?```$/g, '').trim(),
  }))
  const sd = splitSummaryDescription(comment)
  const override = CALLABLE_DESCRIPTION_OVERRIDES.get(refl.name)
  if (override) {
    sd.summary = override.summary
    sd.description = override.description
  }
  return {
    kind: 'function',
    name: refl.name,
    signature: signatureText(refl.name, sig),
    summary: sd.summary,
    description: sd.description,
    params,
    returns: returnsDesc ? { type: typeToString(sig.type), description: returnsDesc } : null,
    raises: blockTag(comment, '@throws').map((d) => ({ type: 'Error', description: d })),
    examples,
    members: [],
  }
}

function entryFromClass(refl) {
  const comment = refl.comment
  const examples = blockTag(comment, '@example').map((code) => ({
    lang: 'typescript',
    code: code.replace(/^```\w*\n?|\n?```$/g, '').trim(),
  }))
  const members = (refl.children || [])
    .filter((c) => (c.kind === KIND.Method || c.kind === KIND.Constructor) && !(c.flags && c.flags.isPrivate))
    .map(entryFromCallable)
  const sd = splitSummaryDescription(comment)
  const override = CLASS_DESCRIPTION_OVERRIDES.get(refl.name)
  if (override) {
    sd.summary = override.summary
    sd.description = override.description
  }
  if (refl.name === 'AgentCoreEventSender') {
    sd.summary = 'Sends batches of conversation messages to Amazon Bedrock AgentCore.'
    sd.description = 'If a batch send fails, the operation throws so the caller can retry safely.'
    const sendBatch = members.find((member) => member.name === 'sendBatch')
    if (sendBatch) {
      sendBatch.summary = 'Sends a batch of messages to Amazon Bedrock AgentCore.'
      sendBatch.description = 'If the batch send fails, the operation throws so the caller can retry safely.'
    }
  } else if (refl.name === 'AgentCoreMemoryStore') {
    sd.summary = 'Provides AgentCore memory through the Strands MemoryStore interface.'
    sd.description = 'Supports searching and, when configured as writable, adding conversation messages.'
    const addMessages = members.find((member) => member.name === 'addMessages')
    if (addMessages) {
      addMessages.summary = 'Adds a batch of conversation messages while preserving their roles.'
      addMessages.description = ''
    }
  }
  return {
    kind: 'class',
    name: refl.name,
    signature: refl.name,
    summary: sd.summary,
    description: sd.description,
    params: [],
    returns: null,
    raises: [],
    examples,
    members,
  }
}

function sourcePath(refl) {
  return refl.sources && refl.sources[0] ? refl.sources[0].fileName : ''
}

function groupFor(refl) {
  const path = sourcePath(refl)
  const g = GROUP_MAP.find((gm) => gm.match.test(path))
  return g ? g.id : null
}

function integrationLabel(refl) {
  const match = sourcePath(refl).match(/\/integrations\/(strands|vercel-ai)\//)
  if (!match) return ''
  return match[1] === 'strands' ? 'Strands SDK' : 'Vercel AI SDK'
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function buildModel(doc, version = 'unknown') {
  // Collect all classes + top-level functions across the project tree.
  const buckets = new Map(GROUP_MAP.map((g) => [g.id, []]))
  const walk = (node) => {
    if (!node) return
    if (node.kind === KIND.Class) {
      const gid = groupFor(node)
      if (gid) {
        const label = integrationLabel(node)
        const entry = entryFromClass(node)
        if (label) {
          entry.name = `${entry.name} (${label})`
          entry.anchor = `${gid}-${slug(sourcePath(node))}-${slug(node.name)}`
        }
        buckets.get(gid).push(entry)
      }
    } else if (node.kind === KIND.Function) {
      const gid = groupFor(node)
      if (gid) {
        const label = integrationLabel(node)
        const entry = entryFromCallable(node)
        if (label) {
          entry.name = `${entry.name} (${label})`
          entry.anchor = `${gid}-${slug(sourcePath(node))}-${slug(node.name)}`
        }
        buckets.get(gid).push(entry)
      }
    }
    ;(node.children || []).forEach(walk)
  }
  walk(doc)

  const groups = GROUP_MAP.map((g) => ({
    id: g.id,
    title: g.title,
    summary: '',
    entries: buckets.get(g.id),
  })).filter((g) => g.entries.length > 0)

  return {
    source: 'ts-sdk',
    package: 'bedrock-agentcore',
    version,
    language: 'typescript',
    groups,
  }
}

function main() {
  const typedocPath = getArg('--typedoc')
  const outPath = getArg('--out')
  const version = getArg('--version') || 'unknown'

  const doc = JSON.parse(readFileSync(typedocPath, 'utf8'))
  const model = buildModel(doc, version)
  writeFileSync(outPath, JSON.stringify(model, null, 2))
  process.stderr.write(`Wrote doc-model: ${model.groups.length} groups, version ${version}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

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

import { readFileSync, writeFileSync } from 'node:fs';
import { argv } from 'node:process';

// group id -> title. Decision: include ALL modules.
// Keyed by the source subpath TypeDoc reports so we can bucket entries.
const GROUP_MAP = [
  { id: 'runtime', title: 'Runtime', match: /\/runtime\// },
  { id: 'memory', title: 'Memory', match: /\/memory\// },
  { id: 'identity', title: 'Identity', match: /\/identity\// },
  { id: 'browser-tool', title: 'Browser Tool', match: /\/tools\/browser\// },
  { id: 'code-interpreter', title: 'Code Interpreter', match: /\/tools\/code-interpreter\// },
];

// TypeDoc ReflectionKind values we care about.
const KIND = { Class: 128, Method: 2048, Function: 64, Constructor: 512 };

function getArg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

// Flatten TypeDoc comment summary + block tags into plain text.
function commentText(comment) {
  if (!comment) return '';
  return (comment.summary || []).map((p) => p.text || '').join('').trim();
}

// Split a comment into first-paragraph summary and the remaining description,
// so the renderer doesn't print the same first paragraph twice.
function splitSummaryDescription(comment) {
  const full = commentText(comment);
  const parts = full.split('\n\n');
  return { summary: (parts[0] || '').trim(), description: parts.slice(1).join('\n\n').trim() };
}

function blockTag(comment, tag) {
  if (!comment || !comment.blockTags) return [];
  return comment.blockTags
    .filter((t) => t.tag === tag)
    .map((t) => (t.content || []).map((p) => p.text || '').join('').trim());
}

function typeToString(type) {
  if (!type) return null;
  if (type.name) return type.name;
  if (type.type === 'array' && type.elementType) return `${typeToString(type.elementType)}[]`;
  if (type.type === 'union' && type.types) return type.types.map(typeToString).join(' | ');
  return type.type || null;
}

function signatureText(name, sig) {
  const params = (sig.parameters || [])
    .map((p) => `${p.name}: ${typeToString(p.type) || 'unknown'}`)
    .join(', ');
  const ret = typeToString(sig.type) || 'void';
  return `${name}(${params}): ${ret}`;
}

// Build a doc-model entry from a callable reflection (method/function).
function entryFromCallable(refl) {
  const sig = (refl.signatures && refl.signatures[0]) || {};
  const comment = sig.comment || refl.comment;
  const params = (sig.parameters || []).map((p) => ({
    name: p.name,
    type: typeToString(p.type),
    required: !(p.flags && p.flags.isOptional),
    description: commentText(p.comment),
  }));
  const returnsDesc = blockTag(comment, '@returns')[0] || '';
  const examples = blockTag(comment, '@example').map((code) => ({
    lang: 'typescript',
    // strip ```typescript fences TSDoc authors often include
    code: code.replace(/^```\w*\n?|\n?```$/g, '').trim(),
  }));
  const sd = splitSummaryDescription(comment);
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
  };
}

function entryFromClass(refl) {
  const comment = refl.comment;
  const examples = blockTag(comment, '@example').map((code) => ({
    lang: 'typescript',
    code: code.replace(/^```\w*\n?|\n?```$/g, '').trim(),
  }));
  const members = (refl.children || [])
    .filter((c) => (c.kind === KIND.Method || c.kind === KIND.Constructor) && !(c.flags && c.flags.isPrivate))
    .map(entryFromCallable);
  const sd = splitSummaryDescription(comment);
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
  };
}

function sourcePath(refl) {
  return refl.sources && refl.sources[0] ? refl.sources[0].fileName : '';
}

function groupFor(refl) {
  const path = sourcePath(refl);
  const g = GROUP_MAP.find((gm) => gm.match.test(path));
  return g ? g.id : null;
}

function main() {
  const typedocPath = getArg('--typedoc');
  const outPath = getArg('--out');
  const version = getArg('--version') || 'unknown';

  const doc = JSON.parse(readFileSync(typedocPath, 'utf8'));

  // Collect all classes + top-level functions across the project tree.
  const buckets = new Map(GROUP_MAP.map((g) => [g.id, []]));
  const walk = (node) => {
    if (!node) return;
    if (node.kind === KIND.Class) {
      const gid = groupFor(node);
      if (gid) buckets.get(gid).push(entryFromClass(node));
    } else if (node.kind === KIND.Function) {
      const gid = groupFor(node);
      if (gid) buckets.get(gid).push(entryFromCallable(node));
    }
    (node.children || []).forEach(walk);
  };
  walk(doc);

  const groups = GROUP_MAP.map((g) => ({
    id: g.id,
    title: g.title,
    summary: '',
    entries: buckets.get(g.id),
  })).filter((g) => g.entries.length > 0);

  const model = {
    source: 'ts-sdk',
    package: 'bedrock-agentcore',
    version,
    language: 'typescript',
    groups,
  };
  writeFileSync(outPath, JSON.stringify(model, null, 2));
  process.stderr.write(`Wrote doc-model: ${groups.length} groups, version ${version}\n`);
}

main();

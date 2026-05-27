import type { PermissionsManifest, SkillManifest } from '@asr/core';
import { type AgentTarget, mapTools } from './tool-mapping.js';

export interface GeneratePersonaOptions {
  agent?: AgentTarget;
}

function upstreamFromPermissions(perms: PermissionsManifest): string[] {
  const tools: string[] = [];
  if (perms.filesystem === 'read-own') {
    tools.push('file-read');
  } else if (perms.filesystem === 'read-write-own') {
    tools.push('file-read', 'file-write', 'file-edit');
  }
  if (perms.subprocess) tools.push('shell');
  if (perms.network) tools.push('web');
  return tools;
}

function needsYamlQuoting(value: string): boolean {
  if (value === '') return true;
  if (/^[\s'"]/.test(value)) return true;
  if (/[:#&*!|>%@`]/.test(value)) return true;
  if (/[\r\n]/.test(value)) return true;
  return false;
}

function yamlScalar(value: string): string {
  if (!needsYamlQuoting(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlList(values: readonly string[]): string {
  return values.join(', ');
}

function dedupePreserveOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function buildInject(
  manifest: SkillManifest,
  content: string,
  allowedTools: readonly string[],
): string {
  const lines: string[] = [
    '---',
    `description: ${yamlScalar(manifest.description)}`,
    'when_to_use: always',
    `allowed-tools: ${yamlList(allowedTools)}`,
    'user-invocable: true',
    'disable-model-invocation: false',
    '---',
    '',
    content.trimEnd(),
    '',
  ];
  return lines.join('\n');
}

function buildDelegate(
  manifest: SkillManifest,
  content: string,
  allowedTools: readonly string[],
  references: readonly string[],
  resolved: Record<string, string>,
): string {
  const argHint = '<task or question>';
  const whenToUse = `Use when ${manifest.description}`;
  const header: string[] = [
    '---',
    `description: ${yamlScalar(manifest.description)}`,
    `argument-hint: ${yamlScalar(argHint)}`,
    `allowed-tools: ${yamlList(allowedTools)}`,
    `when_to_use: ${yamlScalar(whenToUse)}`,
    'user-invocable: true',
    '---',
    '',
    'When invoked, delegate to a focused subagent that executes the task below.',
    '',
  ];

  const body: string[] = [];
  if (references.length > 0) {
    body.push('## Referenced Skills');
    body.push('');
    body.push(
      'The subagent has the following skills available inline. Apply them when relevant to the task:',
    );
    body.push('');
    for (const ref of references) {
      body.push(`### ${ref}`);
      body.push('');
      const refContent = resolved[ref];
      if (refContent === undefined) {
        body.push(`(unresolved reference: ${ref})`);
      } else {
        body.push(refContent.trim());
      }
      body.push('');
    }
  }

  body.push('## Task');
  body.push('');
  body.push(content.trimEnd());
  body.push('');

  return [...header, ...body].join('\n');
}

export function generatePersonaSkillMd(
  manifest: SkillManifest,
  content: string,
  resolved: Record<string, string> = {},
  options: GeneratePersonaOptions = {},
): string {
  if (manifest.kind !== 'persona') {
    throw new Error(
      `generatePersonaSkillMd requires kind:persona manifest, received kind:${manifest.kind}`,
    );
  }

  const agent: AgentTarget = options.agent ?? 'claude';
  const mode = manifest.persona_mode ?? 'inject';

  const upstream = upstreamFromPermissions(manifest.permissions);
  const mappedFromPerms = mapTools(upstream, agent);

  if (mode === 'inject') {
    return buildInject(manifest, content, mappedFromPerms);
  }

  const subagentTool = mapTools(['subagent'], agent);
  const allowed = dedupePreserveOrder([...subagentTool, ...mappedFromPerms]);
  return buildDelegate(manifest, content, allowed, manifest.references ?? [], resolved);
}

export type AgentTarget = 'claude' | 'codex';

export interface ToolMappingEntry {
  readonly claude: readonly string[];
  readonly codex: readonly string[];
}

export const TOOL_MAPPINGS: Readonly<Record<string, ToolMappingEntry>> = {
  'file-read': { claude: ['Read'], codex: ['read'] },
  'file-write': { claude: ['Write', 'Edit'], codex: ['write', 'apply_patch'] },
  'file-edit': { claude: ['Edit'], codex: ['apply_patch'] },
  'file-glob': { claude: ['Glob'], codex: ['glob'] },
  'file-grep': { claude: ['Grep'], codex: ['grep'] },
  'shell': { claude: ['Bash'], codex: ['shell'] },
  'web': { claude: ['WebSearch', 'WebFetch'], codex: ['web_search', 'web_fetch'] },
  'web-search': { claude: ['WebSearch'], codex: ['web_search'] },
  'web-fetch': { claude: ['WebFetch'], codex: ['web_fetch'] },
  'subagent': { claude: ['Agent'], codex: ['subagent'] },
  'notebook': { claude: ['NotebookEdit'], codex: ['notebook_edit'] },
};

const FALLBACK: Readonly<Record<AgentTarget, readonly string[]>> = {
  claude: ['Read', 'Write', 'Bash'],
  codex: ['read', 'write', 'shell'],
};

export function mapTools(upstream: readonly string[], agent: AgentTarget): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of upstream) {
    const entry = TOOL_MAPPINGS[name];
    const candidates = entry ? entry[agent] : FALLBACK[agent];
    for (const tool of candidates) {
      if (!seen.has(tool)) {
        seen.add(tool);
        out.push(tool);
      }
    }
  }
  return out;
}

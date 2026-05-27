import { describe, expect, it } from 'vitest';
import { TOOL_MAPPINGS, mapTools } from './tool-mapping.js';

describe('tool-mapping', () => {
  it('maps spec example: file-read+shell -> Read+Bash for claude', () => {
    expect(mapTools(['file-read', 'shell'], 'claude')).toEqual(['Read', 'Bash']);
  });

  it('maps every documented upstream key to a non-empty list for both agents', () => {
    for (const [upstream, entry] of Object.entries(TOOL_MAPPINGS)) {
      expect(entry.claude.length, `${upstream} claude`).toBeGreaterThan(0);
      expect(entry.codex.length, `${upstream} codex`).toBeGreaterThan(0);
      expect(mapTools([upstream], 'claude').length).toBeGreaterThan(0);
      expect(mapTools([upstream], 'codex').length).toBeGreaterThan(0);
    }
  });

  it('falls back to Read+Write+Bash for unknown names on claude', () => {
    expect(mapTools(['frobnicate'], 'claude')).toEqual(['Read', 'Write', 'Bash']);
  });

  it('falls back to read+write+shell for unknown names on codex', () => {
    expect(mapTools(['frobnicate'], 'codex')).toEqual(['read', 'write', 'shell']);
  });

  it('deduplicates results while preserving first-seen order', () => {
    expect(mapTools(['file-read', 'file-read'], 'claude')).toEqual(['Read']);
    expect(mapTools(['file-write', 'file-edit'], 'claude')).toEqual(['Write', 'Edit']);
    expect(mapTools(['shell', 'file-read', 'shell'], 'claude')).toEqual(['Bash', 'Read']);
  });

  it('expands fan-out mappings like web -> WebSearch+WebFetch', () => {
    expect(mapTools(['web'], 'claude')).toEqual(['WebSearch', 'WebFetch']);
    expect(mapTools(['web'], 'codex')).toEqual(['web_search', 'web_fetch']);
  });

  it('maps subagent and shell across both agents', () => {
    expect(mapTools(['subagent', 'shell'], 'claude')).toEqual(['Agent', 'Bash']);
    expect(mapTools(['subagent', 'shell'], 'codex')).toEqual(['subagent', 'shell']);
  });

  it('returns empty array for empty input', () => {
    expect(mapTools([], 'claude')).toEqual([]);
    expect(mapTools([], 'codex')).toEqual([]);
  });
});

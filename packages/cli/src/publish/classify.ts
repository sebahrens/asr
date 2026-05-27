import type { SkillClassification } from '@asr/core';

const CONTENT_ONLY_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.rst',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.yaml',
  '.yml',
  '.json',
]);

export function classifySkill(files: string[]): SkillClassification {
  const allContentOnly = files.every((file) => {
    const lastDot = file.lastIndexOf('.');
    if (lastDot === -1) {
      return false;
    }

    const extension = file.substring(lastDot).toLowerCase();
    return CONTENT_ONLY_EXTENSIONS.has(extension);
  });

  return allContentOnly ? 'md-only' : 'code-containing';
}

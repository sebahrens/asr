import matter from 'gray-matter';
import { ZodError } from 'zod';
import { skillManifestSchema } from './manifest-schema.js';
import type { SkillManifest, SkillMeta } from './types.js';

const escapeXmlText = (value: string): string =>
  value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return char;
    }
  });

export function parseSkillMd(content: string): SkillMeta & { body: string } {
  const { data, content: body } = matter(content);

  return {
    name: data.name || 'unnamed',
    description: data.description || '',
    tags: data.tags || [],
    author: data.author,
    version: data.version,
    body: body.trim(),
  };
}

export function parseSkillManifest(content: string): { manifest: SkillManifest; body: string } {
  const { data, content: body } = matter(content);

  if (Object.keys(data).length === 0) {
    throw new Error('SKILL.md is missing YAML frontmatter');
  }

  try {
    return {
      manifest: skillManifestSchema.parse(data),
      body: body.trim(),
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(
        error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
      );
    }

    throw error;
  }
}

export function generateAgentsMd(skills: SkillMeta[]): string {
  const skillsXml = skills
    .map(
      (s) => `<skill>
<name>${escapeXmlText(s.name)}</name>
<description>${escapeXmlText(s.description)}</description>
<location>project</location>
</skill>`
    )
    .join('\n\n');

  return `<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively.

How to use skills:
- Invoke: \`npx asr read <skill-name>\` (run in your shell)
- The skill content will load with detailed instructions
- Base directory provided in output for resolving bundled resources

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
</usage>

<available_skills>

${skillsXml}

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>`;
}

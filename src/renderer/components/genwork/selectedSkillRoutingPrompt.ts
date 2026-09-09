import type { Skill } from '../../types/skill';

export const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const escapeXmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const isRoutableSkill = (skill: Skill): boolean =>
  skill.enabled && skill.skillPath.trim().length > 0;

export const buildSelectedSkillRoutingPrompt = (skills: Skill[]): string | undefined => {
  const selectedSkills = skills.filter(isRoutableSkill);
  if (selectedSkills.length === 0) return undefined;

  const skillEntries = selectedSkills.map((skill) => {
    const location = skill.skillPath.trim();
    return [
      '  <skill>',
      `    <id>${escapeXmlText(skill.id)}</id>`,
      `    <name>${escapeXmlText(skill.name)}</name>`,
      `    <description>${escapeXmlText(skill.description)}</description>`,
      `    <location>${escapeXmlText(location)}</location>`,
      `    <directory>${escapeXmlText(getSkillDirectoryFromPath(location))}</directory>`,
      '  </skill>',
    ].join('\n');
  });

  return [
    '## Selected skills for this turn',
    'The user selected these skills as preferred candidates for this turn.',
    'If one selected skill clearly applies, read its SKILL.md at <location> before using it.',
    'If no selected skill applies, ignore this block and continue normal automatic skill routing.',
    'If multiple selected skills could apply, choose the most specific one first.',
    'Do not read every selected skill up front. Only read additional skills if the first selected skill explicitly references them.',
    '<path_rules>',
    '  Treat <location> as the canonical SKILL.md path.',
    '  Resolve relative file references from each selected skill against its <directory>.',
    '  Do not assume skills are under the current workspace directory.',
    '</path_rules>',
    '',
    '<selected_skills>',
    ...skillEntries,
    '</selected_skills>',
  ].join('\n');
};

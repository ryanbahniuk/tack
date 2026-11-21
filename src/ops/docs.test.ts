import { expect, test } from 'bun:test';
import { docsIndex, findSection, parseSections, searchDocs } from './docs';

test('embedded README and SPEC contain sections and exclude fenced shell comments', () => {
  const index = docsIndex();
  expect(index.some(s => s.doc === 'readme')).toBe(true);
  expect(index.some(s => s.doc === 'spec')).toBe(true);
  expect(index.some(s => s.heading.startsWith('Always use a throwaway state root'))).toBe(false);
  expect(findSection('readme', index.find(s => s.doc === 'readme')!.id).text.length).toBeGreaterThan(0);
  expect(findSection('spec', index.find(s => s.doc === 'spec')!.id).text.length).toBeGreaterThan(0);
});

test('fenced headings stay in their parent and parent sections include subsections', () => {
  const sections = parseSections('readme', '# Parent\n```bash\n# comment\n```\n## Child\nbody\n~~~\n# ignored\n~~~\n# Next');
  expect(sections.map(s => s.heading)).toEqual(['Parent', 'Child', 'Next']);
  expect(sections[0]!.text).toContain('## Child\nbody');
  expect(sections[0]!.text).not.toContain('# Next');
});

test('sections resolve by deduplicated id or case-insensitive heading and misses list candidates', () => {
  const sections = parseSections('spec', '# Hello World\n# Hello World\n# Other');
  expect(findSection('spec', 'hello-world-1', sections)).toBe(sections[1]!);
  expect(findSection('spec', 'HELLO WORLD', sections)).toBe(sections[0]!);
  expect(() => findSection('spec', 'missing', sections)).toThrow('Hello World');
});

test('search ranks a heading match above a body-only match', () => {
  const sections = parseSections('readme', '# Body\nneedle\n# Needle\ntext');
  expect(searchDocs('needle', 8, sections).map(s => s.heading)).toEqual(['Needle', 'Body']);
});

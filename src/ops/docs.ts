import readme from '../../README.md' with { type: 'text' };
import spec from '../../SPEC.md' with { type: 'text' };

export type Doc = 'readme' | 'spec';
export type Section = { doc: Doc; id: string; heading: string; level: number; text: string };

export function parseSections(doc: Doc, markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/), headings: { heading: string; level: number; line: number; id: string }[] = [];
  const used = new Set<string>();
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (marker) { fence = { char: marker[1]![0]!, length: marker[1]!.length }; continue; }
    const match = line.match(/^ {0,3}(#{1,6})(?:\s+|$)(.*)$/);
    if (!match) continue;
    const heading = match[2]!.replace(/\s+#+\s*$/, '').trim();
    const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    let id = slug, n = 1;
    while (used.has(id)) id = `${slug}-${n++}`;
    used.add(id);
    headings.push({ heading, level: match[1]!.length, line: i, id });
  }
  return headings.map((h, i) => {
    const end = headings.slice(i + 1).find(next => next.level <= h.level)?.line ?? lines.length;
    return { doc, id: h.id, heading: h.heading, level: h.level, text: lines.slice(h.line, end).join('\n').trimEnd() };
  });
}

const sections = [...parseSections('readme', readme), ...parseSections('spec', spec)];
export function docsIndex(source: Section[] = sections) {
  return source.map(({ doc, id, heading, level }) => ({ doc, id, heading, level }));
}
export function findSection(doc: Doc, idOrHeading: string, source: Section[] = sections): Section {
  const candidates = source.filter(s => s.doc === doc), query = idOrHeading.toLowerCase();
  const found = candidates.find(s => s.id.toLowerCase() === query) ?? candidates.find(s => s.heading.toLowerCase() === query);
  if (found) return found;
  const terms = query.split(/\W+/).filter(Boolean);
  const closest = [...candidates].sort ( (a, b) => terms.filter(t => b.heading.toLowerCase().includes(t)).length - terms.filter(t => a.heading.toLowerCase().includes(t)).length ).slice(0, 8);
  throw new Error(`Unknown ${doc} section "${idOrHeading}". Closest headings: ${closest.map(s => s.heading).join(', ')}`);
}
export function searchDocs(query: string, limit = 8, source: Section[] = sections) {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  return source.map(s => {
    const heading = s.heading.toLowerCase(), body = s.text.slice(s.text.indexOf('\n') + 1).toLowerCase();
    const score = terms.reduce((sum, term) => sum + (heading.includes(term) ? 10 : 0) + (body.includes(term) ? 1 : 0), 0);
    const pos = terms.map(term => s.text.toLowerCase().indexOf(term)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    return { doc: s.doc, id: s.id, heading: s.heading, snippet: s.text.slice(Math.max(0, pos - 80), Math.max(0, pos - 80) + 240), score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...hit }) => hit);
}

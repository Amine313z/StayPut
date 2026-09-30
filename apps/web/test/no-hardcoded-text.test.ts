import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * SPEC rule 5: no text written in the components; every word comes from packages/i18n. This
 * walks every .tsx file of src/ and refuses words in JSX text, in `{'…'}` children, and in the
 * attributes a user reads or hears (aria-label, title, alt, placeholder).
 */

const SRC = path.resolve(import.meta.dirname, '../src');
const READ_ATTRIBUTES = new Set(['aria-label', 'title', 'alt', 'placeholder']);
const HAS_WORD = /\p{L}{2,}/u;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

function hardcodedTexts(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const where = (node: ts.Node) =>
    `${path.relative(SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && HAS_WORD.test(node.text)) {
      found.push(`${where(node)} text "${node.text.trim()}"`);
    }
    if (
      ts.isJsxExpression(node) &&
      node.expression &&
      ts.isJsxElement(node.parent) &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      HAS_WORD.test(node.expression.text)
    ) {
      found.push(`${where(node)} child "${node.expression.text}"`);
    }
    if (
      ts.isJsxAttribute(node) &&
      READ_ATTRIBUTES.has(node.name.getText(source)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      HAS_WORD.test(node.initializer.text)
    ) {
      found.push(`${where(node)} ${node.name.getText(source)}="${node.initializer.text}"`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('no hard-coded text in the screens', () => {
  it('finds the components to check', () => {
    expect(tsxFiles(SRC).length).toBeGreaterThan(5);
  });

  it('uses t() for every word a user reads', () => {
    expect(tsxFiles(SRC).flatMap(hardcodedTexts)).toEqual([]);
  });

  it('catches a hard-coded text (the check itself works)', () => {
    const probe = path.join(import.meta.dirname, 'fixtures', 'Hardcoded.tsx');
    expect(hardcodedTexts(probe)).toHaveLength(3);
  });
});

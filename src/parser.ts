/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type TokenKind = 'number' | 'string' | 'datetime' | 'guid' | 'base64' | 'lbrace' | 'rbrace' | 'comma' | 'whitespace' | 'other';

export interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const len = text.length;
  let i = 0;

  const whitespaceRe = /\s/;

  while (i < len) {
    const ch = text[i];
    const start = i;

    if (ch === '{') {
      tokens.push({ kind: 'lbrace', start, end: start + 1 });
      i++;
      continue;
    }

    if (ch === '}') {
      tokens.push({ kind: 'rbrace', start, end: start + 1 });
      i++;
      continue;
    }

    if (ch === ',') {
      tokens.push({ kind: 'comma', start, end: start + 1 });
      i++;
      continue;
    }

    if (whitespaceRe.test(ch)) {
      let j = i + 1;
      while (j < len && whitespaceRe.test(text[j])) {
        j++;
      }
      tokens.push({ kind: 'whitespace', start, end: j });
      i = j;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        const c = text[j];
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '"') {
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: 'string', start, end: j });
      i = j;
      continue;
    }

    // GUID: 8-4-4-4-12 шестнадцатеричных символов с дефисами
    const guidMatch = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.exec(text.slice(i));
    if (guidMatch) {
      const j = i + guidMatch[0].length;
      tokens.push({ kind: 'guid', start, end: j });
      i = j;
      continue;
    }

    if (isDigit(ch) || ch === '-' || ch === '+') {
      let j = i + 1;
      while (j < len && isDigitOrDateChar(text[j])) {
        j++;
      }
      const length = j - start;
      const isAllDigits = isDigit(ch);
      const kind: TokenKind = (length === 14 && isAllDigits) ? 'datetime' : 'number';
      tokens.push({ kind, start, end: j });
      i = j;
      continue;
    }

    if (isBase64Char(ch)) {
      let j = i + 1;
      while (j < len && (isBase64Char(text[j]) || whitespaceRe.test(text[j]))) {
        j++;
      }
      tokens.push({ kind: 'base64', start, end: j });
      i = j;
      continue;
    }

    tokens.push({ kind: 'other', start, end: start + 1 });
    i++;
  }

  return tokens;
}

export function parseGuidsMarkdown(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      continue;
    }

    const parts = trimmed.split('|').map(p => p.trim());
    if (parts.length < 4) {
      continue;
    }

    const guid = parts[1];
    const name = parts[2];

    if (!name || !guid) {
      continue;
    }

    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(guid)) {
      continue;
    }

    map.set(guid.toLowerCase(), name);
  }

  return map;
}

export function parseOpcodesMarkdown(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('|')) {
      const parts = trimmed.split('|').map(p => p.trim());
      if (parts.length < 4) {
        continue;
      }

      const opcodeRaw = parts[1];
      const asm = parts[2];
      const opcode = Number.parseInt(opcodeRaw, 10);
      if (Number.isNaN(opcode) || !asm || asm === 'ASM') {
        continue;
      }

      map.set(opcode, asm);
      continue;
    }

    if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t').map(p => p.trim());
      if (parts.length < 2) {
        continue;
      }

      const opcode = Number.parseInt(parts[0], 10);
      const asm = parts[1];
      if (Number.isNaN(opcode) || !asm || asm === 'ASM') {
        continue;
      }

      map.set(opcode, asm);
    }
  }

  return map;
}

export function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

export function isDigitOrDateChar(ch: string): boolean {
  return (ch >= '0' && ch <= '9');
}

export function isBase64Char(ch: string): boolean {
  return (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '+' ||
    ch === '/' ||
    ch === '='
  );
}

/**
 * Находит диапазон "скобочного объекта" в тексте по позиции курсора.
 *
 * Логика:
 * - от `cursorOffset` идём назад до ближайшей открывающейся `{`
 * - затем берём всё содержимое начиная с этой `{` учитывая вложенность до
 *   `}` который закрывает найденную начальную `{`
 *
 * Открывающая и закрывающая скобки попадают в результат.
 */
export function extractSkobkoObjectRange(
  text: string,
  cursorOffset: number,
): { start: number; end: number } | undefined {
  const tokens = tokenize(text);
  const len = text.length;
  const offset = Math.max(0, Math.min(cursorOffset, len));

  // 1) Находим ближайшую (слева от курсора) открывающую скобку `{`.
  let openTokenIndex = -1;

  // Если курсор стоит на `{`, берем именно её.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'lbrace' && t.start <= offset && offset < t.end) {
      openTokenIndex = i;
      break;
    }
  }

  // Иначе идём назад и берем последнюю `{` перед курсором.
  if (openTokenIndex === -1) {
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i];
      if (t.kind === 'lbrace' && t.start < offset) {
        openTokenIndex = i;
        break;
      }
    }
  }

  if (openTokenIndex === -1) {
    return undefined;
  }

  const openToken = tokens[openTokenIndex]!;

  // 2) Идём вправо, считаем вложенность и останавливаемся на `}`,
  // который закрывает начальную `{`.
  let depth = 0;
  for (let i = openTokenIndex; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'lbrace') {
      depth++;
    } else if (t.kind === 'rbrace') {
      depth--;
      if (depth === 0) {
        return { start: openToken.start, end: t.end };
      }
    }
  }

  // Если скобки не сбалансированы.
  return undefined;
}

/**
 * Подсчитывает количество *прямых* (нерекурсивных) элементов для каждого открывающего `{`.
 *
 * Правило "прямых":
 * - вложенный `{ ... }` считается одним элементом для родительского `{ ... }`
 * - элементы внутри вложенного `{ ... }` не учитываются в счётчике родителя
 * - запятые и пробелы не считаются
 */
export function countDirectChildElementsForOpeningBraces(tokens: Token[]): Map<number, number> {
  const counts = new Map<number, number>();

  interface Frame {
    openToken: Token;
    directCount: number;
  }

  const stack: Frame[] = [];

  for (const t of tokens) {
    if (t.kind === 'lbrace') {
      // Вложенный объект — это один элемент для текущего (родительского) кадра.
      if (stack.length > 0) {
        stack[stack.length - 1].directCount++;
      }

      stack.push({ openToken: t, directCount: 0 });
      continue;
    }

    if (t.kind === 'rbrace') {
      const frame = stack.pop();
      if (frame) {
        counts.set(frame.openToken.start, frame.directCount);
      }
      continue;
    }

    // Игнорируем разделители/форматирование.
    if (t.kind === 'comma' || t.kind === 'whitespace') {
      continue;
    }

    // Любой "не-скобочный" токен внутри `{ ... }` — это один прямой элемент.
    if (stack.length > 0) {
      stack[stack.length - 1].directCount++;
    }
  }

  return counts;
}

type ValueNode = PrimitiveNode | ObjectNode;

interface PrimitiveNode {
  type: 'primitive';
  raw: string;
}

interface ObjectNode {
  type: 'object';
  children: ValueNode[];
}

function appendCommaToValueText(text: string): string {
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) {
    return `${text},`;
  }

  return `${text.slice(0, lastNewline + 1)}${text.slice(lastNewline + 1)},`;
}

function parseValueNodes(tokens: Token[], text: string): ValueNode[] | undefined {
  let i = 0;

  const skipIgnorable = () => {
    while (i < tokens.length) {
      const kind = tokens[i].kind;
      if (kind !== 'whitespace' && kind !== 'comma') {
        break;
      }
      i++;
    }
  };

  const parseValue = (): ValueNode | undefined => {
    skipIgnorable();
    if (i >= tokens.length) {
      return undefined;
    }

    const token = tokens[i];
    if (token.kind === 'rbrace') {
      return undefined;
    }

    if (token.kind === 'lbrace') {
      i++;
      const children: ValueNode[] = [];

      while (i < tokens.length) {
        skipIgnorable();
        if (i >= tokens.length) {
          return undefined;
        }

        if (tokens[i].kind === 'rbrace') {
          i++;
          return { type: 'object', children };
        }

        const child = parseValue();
        if (!child) {
          return undefined;
        }
        children.push(child);
      }

      return undefined;
    }

    i++;
    return { type: 'primitive', raw: text.slice(token.start, token.end) };
  };

  const roots: ValueNode[] = [];
  while (i < tokens.length) {
    skipIgnorable();
    if (i >= tokens.length) {
      break;
    }

    if (tokens[i].kind === 'rbrace') {
      return undefined;
    }

    const value = parseValue();
    if (!value) {
      return undefined;
    }
    roots.push(value);
  }

  return roots;
}

function formatAlignedValue(node: ValueNode, depth: number): string {
  const indent = '  '.repeat(depth);

  if (node.type === 'primitive') {
    return `${indent}${node.raw}`;
  }

  if (node.children.length === 1) {
    const childInline = formatAlignedInlineValue(node.children[0]);
    return `${indent}{ ${childInline} }`;
  }

  const lines: string[] = [`${indent}{`];
  for (let index = 0; index < node.children.length; index++) {
    const childText = formatAlignedValue(node.children[index], depth + 1);
    const withComma =
      index < node.children.length - 1 ? appendCommaToValueText(childText) : childText;
    lines.push(withComma);
  }
  lines.push(`${indent}}`);
  return lines.join('\n');
}

function formatAlignedInlineValue(node: ValueNode): string {
  if (node.type === 'primitive') {
    return node.raw;
  }

  if (node.children.length === 0) {
    return '{}';
  }

  if (node.children.length === 1) {
    return `{ ${formatAlignedInlineValue(node.children[0])} }`;
  }

  return `{ ${node.children.map(formatAlignedInlineValue).join(', ')} }`;
}

function writeStandardValue(node: ValueNode, out: string[]): void {
  if (node.type === 'primitive') {
    out.push(node.raw);
    return;
  }

  out.push('\n{');
  for (let i = 0; i < node.children.length; i++) {
    if (i > 0) {
      out.push(',');
    }
    writeStandardValue(node.children[i], out);
  }

  const lastPart = out.length > 0 ? out[out.length - 1] : '';
  let lastNonSpaceChar = '';
  for (let i = lastPart.length - 1; i >= 0; i--) {
    const ch = lastPart[i];
    if (ch !== ' ' && ch !== '\n' && ch !== '\r' && ch !== '\t') {
      lastNonSpaceChar = ch;
      break;
    }
  }

  if (lastNonSpaceChar === '}') {
    out.push('\n');
  }
  out.push('}');
}

export function formatWithAlignment(text: string): string {
  const tokens = tokenize(text);
  const nodes = parseValueNodes(tokens, text);
  if (!nodes) {
    return text;
  }

  const parts = nodes.map(node => formatAlignedValue(node, 0));
  return parts.join('\n');
}

export function formatNormally(text: string): string {
  const tokens = tokenize(text);
  const nodes = parseValueNodes(tokens, text);
  if (!nodes) {
    return text;
  }

  const out: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (i > 0) {
      out.push(' ');
    }
    writeStandardValue(nodes[i], out);
  }

  return out.join('').trimStart();
}

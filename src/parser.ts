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

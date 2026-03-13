import * as vscode from 'vscode';

type TokenKind = 'number' | 'string' | 'datetime' | 'guid' | 'base64' | 'lbrace' | 'rbrace' | 'comma' | 'whitespace' | 'other';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'skobko', scheme: 'file' };

  let guidMapPromise: Promise<Map<string, string>> | undefined;

  const getGuidMap = async (): Promise<Map<string, string>> => {
    if (guidMapPromise) {
      return guidMapPromise;
    }

    guidMapPromise = (async () => {
      const guidsUri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'guids.md');

      try {
        const doc = await vscode.workspace.openTextDocument(guidsUri);
        return parseGuidsMarkdown(doc.getText());
      } catch {
        return new Map<string, string>();
      }
    })();

    return guidMapPromise;
  };

  class SkobkoSymbolProvider implements vscode.DocumentSymbolProvider {
    provideDocumentSymbols(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.DocumentSymbol[]> {
      const text = document.getText();
      const tokens = tokenize(text);

      interface Frame {
        symbol: vscode.DocumentSymbol;
        startOffset: number;
        nextIndex: number;
      }

      const roots: vscode.DocumentSymbol[] = [];
      const stack: Frame[] = [];

      const makeRange = (startOffset: number, endOffset: number): vscode.Range => {
        return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
      };

      let i = 0;
      while (i < tokens.length) {
        const t = tokens[i];

        if (t.kind === 'lbrace') {
          let name: string;
          if (stack.length === 0) {
            // корневой элемент
            name = 'element';
          } else {
            const parent = stack[stack.length - 1];
            const idx = parent.nextIndex++;
            name = `[${idx}]`;
          }

          const range = makeRange(t.start, t.end);
          const symbol = new vscode.DocumentSymbol(
            name,
            '',
            vscode.SymbolKind.Array,
            range,
            range,
          );

          const frame: Frame = {
            symbol,
            startOffset: t.start,
            nextIndex: 0,
          };

          if (stack.length === 0) {
            roots.push(symbol);
          } else {
            stack[stack.length - 1].symbol.children.push(symbol);
          }

          stack.push(frame);
          i++;
          continue;
        }

        if (t.kind === 'rbrace') {
          if (stack.length) {
            const frame = stack.pop()!;
            const fullRange = makeRange(frame.startOffset, t.end);
            frame.symbol.range = fullRange;
            frame.symbol.selectionRange = fullRange;
          }
          i++;
          continue;
        }

        if (t.kind === 'comma' || t.kind === 'whitespace') {
          i++;
          continue;
        }

        if (stack.length) {
          const frame = stack[stack.length - 1];
          const idx = frame.nextIndex++;
          const name = `[${idx}]`;
          const range = makeRange(t.start, t.end);

          const kind =
            t.kind === 'number' || t.kind === 'datetime'
              ? vscode.SymbolKind.Number
              : t.kind === 'string'
              ? vscode.SymbolKind.String
              : t.kind === 'guid'
              ? vscode.SymbolKind.Constant
              : vscode.SymbolKind.Variable;

          const child = new vscode.DocumentSymbol(
            name,
            '',
            kind,
            range,
            range,
          );

          frame.symbol.children.push(child);
        }

        i++;
      }

      return roots;
    }
  }

  class SkobkoInlayHintsProvider implements vscode.InlayHintsProvider {
    async provideInlayHints(
      document: vscode.TextDocument,
      _range: vscode.Range,
      _token: vscode.CancellationToken,
    ): Promise<vscode.InlayHint[]> {
      const guidMap = await getGuidMap();
      if (guidMap.size === 0) {
        return [];
      }

      const text = document.getText();
      const hints: vscode.InlayHint[] = [];

      const guidRegex =
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

      let match: RegExpExecArray | null;
      while ((match = guidRegex.exec(text)) !== null) {
        const guidText = match[0];
        const label = guidMap.get(guidText.toLowerCase());
        if (!label) {
          continue;
        }

        const endOffset = match.index + guidText.length;
        const position = document.positionAt(endOffset);
        const hint = new vscode.InlayHint(position, ` ${label}`, vscode.InlayHintKind.Type);
        hints.push(hint);
      }

      return hints;
    }
  }

  class SkobkoFoldingRangeProvider implements vscode.FoldingRangeProvider {
    provideFoldingRanges(
      document: vscode.TextDocument,
      _context: vscode.FoldingContext,
      _token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.FoldingRange[]> {
      const text = document.getText();
      const tokens = tokenize(text);

      const stack: Token[] = [];
      const ranges: vscode.FoldingRange[] = [];

      for (const t of tokens) {
        if (t.kind === 'lbrace') {
          stack.push(t);
        } else if (t.kind === 'rbrace' && stack.length > 0) {
          const startToken = stack.pop()!;
          const startPos = document.positionAt(startToken.start);
          const endPos = document.positionAt(t.end);

          if (startPos.line < endPos.line) {
            ranges.push(
              new vscode.FoldingRange(startPos.line, endPos.line, vscode.FoldingRangeKind.Region),
            );
          }
        }
      }

      return ranges;
    }
  }

  class SkobkoDefinitionProvider implements vscode.DefinitionProvider {
    async provideDefinition(
      document: vscode.TextDocument,
      position: vscode.Position,
      _token: vscode.CancellationToken,
    ): Promise<vscode.Definition | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const tokens = tokenize(text);

      const token = tokens.find(t => t.kind === 'guid' && t.start <= offset && offset < t.end);
      if (!token) {
        return undefined;
      }

      const guidText = text.slice(token.start, token.end);
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!workspaceFolder) {
        return undefined;
      }

      const patternNoExt = new vscode.RelativePattern(workspaceFolder, `**/${guidText}`);
      const patternWithExt = new vscode.RelativePattern(workspaceFolder, `**/${guidText}.*`);
      const patternInDir = new vscode.RelativePattern(workspaceFolder, `**/${guidText}/**`);
      const patternInSubDir = new vscode.RelativePattern(workspaceFolder, `**/${guidText}.*/**`);

      const [noExtMatches, withExtMatches, inDirMatches, inSubDirMatches] = await Promise.all([
        vscode.workspace.findFiles(patternNoExt, '**/node_modules/**', 20),
        vscode.workspace.findFiles(patternWithExt, '**/node_modules/**', 20),
        vscode.workspace.findFiles(patternInDir, '**/node_modules/**', 50),
        vscode.workspace.findFiles(patternInSubDir, '**/node_modules/**', 50),
      ]);

      const seen = new Set<string>();
      const uniqueMatches: vscode.Uri[] = [];
      for (const uri of [...noExtMatches, ...withExtMatches, ...inDirMatches, ...inSubDirMatches]) {
        const key = uri.toString();
        if (!seen.has(key)) {
          seen.add(key);
          uniqueMatches.push(uri);
        }
      }

      if (uniqueMatches.length === 0) {
        return undefined;
      }

      const locations: vscode.Location[] = uniqueMatches.map(uri => {
        return new vscode.Location(uri, new vscode.Position(0, 0));
      });

      return locations;
    }
  }

  const onDocumentOpen = vscode.workspace.onDidOpenTextDocument(async (document) => {
    if (document.languageId !== 'plaintext') {
      return;
    }

    const fileName = document.uri.path.split('/').pop() || '';
    const extMatch = fileName.match(/\.([^.]+)$/);
    const extension = extMatch ? extMatch[1] : null;
    
    const hasNoExtension = extension === null;
    const hasSingleDigitExtension = extension !== null && /^\d$/.test(extension);
    
    if (!hasNoExtension && !hasSingleDigitExtension) {
      return;
    }

    const text = document.getText();
    if (!text.trimStart().startsWith('{')) {
      return;
    }

    try {
      await vscode.languages.setTextDocumentLanguage(document, 'skobko');
    } catch {
      // ignore errors
    }
  });

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, new SkobkoSymbolProvider()),
    vscode.languages.registerFoldingRangeProvider(selector, new SkobkoFoldingRangeProvider()),
    vscode.languages.registerDefinitionProvider(selector, new SkobkoDefinitionProvider()),
    vscode.languages.registerInlayHintsProvider(selector, new SkobkoInlayHintsProvider()),
    onDocumentOpen,
  );
}

export function deactivate() {
  // nothing
}

function parseGuidsMarkdown(text: string): Map<string, string> {
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

    const name = parts[1];
    const guid = parts[2];

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

function tokenize(text: string): Token[] {
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
      tokens.push({ kind: 'number', start, end: j });
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

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isDigitOrDateChar(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    ch === '-' ||
    ch === ':' ||
    ch === 'T' ||
    ch === 'Z' ||
    ch === '.' ||
    ch === '+' ||
    ch === '/'
  );
}

function isBase64Char(ch: string): boolean {
  return (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '+' ||
    ch === '/' ||
    ch === '='
  );
}


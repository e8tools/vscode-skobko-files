/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as vscode from 'vscode';
import {
  Token,
  tokenize,
  parseGuidsMarkdown,
  parseOpcodesMarkdown,
  extractSkobkoObjectRange,
  countDirectChildElementsForOpeningBraces,
  formatWithAlignment,
  formatNormally,
} from './parser';

interface ParsedPrimitiveNode {
  type: 'primitive';
  token: Token;
}

interface ParsedObjectNode {
  type: 'object';
  openToken: Token;
  children: ParsedValueNode[];
}

type ParsedValueNode = ParsedPrimitiveNode | ParsedObjectNode;

function parseSkobkoValueNodes(tokens: Token[]): ParsedValueNode[] | undefined {
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

  const parseValue = (): ParsedValueNode | undefined => {
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
      const children: ParsedValueNode[] = [];

      while (i < tokens.length) {
        skipIgnorable();
        if (i >= tokens.length) {
          return undefined;
        }

        if (tokens[i].kind === 'rbrace') {
          i++;
          return { type: 'object', openToken: token, children };
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
    return { type: 'primitive', token };
  };

  const roots: ParsedValueNode[] = [];
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

function unquoteStringToken(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function isNamedImageFile(document: vscode.TextDocument): boolean {
  const fileName = document.uri.path.split('/').pop() ?? '';
  const extensionMatch = fileName.match(/^(.*)\.([^.]+)$/);
  const baseName = extensionMatch ? extensionMatch[1] : fileName;
  return baseName.toLowerCase() === 'image';
}

export function activate(context: vscode.ExtensionContext) {
  const selector: vscode.DocumentSelector = { language: 'skobko', scheme: 'file' };

  let guidMapPromise: Promise<Map<string, string>> | undefined;
  let opcodeMapPromise: Promise<Map<number, string>> | undefined;

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

  const getOpcodeMap = async (): Promise<Map<number, string>> => {
    if (opcodeMapPromise) {
      return opcodeMapPromise;
    }

    opcodeMapPromise = (async () => {
      const opcodesUri = vscode.Uri.joinPath(context.extensionUri, 'docs', 'opcodes.md');

      try {
        const doc = await vscode.workspace.openTextDocument(opcodesUri);
        return parseOpcodesMarkdown(doc.getText());
      } catch {
        return new Map<number, string>();
      }
    })();

    return opcodeMapPromise;
  };

  class SkobkoSymbolProvider implements vscode.DocumentSymbolProvider {
    async provideDocumentSymbols(
      document: vscode.TextDocument,
      _token: vscode.CancellationToken,
    ): Promise<vscode.DocumentSymbol[]> {
      const text = document.getText();
      const tokens = tokenize(text);
      const guidMap = await getGuidMap();

      interface Frame {
        symbol: vscode.DocumentSymbol;
        startOffset: number;
        nextIndex: number;
        isNested: boolean;
        hasAppliedGuidLabel: boolean;
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
          const isNested = stack.length !== 0;
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
            isNested,
            hasAppliedGuidLabel: false,
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

          // Если это первый элемент вложенного объекта и он является известным GUID,
          // то показываем подпись GUID прямо в пункте OUTLINE.
          if (
            frame.isNested &&
            !frame.hasAppliedGuidLabel &&
            frame.symbol.children.length === 0 &&
            t.kind === 'guid' &&
            guidMap.size !== 0
          ) {
            const guidText = text.slice(t.start, t.end);
            const label = guidMap.get(guidText.toLowerCase());
            if (label) {
              frame.hasAppliedGuidLabel = true;
              frame.symbol.name = `${frame.symbol.name} ${label}`;
            }
          }

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
      const text = document.getText();
      const tokens = tokenize(text);
      const hints: vscode.InlayHint[] = [];

      const config = vscode.workspace.getConfiguration('skobkoFiles');
      const showBraceElementCounts = config.get<boolean>('inlayHints.showBraceElementCounts', false);

      if (showBraceElementCounts) {
        const counts = countDirectChildElementsForOpeningBraces(tokens);

        for (const t of tokens) {
          if (t.kind !== 'lbrace') {
            continue;
          }

          const count = counts.get(t.start) ?? 0;
          if (count < 2) {
            continue;
          }
          const position = document.positionAt(t.end);
          hints.push(new vscode.InlayHint(position, `(${count}) `, vscode.InlayHintKind.Parameter));
        }
      }

      if (isNamedImageFile(document)) {
        const opcodeMap = await getOpcodeMap();
        if (opcodeMap.size !== 0) {
          const roots = parseSkobkoValueNodes(tokens);
          if (roots) {
            const walk = (node: ParsedValueNode) => {
              if (node.type !== 'object') {
                return;
              }

              const first = node.children[0];
              const firstTokenText =
                first && first.type === 'primitive'
                  ? text.slice(first.token.start, first.token.end)
                  : '';
              const blockType = unquoteStringToken(firstTokenText);
              if (blockType === 'Cmd') {
                for (let i = 3; i < node.children.length; i++) {
                  const opcodeObject = node.children[i];
                  if (opcodeObject.type !== 'object' || opcodeObject.children.length < 2) {
                    continue;
                  }

                  const opcodeValue = opcodeObject.children[0];
                  const argumentValue = opcodeObject.children[1];
                  if (opcodeValue.type !== 'primitive' || argumentValue.type !== 'primitive') {
                    continue;
                  }

                  const opcodeText = text.slice(opcodeValue.token.start, opcodeValue.token.end);
                  const opcode = Number.parseInt(opcodeText, 10);
                  if (Number.isNaN(opcode)) {
                    continue;
                  }

                  const opcodeAsm = opcodeMap.get(opcode);
                  if (!opcodeAsm) {
                    continue;
                  }

                  const argument = text.slice(argumentValue.token.start, argumentValue.token.end);
                  const line = document.positionAt(opcodeObject.openToken.start).line;
                  const position = new vscode.Position(line, 16);
                  hints.push(
                    new vscode.InlayHint(
                      position,
                      `${opcodeAsm} ${argument}`,
                      vscode.InlayHintKind.Parameter,
                    ),
                  );
                }
              }

              for (const child of node.children) {
                walk(child);
              }
            };

            for (const root of roots) {
              walk(root);
            }
          }
        }
      }

      const guidMap = await getGuidMap();
      if (guidMap.size === 0) {
        return hints;
      }

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

  const extractCurrentObjectToNewFile = vscode.commands.registerCommand(
    'skobkoFiles.extractCurrentObjectToNewFile',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const text = document.getText();
      const cursorOffset = document.offsetAt(editor.selection.active);

      const range = extractSkobkoObjectRange(text, cursorOffset);
      if (!range) {
        vscode.window.showErrorMessage('Не удалось определить текущий скобочный объект под курсором.');
        return;
      }

      const content = text.slice(range.start, range.end);
      const newDocument = await vscode.workspace.openTextDocument({
        content,
        language: 'skobko',
      });

      await vscode.window.showTextDocument(newDocument, { preview: false });
    },
  );

  const formatWithAlignmentCommand = vscode.commands.registerCommand(
    'skobkoFiles.formatWithAlignment',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const formatted = formatWithAlignment(document.getText());
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );

      await editor.edit(builder => {
        builder.replace(fullRange, formatted);
      });
    },
  );

  const formatNormallyCommand = vscode.commands.registerCommand(
    'skobkoFiles.formatNormally',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const document = editor.document;
      const formatted = formatNormally(document.getText());
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );

      await editor.edit(builder => {
        builder.replace(fullRange, formatted);
      });
    },
  );

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, new SkobkoSymbolProvider()),
    vscode.languages.registerFoldingRangeProvider(selector, new SkobkoFoldingRangeProvider()),
    vscode.languages.registerDefinitionProvider(selector, new SkobkoDefinitionProvider()),
    vscode.languages.registerInlayHintsProvider(selector, new SkobkoInlayHintsProvider()),
    extractCurrentObjectToNewFile,
    formatWithAlignmentCommand,
    formatNormallyCommand,
    onDocumentOpen,
  );
}

export function deactivate() {
  // nothing
}


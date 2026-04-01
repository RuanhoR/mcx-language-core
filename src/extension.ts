import * as vscode from 'vscode';
import { Compiler, AST, PUBTYPE, TSC } from '@mbler/mcx-core';

let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('mcx');

  // 注册文档变化监听
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.languageId === 'mcx') {
        validateDocument(event.document);
      }
    })
  );

  // 注册文档打开监听
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.languageId === 'mcx') {
        validateDocument(document);
      }
    })
  );

  // 注册编译命令
  context.subscriptions.push(
    vscode.commands.registerCommand('mcx.compile', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'mcx') {
        compileDocument(editor.document);
      }
    })
  );

  // 注册悬停提示（MCX 标签 + TypeScript）
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('mcx', new MCXHoverProvider())
  );

  // 注册定义跳转（MCX 标签 + TypeScript）
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('mcx', new MCXDefinitionProvider())
  );

  // TypeScript 语言特性提供器
  const tsProvider = new MCXTypeScriptProvider();

  // 补全
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('mcx', tsProvider, '.', '"', "'", '/', '@')
  );

  // 签名帮助
  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider('mcx', tsProvider, '(', ',')
  );

  // 引用
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider('mcx', tsProvider)
  );

  // 文档符号
  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider('mcx', tsProvider)
  );

  // 重命名
  context.subscriptions.push(
    vscode.languages.registerRenameProvider('mcx', tsProvider)
  );

  // 类型定义跳转
  context.subscriptions.push(
    vscode.languages.registerTypeDefinitionProvider('mcx', tsProvider)
  );

  // 初始化时验证已打开的文档
  vscode.workspace.textDocuments.forEach(document => {
    if (document.languageId === 'mcx') {
      validateDocument(document);
    }
  });
}

export function deactivate() {
  if (diagnosticCollection) {
    diagnosticCollection.dispose();
  }
}

function validateDocument(document: vscode.TextDocument): void {
  const text = document.getText();

  try {
    Compiler.compileMCXFn(text);
    diagnosticCollection.set(document.uri, []);
  } catch (error: unknown) {
    const diagnostics: vscode.Diagnostic[] = [];
    if (error instanceof Error) {
      const compileError = error as Error & { loc?: { line: number; column: number } };
      const line = compileError.loc?.line ?? 1;
      const column = compileError.loc?.column ?? 0;

      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
      const range = new vscode.Range(position, position);

      diagnostics.push(new vscode.Diagnostic(
        range,
        error.message,
        vscode.DiagnosticSeverity.Error
      ));
    }
    diagnosticCollection.set(document.uri, diagnostics);
  }
}

async function compileDocument(document: vscode.TextDocument): Promise<void> {
  try {
    Compiler.compileMCXFn(document.getText());
    vscode.window.showInformationMessage('MCX: Compilation successful!');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`MCX: Compilation failed - ${message}`);
  }
}

/**
 * 创建虚拟 TypeScript 文档快照
 */
function createScriptSnapshot(document: vscode.TextDocument) {
  const text = document.getText();

  try {
    // 使用 TSC 模块创建虚拟代码
    const virtualCode = TSC.createMCXVirtualCode({
      getText: (start: number, end: number) => text.slice(start, end),
      getLength: () => text.length,
      getChangeRange: () => undefined,
    });

    // 查找嵌入的 script 代码
    const scriptCode = virtualCode.embeddedCodes?.find(
      code => code.languageId === 'typescript' || code.languageId === 'javascript'
    );

    if (!scriptCode) return null;

    return {
      virtualCode,
      scriptCode,
      scriptContent: scriptCode.snapshot.getText(0, scriptCode.snapshot.getLength()),
      scriptLength: scriptCode.snapshot.getLength(),
      isTypeScript: scriptCode.languageId === 'typescript',
      mappings: scriptCode.mappings,
    };
  } catch {
    return null;
  }
}

/**
 * 将文档位置转换为 script 内部位置
 */
function documentToScriptPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  snapshot: NonNullable<ReturnType<typeof createScriptSnapshot>>
): vscode.Position | null {
  const offset = document.offsetAt(position);
  const mapping = snapshot.mappings[0];
  if (!mapping) return null;

  // 检查是否在映射范围内
  const scriptStart = mapping.sourceOffsets[0];
  const scriptLength = mapping.lengths[0];

  if (offset < scriptStart || offset >= scriptStart + scriptLength) {
    return null;
  }

  // 计算在 script 内的偏移
  const scriptOffset = offset - scriptStart;
  const scriptContent = snapshot.scriptContent;

  // 将偏移转换为行列
  let line = 0;
  let col = 0;
  let currentOffset = 0;

  for (const char of scriptContent) {
    if (currentOffset === scriptOffset) break;
    if (char === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
    currentOffset++;
  }

  return new vscode.Position(line, col);
}

/**
 * 将 script 内部位置转换为文档位置
 */
function scriptToDocumentPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  snapshot: NonNullable<ReturnType<typeof createScriptSnapshot>>
): vscode.Position {
  const mapping = snapshot.mappings[0];
  if (!mapping) return position;

  const scriptStart = mapping.sourceOffsets[0];
  const scriptContent = snapshot.scriptContent;

  // 计算偏移
  let offset = 0;
  for (let i = 0; i < position.line; i++) {
    const newlineIndex = scriptContent.indexOf('\n', offset);
    if (newlineIndex === -1) break;
    offset = newlineIndex + 1;
  }
  offset += position.character;

  // 转换回文档位置
  const documentOffset = scriptStart + offset;
  return document.positionAt(documentOffset);
}

class MCXHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    // 首先尝试 TypeScript hover
    const snapshot = createScriptSnapshot(document);
    if (snapshot) {
      const scriptPos = documentToScriptPosition(document, position, snapshot);
      if (scriptPos) {
        const scriptDoc = await vscode.workspace.openTextDocument({
          content: snapshot.scriptContent,
          language: snapshot.isTypeScript ? 'typescript' : 'javascript',
        });

        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          scriptDoc.uri,
          scriptPos
        );

        if (hovers && hovers.length > 0) {
          return hovers[0];
        }
      }
    }

    // MCX 标签 hover
    const text = document.getText();
    try {
      const ast = new AST.tag(text);
      const node = findNodeAtOffset(ast.data, document.offsetAt(position));
      if (node) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`**${node.name}**\n\n`);
        if (node.arr && Object.keys(node.arr).length > 0) {
          markdown.appendMarkdown('**Attributes:**\n');
          for (const [key, value] of Object.entries(node.arr)) {
            markdown.appendMarkdown(`- \`${key}\`: ${value}\n`);
          }
        }
        return new vscode.Hover(markdown);
      }
    } catch { }

    return undefined;
  }
}

class MCXDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const snapshot = createScriptSnapshot(document);
    if (snapshot) {
      const scriptPos = documentToScriptPosition(document, position, snapshot);
      if (scriptPos) {
        const scriptDoc = await vscode.workspace.openTextDocument({
          content: snapshot.scriptContent,
          language: snapshot.isTypeScript ? 'typescript' : 'javascript',
        });

        const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeDefinitionProvider',
          scriptDoc.uri,
          scriptPos
        );

        if (definitions && definitions.length > 0) {
          return definitions.map(def => {
            if (def.uri.toString() === scriptDoc.uri.toString()) {
              const newStart = scriptToDocumentPosition(document, def.range.start, snapshot);
              const newEnd = scriptToDocumentPosition(document, def.range.end, snapshot);
              return new vscode.Location(document.uri, new vscode.Range(newStart, newEnd));
            }
            return def;
          });
        }
      }
    }

    // MCX 标签定义
    const text = document.getText();
    try {
      const ast = new AST.tag(text);
      const node = findNodeAtOffset(ast.data, document.offsetAt(position));
      if (node && node.loc) {
        const startPos = new vscode.Position(
          Math.max(0, node.loc.start.line - 1),
          Math.max(0, node.loc.start.column)
        );
        const endPos = new vscode.Position(
          Math.max(0, node.loc.end.line - 1),
          Math.max(0, node.loc.end.column)
        );
        return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
      }
    } catch { }

    return undefined;
  }
}

/**
 * TypeScript 语言特性提供器
 */
class MCXTypeScriptProvider implements
  vscode.CompletionItemProvider,
  vscode.SignatureHelpProvider,
  vscode.ReferenceProvider,
  vscode.DocumentSymbolProvider,
  vscode.RenameProvider,
  vscode.TypeDefinitionProvider {

  private async withScriptDocument(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<{
    snapshot: NonNullable<ReturnType<typeof createScriptSnapshot>>;
    scriptDoc: vscode.TextDocument;
    scriptPos: vscode.Position;
  } | null> {
    const snapshot = createScriptSnapshot(document);
    if (!snapshot) return null;

    const scriptPos = documentToScriptPosition(document, position, snapshot);
    if (!scriptPos) return null;

    const scriptDoc = await vscode.workspace.openTextDocument({
      content: snapshot.scriptContent,
      language: snapshot.isTypeScript ? 'typescript' : 'javascript',
    });

    return { snapshot, scriptDoc, scriptPos };
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    const result = await this.withScriptDocument(document, position);
    if (!result) return undefined;

    const { snapshot, scriptDoc, scriptPos } = result;

    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      scriptDoc.uri,
      scriptPos,
      context.triggerCharacter
    );

    if (!completions) return undefined;

    // 转换位置
    const items = completions.items.map(item => {
      if (item.range) {
        const range = item.range instanceof vscode.Range
          ? item.range
          : (item.range as any).inserting || (item.range as any).replacing;

        if (range) {
          const newStart = scriptToDocumentPosition(document, range.start, snapshot);
          const newEnd = scriptToDocumentPosition(document, range.end, snapshot);
          item.range = new vscode.Range(newStart, newEnd);
        }
      }
      return item;
    });

    return new vscode.CompletionList(items);
  }

  async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | undefined> {
    const result = await this.withScriptDocument(document, position);
    if (!result) return undefined;

    return vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      result.scriptDoc.uri,
      result.scriptPos
    );
  }

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[] | undefined> {
    const result = await this.withScriptDocument(document, position);
    if (!result) return undefined;

    const { snapshot, scriptDoc, scriptPos } = result;

    const refs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeReferenceProvider',
      scriptDoc.uri,
      scriptPos
    );

    if (!refs) return undefined;

    return refs.map(ref => {
      if (ref.uri.toString() === scriptDoc.uri.toString()) {
        const newStart = scriptToDocumentPosition(document, ref.range.start, snapshot);
        const newEnd = scriptToDocumentPosition(document, ref.range.end, snapshot);
        return new vscode.Location(document.uri, new vscode.Range(newStart, newEnd));
      }
      return ref;
    });
  }

  async provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    const snapshot = createScriptSnapshot(document);
    if (!snapshot) return undefined;

    const scriptDoc = await vscode.workspace.openTextDocument({
      content: snapshot.scriptContent,
      language: snapshot.isTypeScript ? 'typescript' : 'javascript',
    });

    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      scriptDoc.uri
    );

    if (!symbols) return undefined;

    const convertSymbol = (symbol: vscode.DocumentSymbol): vscode.DocumentSymbol => {
      const newStart = scriptToDocumentPosition(document, symbol.range.start, snapshot);
      const newEnd = scriptToDocumentPosition(document, symbol.range.end, snapshot);
      const newSelStart = scriptToDocumentPosition(document, symbol.selectionRange.start, snapshot);
      const newSelEnd = scriptToDocumentPosition(document, symbol.selectionRange.end, snapshot);

      const converted = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail,
        symbol.kind,
        new vscode.Range(newStart, newEnd),
        new vscode.Range(newSelStart, newSelEnd)
      );

      if (symbol.children) {
        converted.children = symbol.children.map(convertSymbol);
      }

      return converted;
    };

    return symbols.map(convertSymbol);
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const result = await this.withScriptDocument(document, position);
    if (!result) return undefined;

    return vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeRenameProvider',
      result.scriptDoc.uri,
      result.scriptPos,
      newName
    );
  }

  async provideTypeDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition | undefined> {
    const result = await this.withScriptDocument(document, position);
    if (!result) return undefined;

    const { snapshot, scriptDoc, scriptPos } = result;

    const defs = await vscode.commands.executeCommand<vscode.Location[]>(
      'vscode.executeTypeDefinitionProvider',
      scriptDoc.uri,
      scriptPos
    );

    if (!defs) return undefined;

    return defs.map(def => {
      if (def.uri.toString() === scriptDoc.uri.toString()) {
        const newStart = scriptToDocumentPosition(document, def.range.start, snapshot);
        const newEnd = scriptToDocumentPosition(document, def.range.end, snapshot);
        return new vscode.Location(document.uri, new vscode.Range(newStart, newEnd));
      }
      return def;
    });
  }
}

function findNodeAtOffset(
  nodes: PUBTYPE.ParsedTagNode[],
  offset: number
): PUBTYPE.ParsedTagNode | undefined {
  for (const node of nodes) {
    if (node.content) {
      for (const child of node.content) {
        if (child.type === 'TagNode') {
          const found = findNodeAtOffset([child as PUBTYPE.ParsedTagNode], offset);
          if (found) return found;
        }
      }
    }
    if (node.loc) return node;
  }
  return undefined;
}


import * as vscode from 'vscode';
import { compileMCXFn, AST, PUBTYPE } from '@mbler/mcx-core';

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

  // 注册悬停提示
  context.subscriptions.push(
    vscode.languages.registerHoverProvider('mcx', new MCXHoverProvider())
  );

  // 注册定义跳转
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider('mcx', new MCXDefinitionProvider())
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
  const diagnostics: vscode.Diagnostic[] = [];
  const text = document.getText();

  try {
    const result = compileMCXFn(text);
    // 解析成功，清除错误
    diagnosticCollection.set(document.uri, []);
  } catch (error: unknown) {
    if (error instanceof Error) {
      const compileError = error as Error & { loc?: { line: number; column: number } };
      const line = compileError.loc?.line ?? 1;
      const column = compileError.loc?.column ?? 0;

      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
      const range = new vscode.Range(position, position);

      const diagnostic = new vscode.Diagnostic(
        range,
        error.message,
        vscode.DiagnosticSeverity.Error
      );
      diagnostics.push(diagnostic);
    }
    diagnosticCollection.set(document.uri, diagnostics);
  }
}

async function compileDocument(document: vscode.TextDocument): Promise<void> {
  try {
    const result = compileMCXFn(document.getText());
    vscode.window.showInformationMessage('MCX: Compilation successful!');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`MCX: Compilation failed - ${message}`);
  }
}

class MCXHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    try {
      const ast = new AST.McxAst(text);
      const nodes = ast.data;

      const node = findNodeAtOffset(nodes, offset);
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
    } catch {
      // Ignore parse errors for hover
    }

    return undefined;
  }
}

class MCXDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    try {
      const ast = new AST.McxAst(text);
      const nodes = ast.data;

      const node = findNodeAtOffset(nodes, offset);
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
    } catch {
      // Ignore parse errors for definition
    }

    return undefined;
  }
}

function findNodeAtOffset(
  nodes: PUBTYPE.ParsedTagNode[],
  offset: number
): PUBTYPE.ParsedTagNode | undefined {
  for (const node of nodes) {
    const startOffset = node.start?.start?.column ?? 0;
    const endOffset = node.end?.end?.column ?? Infinity;

    // 简单检查是否在节点范围内
    const nodeStartLine = node.loc?.start?.line ?? 0;
    const nodeEndLine = node.loc?.end?.line ?? Infinity;

    if (node.content) {
      for (const child of node.content) {
        if (child.type === 'TagNode') {
          const found = findNodeAtOffset([child as PUBTYPE.ParsedTagNode], offset);
          if (found) return found;
        }
      }
    }

    // 返回当前节点作为备选
    if (node.loc) {
      return node;
    }
  }
  return undefined;
}

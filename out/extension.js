"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const mcx_core_1 = require("@mbler/mcx-core");
let diagnosticCollection;
function activate(context) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('mcx');
    // 注册文档变化监听
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'mcx') {
            validateDocument(event.document);
        }
    }));
    // 注册文档打开监听
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId === 'mcx') {
            validateDocument(document);
        }
    }));
    // 注册编译命令
    context.subscriptions.push(vscode.commands.registerCommand('mcx.compile', () => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'mcx') {
            compileDocument(editor.document);
        }
    }));
    // 注册悬停提示（MCX 标签 + TypeScript）
    context.subscriptions.push(vscode.languages.registerHoverProvider('mcx', new MCXHoverProvider()));
    // 注册定义跳转（MCX 标签 + TypeScript）
    context.subscriptions.push(vscode.languages.registerDefinitionProvider('mcx', new MCXDefinitionProvider()));
    // TypeScript 语言特性提供器
    const tsProvider = new MCXTypeScriptProvider();
    // 补全
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('mcx', tsProvider, '.', '"', "'", '/', '@'));
    // 签名帮助
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('mcx', tsProvider, '(', ','));
    // 引用
    context.subscriptions.push(vscode.languages.registerReferenceProvider('mcx', tsProvider));
    // 文档符号
    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider('mcx', tsProvider));
    // 重命名
    context.subscriptions.push(vscode.languages.registerRenameProvider('mcx', tsProvider));
    // 类型定义跳转
    context.subscriptions.push(vscode.languages.registerTypeDefinitionProvider('mcx', tsProvider));
    // 初始化时验证已打开的文档
    vscode.workspace.textDocuments.forEach(document => {
        if (document.languageId === 'mcx') {
            validateDocument(document);
        }
    });
}
function deactivate() {
    if (diagnosticCollection) {
        diagnosticCollection.dispose();
    }
}
function validateDocument(document) {
    const text = document.getText();
    try {
        mcx_core_1.Compiler.compileMCXFn(text);
        diagnosticCollection.set(document.uri, []);
    }
    catch (error) {
        const diagnostics = [];
        if (error instanceof Error) {
            const compileError = error;
            const line = compileError.loc?.line ?? 1;
            const column = compileError.loc?.column ?? 0;
            const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column));
            const range = new vscode.Range(position, position);
            diagnostics.push(new vscode.Diagnostic(range, error.message, vscode.DiagnosticSeverity.Error));
        }
        diagnosticCollection.set(document.uri, diagnostics);
    }
}
async function compileDocument(document) {
    try {
        mcx_core_1.Compiler.compileMCXFn(document.getText());
        vscode.window.showInformationMessage('MCX: Compilation successful!');
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`MCX: Compilation failed - ${message}`);
    }
}
/**
 * 创建虚拟 TypeScript 文档快照
 */
function createScriptSnapshot(document) {
    const text = document.getText();
    try {
        // 使用 TSC 模块创建虚拟代码
        const virtualCode = mcx_core_1.TSC.createMCXVirtualCode({
            getText: (start, end) => text.slice(start, end),
            getLength: () => text.length,
            getChangeRange: () => undefined,
        });
        // 查找嵌入的 script 代码
        const scriptCode = virtualCode.embeddedCodes?.find(code => code.languageId === 'typescript' || code.languageId === 'javascript');
        if (!scriptCode)
            return null;
        return {
            virtualCode,
            scriptCode,
            scriptContent: scriptCode.snapshot.getText(0, scriptCode.snapshot.getLength()),
            scriptLength: scriptCode.snapshot.getLength(),
            isTypeScript: scriptCode.languageId === 'typescript',
            mappings: scriptCode.mappings,
        };
    }
    catch {
        return null;
    }
}
/**
 * 将文档位置转换为 script 内部位置
 */
function documentToScriptPosition(document, position, snapshot) {
    const offset = document.offsetAt(position);
    const mapping = snapshot.mappings[0];
    if (!mapping)
        return null;
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
        if (currentOffset === scriptOffset)
            break;
        if (char === '\n') {
            line++;
            col = 0;
        }
        else {
            col++;
        }
        currentOffset++;
    }
    return new vscode.Position(line, col);
}
/**
 * 将 script 内部位置转换为文档位置
 */
function scriptToDocumentPosition(document, position, snapshot) {
    const mapping = snapshot.mappings[0];
    if (!mapping)
        return position;
    const scriptStart = mapping.sourceOffsets[0];
    const scriptContent = snapshot.scriptContent;
    // 计算偏移
    let offset = 0;
    for (let i = 0; i < position.line; i++) {
        const newlineIndex = scriptContent.indexOf('\n', offset);
        if (newlineIndex === -1)
            break;
        offset = newlineIndex + 1;
    }
    offset += position.character;
    // 转换回文档位置
    const documentOffset = scriptStart + offset;
    return document.positionAt(documentOffset);
}
class MCXHoverProvider {
    async provideHover(document, position, token) {
        // 首先尝试 TypeScript hover
        const snapshot = createScriptSnapshot(document);
        if (snapshot) {
            const scriptPos = documentToScriptPosition(document, position, snapshot);
            if (scriptPos) {
                const scriptDoc = await vscode.workspace.openTextDocument({
                    content: snapshot.scriptContent,
                    language: snapshot.isTypeScript ? 'typescript' : 'javascript',
                });
                const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', scriptDoc.uri, scriptPos);
                if (hovers && hovers.length > 0) {
                    return hovers[0];
                }
            }
        }
        // MCX 标签 hover
        const text = document.getText();
        try {
            const ast = new mcx_core_1.AST.tag(text);
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
        }
        catch { }
        return undefined;
    }
}
class MCXDefinitionProvider {
    async provideDefinition(document, position, token) {
        const snapshot = createScriptSnapshot(document);
        if (snapshot) {
            const scriptPos = documentToScriptPosition(document, position, snapshot);
            if (scriptPos) {
                const scriptDoc = await vscode.workspace.openTextDocument({
                    content: snapshot.scriptContent,
                    language: snapshot.isTypeScript ? 'typescript' : 'javascript',
                });
                const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', scriptDoc.uri, scriptPos);
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
            const ast = new mcx_core_1.AST.tag(text);
            const node = findNodeAtOffset(ast.data, document.offsetAt(position));
            if (node && node.loc) {
                const startPos = new vscode.Position(Math.max(0, node.loc.start.line - 1), Math.max(0, node.loc.start.column));
                const endPos = new vscode.Position(Math.max(0, node.loc.end.line - 1), Math.max(0, node.loc.end.column));
                return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
            }
        }
        catch { }
        return undefined;
    }
}
/**
 * TypeScript 语言特性提供器
 */
class MCXTypeScriptProvider {
    async withScriptDocument(document, position) {
        const snapshot = createScriptSnapshot(document);
        if (!snapshot)
            return null;
        const scriptPos = documentToScriptPosition(document, position, snapshot);
        if (!scriptPos)
            return null;
        const scriptDoc = await vscode.workspace.openTextDocument({
            content: snapshot.scriptContent,
            language: snapshot.isTypeScript ? 'typescript' : 'javascript',
        });
        return { snapshot, scriptDoc, scriptPos };
    }
    async provideCompletionItems(document, position, token, context) {
        const result = await this.withScriptDocument(document, position);
        if (!result)
            return undefined;
        const { snapshot, scriptDoc, scriptPos } = result;
        const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', scriptDoc.uri, scriptPos, context.triggerCharacter);
        if (!completions)
            return undefined;
        // 转换位置
        const items = completions.items.map(item => {
            if (item.range) {
                const range = item.range instanceof vscode.Range
                    ? item.range
                    : item.range.inserting || item.range.replacing;
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
    async provideSignatureHelp(document, position, token, context) {
        const result = await this.withScriptDocument(document, position);
        if (!result)
            return undefined;
        return vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', result.scriptDoc.uri, result.scriptPos);
    }
    async provideReferences(document, position, context, token) {
        const result = await this.withScriptDocument(document, position);
        if (!result)
            return undefined;
        const { snapshot, scriptDoc, scriptPos } = result;
        const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', scriptDoc.uri, scriptPos);
        if (!refs)
            return undefined;
        return refs.map(ref => {
            if (ref.uri.toString() === scriptDoc.uri.toString()) {
                const newStart = scriptToDocumentPosition(document, ref.range.start, snapshot);
                const newEnd = scriptToDocumentPosition(document, ref.range.end, snapshot);
                return new vscode.Location(document.uri, new vscode.Range(newStart, newEnd));
            }
            return ref;
        });
    }
    async provideDocumentSymbols(document, token) {
        const snapshot = createScriptSnapshot(document);
        if (!snapshot)
            return undefined;
        const scriptDoc = await vscode.workspace.openTextDocument({
            content: snapshot.scriptContent,
            language: snapshot.isTypeScript ? 'typescript' : 'javascript',
        });
        const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', scriptDoc.uri);
        if (!symbols)
            return undefined;
        const convertSymbol = (symbol) => {
            const newStart = scriptToDocumentPosition(document, symbol.range.start, snapshot);
            const newEnd = scriptToDocumentPosition(document, symbol.range.end, snapshot);
            const newSelStart = scriptToDocumentPosition(document, symbol.selectionRange.start, snapshot);
            const newSelEnd = scriptToDocumentPosition(document, symbol.selectionRange.end, snapshot);
            const converted = new vscode.DocumentSymbol(symbol.name, symbol.detail, symbol.kind, new vscode.Range(newStart, newEnd), new vscode.Range(newSelStart, newSelEnd));
            if (symbol.children) {
                converted.children = symbol.children.map(convertSymbol);
            }
            return converted;
        };
        return symbols.map(convertSymbol);
    }
    async provideRenameEdits(document, position, newName, token) {
        const result = await this.withScriptDocument(document, position);
        if (!result)
            return undefined;
        return vscode.commands.executeCommand('vscode.executeRenameProvider', result.scriptDoc.uri, result.scriptPos, newName);
    }
    async provideTypeDefinition(document, position, token) {
        const result = await this.withScriptDocument(document, position);
        if (!result)
            return undefined;
        const { snapshot, scriptDoc, scriptPos } = result;
        const defs = await vscode.commands.executeCommand('vscode.executeTypeDefinitionProvider', scriptDoc.uri, scriptPos);
        if (!defs)
            return undefined;
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
function findNodeAtOffset(nodes, offset) {
    for (const node of nodes) {
        if (node.content) {
            for (const child of node.content) {
                if (child.type === 'TagNode') {
                    const found = findNodeAtOffset([child], offset);
                    if (found)
                        return found;
                }
            }
        }
        if (node.loc)
            return node;
    }
    return undefined;
}
//# sourceMappingURL=extension.js.map
import { Project, Node, SyntaxKind, ScriptTarget, ModuleKind, ModuleResolutionKind } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob';

export interface ReferenceResult {
    symbol: string;          // 検索対象のシンボル名
    type: 'function' | 'interface' | 'class' | 'variable';
    definition: {           // シンボルの定義情報
        filePath: string;    // 定義ファイルパス
        line: number;        // 行番号
        column: number;      // 列番号
        context: string;     // 定義されているコンテキスト
    };
    references: {           // 参照情報の配列
        filePath: string;    // 参照元ファイルパス
        line: number;        // 行番号
        column: number;      // 列番号
        context: string;     // 参照されているコンテキスト（関数名など）
    }[];
    isReferenced: boolean;   // 参照が存在するかどうか
}

export class StaticCodeChecker {
    private project: Project;

    constructor(options: {
        basePath: string;
        tsConfigPath?: string;
        includePatterns?: string[];
        excludePatterns?: string[];
    }) {
        const { basePath, tsConfigPath, includePatterns = ["**/*.ts", "**/*.tsx"], excludePatterns = ["**/node_modules/**"] } = options;

        // Normalize base path
        const normalizedBasePath = path.resolve(basePath);

        // Initialize project with compiler options
        this.project = new Project({
            compilerOptions: {
                target: ScriptTarget.ESNext,
                module: ModuleKind.ESNext,
                moduleResolution: ModuleResolutionKind.NodeJs,
                esModuleInterop: true,
                skipLibCheck: true,
            },
            skipAddingFilesFromTsConfig: true, // We'll manually add files
        });

        // If tsconfig.json is specified and exists, use its compiler options
        if (tsConfigPath && fs.existsSync(tsConfigPath)) {
            this.project.addSourceFilesFromTsConfig(tsConfigPath);
        }

        // Add files matching the patterns
        const files = glob.sync(includePatterns.length > 1 ? `{${includePatterns.join(',')}}` : includePatterns[0], {
            cwd: normalizedBasePath,
            ignore: excludePatterns,
            absolute: true,
        });

        // Add each file to the project
        files.forEach(file => {
            if (!this.project.getSourceFile(file)) {
                this.project.addSourceFileAtPath(file);
            }
        });
    }

    public analyzeSymbol(symbolName: string, options: { includeInternalReferences?: boolean } = {}): ReferenceResult {
        const references: ReferenceResult['references'] = [];
        const refsSet = new Set<string>();

        // まず、シンボルの定義を見つける
        let definitionNode: Node | undefined;
        let symbolType: ReferenceResult['type'] = 'function';

        // 定義を探す
        for (const sourceFile of this.project.getSourceFiles()) {
            // .d.tsファイルはスキップ
            if (sourceFile.getFilePath().endsWith('.d.ts')) continue;

            const nodes = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
                .filter(node => node.getText() === symbolName);

            for (const node of nodes) {
                // クラス、インターフェース、関数の定義を優先
                const parent = node.getParent();
                if (parent && (
                    parent.isKind(SyntaxKind.ClassDeclaration) || 
                    parent.isKind(SyntaxKind.InterfaceDeclaration) || 
                    parent.isKind(SyntaxKind.FunctionDeclaration) ||
                    parent.isKind(SyntaxKind.MethodDeclaration) ||
                    parent.isKind(SyntaxKind.PropertyDeclaration)
                )) {
                    definitionNode = node;
                    // シンボルの種類を判定
                    if (parent.isKind(SyntaxKind.ClassDeclaration)) symbolType = 'class';
                    else if (parent.isKind(SyntaxKind.InterfaceDeclaration)) symbolType = 'interface';
                    else if (parent.isKind(SyntaxKind.FunctionDeclaration)) symbolType = 'function';
                    else if (parent.isKind(SyntaxKind.VariableDeclaration)) symbolType = 'variable';
                    break;
                }
            }
            if (definitionNode) break;
        }

        if (!definitionNode) {
            throw new Error(`Symbol '${symbolName}' was not found in the codebase. Please check:
1. The symbol name is correct and matches exactly (case-sensitive)
2. The symbol is defined in one of the analyzed files
3. The file containing the symbol is included in the search path`);
        }

        // シンボルの種類を判定
        const parent = definitionNode.getParent();
        if (parent) {
            if (parent.isKind(SyntaxKind.FunctionDeclaration)) symbolType = 'function';
            else if (parent.isKind(SyntaxKind.InterfaceDeclaration)) symbolType = 'interface';
            else if (parent.isKind(SyntaxKind.ClassDeclaration)) symbolType = 'class';
            else if (parent.isKind(SyntaxKind.VariableDeclaration)) symbolType = 'variable';
        }

        // 参照を収集
        const definitionFile = definitionNode.getSourceFile().getFilePath();
        
        for (const sourceFile of this.project.getSourceFiles()) {
            const currentFile = sourceFile.getFilePath();
            
            // 同一ファイルからの参照は無視する（オプションで制御可能）
            if (currentFile === definitionFile && !options?.includeInternalReferences) {
                continue;
            }
            
            const nodes = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)
                .filter(node => node.getText() === symbolName);

            for (const node of nodes) {
                // シンボルの定義が一致するもののみを参照として扱う
                // シンボルの参照をチェック
                const definitions = node.getDefinitions();
                let isReferenceToDefinition = false;

                // シンボルの定義をチェック
                for (const def of definitions) {
                    const defNode = def.getDeclarationNode();
                    if (!defNode) continue;

                    // 同じファイル内の定義をチェック
                    const isSameFile = defNode.getSourceFile().getFilePath() === definitionNode.getSourceFile().getFilePath();
                    const isSamePosition = defNode.getPos() === definitionNode.getPos();
                    if (isSameFile && isSamePosition) {
                        isReferenceToDefinition = true;
                        break;
                    }

                    // クラスのインスタンス化やメソッド呼び出しをチェック
                    const nodeParent = node.getParent();
                    if (nodeParent) {
                        if (nodeParent.isKind(SyntaxKind.NewExpression) && defNode.isKind(SyntaxKind.ClassDeclaration)) {
                            isReferenceToDefinition = true;
                            break;
                        }
                        if (nodeParent.isKind(SyntaxKind.PropertyAccessExpression) && defNode.isKind(SyntaxKind.MethodDeclaration)) {
                            isReferenceToDefinition = true;
                            break;
                        }
                    }
                }

                if (!isReferenceToDefinition) {
                    continue;
                }

                // .d.tsファイルからの参照は除外
                if (currentFile.endsWith('.d.ts')) {
                    continue;
                }

                // シンボルの定義自体は参照としてカウントしない
                const parent = node.getParent();
                if (parent && (
                    // 定義自体のノードをスキップ
                    (node === definitionNode && (
                        parent.isKind(SyntaxKind.ClassDeclaration) || 
                        parent.isKind(SyntaxKind.InterfaceDeclaration) || 
                        parent.isKind(SyntaxKind.FunctionDeclaration) ||
                        parent.isKind(SyntaxKind.MethodDeclaration) ||
                        parent.isKind(SyntaxKind.PropertyDeclaration) ||
                        parent.isKind(SyntaxKind.MethodSignature)
                    )) ||
                    // メソッド定義のシグネチャをスキップ
                    (parent.isKind(SyntaxKind.PropertyAccessExpression) && parent.getParent()?.isKind(SyntaxKind.MethodDeclaration))
                )) {
                    continue;
                }

                // インポート文での参照もカウントする
                if (parent && parent.isKind(SyntaxKind.ImportSpecifier)) {
                    const importDecl = parent.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
                    if (importDecl) {
                        const importedModule = importDecl.getModuleSpecifierValue();
                        // 相対パスの場合、フルパスを解決
                        if (importedModule.startsWith('.')) {
                            const importerDir = path.dirname(importDecl.getSourceFile().getFilePath());
                            const resolvedPath = path.resolve(importerDir, importedModule);
                            // TypeScriptの拡張子を追加
                            const possiblePaths = [
                                resolvedPath + '.ts',
                                resolvedPath + '.tsx',
                                path.join(resolvedPath, 'index.ts'),
                                path.join(resolvedPath, 'index.tsx')
                            ];
                            // 実際のファイルパスと比較
                            const targetPath = definitionNode.getSourceFile().getFilePath();
                            if (!possiblePaths.some(p => p === targetPath)) {
                                continue;
                            }
                        } else {
                            // 外部モジュールの場合はスキップ
                            continue;
                        }
                    }
                }

                const pos = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
                const containingFunction = node.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
                const containingClass = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
                const containingInterface = node.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
                const containingMethod = node.getFirstAncestorByKind(SyntaxKind.MethodDeclaration);

                // Build context information
                let context = 'global scope';
                if (containingClass) {
                    context = `class ${containingClass.getName()}`;
                    if (containingMethod) {
                        context += `.${containingMethod.getName()}`;
                    }
                } else if (containingInterface) {
                    context = `interface ${containingInterface.getName()}`;
                } else if (containingFunction) {
                    context = `function ${containingFunction.getName()}`;
                } else if (containingMethod) {
                    context = `method ${containingMethod.getName()}`;
                }

                // Convert absolute path to relative path
                const filePath = node.getSourceFile().getFilePath();
                const relativePath = path.relative(process.cwd(), filePath);

                // Create a unique key for this reference
                const refKey = `${relativePath}:${pos.line}:${pos.column}:${context}`;

                // Only add if we haven't seen this reference before
                if (!refsSet.has(refKey)) {
                    refsSet.add(refKey);
                    references.push({
                        filePath: relativePath,
                        line: pos.line,
                        column: pos.column,
                        context: context
                    });
                }
            }
        }

        // 定義情報を取得
        const defPos = definitionNode.getSourceFile().getLineAndColumnAtPos(definitionNode.getStart());
        const defFilePath = path.relative(process.cwd(), definitionNode.getSourceFile().getFilePath());
        const defContext = 'global scope';

        return {
            symbol: symbolName,
            type: symbolType,
            definition: {
                filePath: defFilePath,
                line: defPos.line,
                column: defPos.column,
                context: defContext
            },
            references: references,
            isReferenced: references.length > 0
        };
    }

    /**
     * ファイル内の未参照シンボルをチェック
     * @param filePath チェック対象のファイルパス
     * @returns 他のファイルから参照されていないシンボルのリスト
     */
    public checkFile(filePath: string): { type: string; name: string; context: string; }[] {
        const unreferencedSymbols: { type: string; name: string; context: string; }[] = [];
        const sourceFile = this.project.getSourceFileOrThrow(filePath);
        const checkedSymbols = new Set<string>();

        // クラス、インターフェース、関数、変数をチェック
        const declarations = [
            ...sourceFile.getFunctions(),
            ...sourceFile.getClasses(),
            ...sourceFile.getInterfaces(),
            ...sourceFile.getVariableDeclarations()
        ];

        // 各シンボルについて、他ファイルからの参照のみをチェック
        for (const declaration of declarations) {
            const name = declaration.getName();
            if (name && !checkedSymbols.has(name)) {
                checkedSymbols.add(name);
                const result = this.analyzeSymbol(name);
                if (!result.isReferenced) {
                    let type = result.type;
                    if (declaration.isKind(SyntaxKind.InterfaceDeclaration)) {
                        type = 'interface';
                    } else if (declaration.isKind(SyntaxKind.ClassDeclaration)) {
                        type = 'class';
                    }

                    unreferencedSymbols.push({
                        type: type,
                        name: name,
                        context: 'global scope'
                    });
                }
            }
        }

        // クラスのメソッドとプロパティをチェック
        sourceFile.getClasses().forEach(classDecl => {
            const className = classDecl.getName();

            // メソッドをチェック
            classDecl.getMethods().forEach(method => {
                const name = method.getName();
                if (name && !checkedSymbols.has(name)) {
                    checkedSymbols.add(name);
                    const result = this.analyzeSymbol(name);
                    if (!result.isReferenced) {
                        unreferencedSymbols.push({
                            type: 'method',
                            name: name,
                            context: `class ${className}`
                        });
                    }
                }
            });

            // プロパティをチェック
            classDecl.getProperties().forEach(prop => {
                const name = prop.getName();
                if (name && !checkedSymbols.has(name)) {
                    checkedSymbols.add(name);
                    const result = this.analyzeSymbol(name);
                    if (!result.isReferenced) {
                        unreferencedSymbols.push({
                            type: 'property',
                            name: name,
                            context: `class ${className}`
                        });
                    }
                }
            });
        });

        return unreferencedSymbols;
    }
}

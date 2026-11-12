import ts from 'typescript';
import { compatAt } from '../data/bcd.ts';
import type { FailureMode } from '../engine/failure.ts';
import { supportFinding, type Finding, type SupportCandidate } from '../engine/finding.ts';
import type { Target } from '../engine/targets.ts';

/**
 * Type-aware Web API and JS built-in detection. Every property access and global
 * identifier that resolves to a declaration in TypeScript's own lib files (lib.dom,
 * lib.es20xx) is mapped to BCD: `api.<Interface>.<member>`, `api.<Global>`,
 * `javascript.builtins.<Name>.<member>`. User code and node_modules are never looked up.
 */

interface Analysis {
  program: ts.Program;
  checker: ts.TypeChecker;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noEmit: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  skipLibCheck: true,
};

/**
 * `virtual` maps extra file names to contents: inline scripts from markup, padded so their
 * positions equal those in the markup file. They are type-checked like any other file.
 */
export function createAnalysis(files: string[], tsconfigPath?: string, virtual: Map<string, string> = new Map()): Analysis {
  let options = DEFAULT_OPTIONS;
  if (tsconfigPath) {
    const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (config.error) {
      // An unreadable tsconfig should not stop the check; type resolution just gets less precise.
      process.stderr.write(`quirk: ignoring ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(config.error.messageText, ' ')}\n`);
      return createAnalysis(files, undefined, virtual);
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, tsconfigPath.replace(/[/\\][^/\\]+$/, ''));
    // Browser code is the point: always include the DOM and latest ES libs so APIs resolve.
    const lib = [...new Set([...(parsed.options.lib ?? []), ...DEFAULT_OPTIONS.lib!])];
    options = { ...parsed.options, lib, allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true };
  }
  const host = ts.createCompilerHost(options);
  if (virtual.size) {
    const { fileExists, readFile, getSourceFile } = host;
    host.fileExists = (f) => virtual.has(f) || fileExists.call(host, f);
    host.readFile = (f) => virtual.get(f) ?? readFile.call(host, f);
    host.getSourceFile = (f, language, onError, shouldCreate) => {
      const text = virtual.get(f);
      return text === undefined
        ? getSourceFile.call(host, f, language, onError, shouldCreate)
        : ts.createSourceFile(f, text, language, true, ts.ScriptKind.JS);
    };
  }
  const program = ts.createProgram({ rootNames: [...files, ...virtual.keys()], options, host });
  return { program, checker: program.getTypeChecker() };
}

function isLibFile(program: ts.Program, sf: ts.SourceFile): boolean {
  return program.isSourceFileDefaultLibrary(sf) || /[/\\]typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(sf.fileName);
}

/** Declarations from TypeScript's own lib files. Other declarations (for example @types/node) are ignored. */
function libDeclarations(program: ts.Program, symbol: ts.Symbol | undefined): ts.Declaration[] {
  return (symbol?.declarations ?? []).filter((d) => isLibFile(program, d.getSourceFile()));
}

function containerName(decl: ts.Declaration): string | undefined {
  const parent = decl.parent;
  if (ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)) return parent.name?.text;
  if (ts.isModuleBlock(parent) && ts.isModuleDeclaration(parent.parent)) return parent.parent.name.getText();
  if (ts.isTypeLiteralNode(parent)) {
    // `declare var CSS: { supports(...) }` style: the variable's name.
    const holder = parent.parent;
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
  }
  return undefined;
}

/** Receiver type plus its base interfaces, breadth first: HTMLDivElement → HTMLElement → Element → … */
function receiverNames(checker: ts.TypeChecker, type: ts.Type): string[] {
  const names: string[] = [];
  const queue: ts.Type[] = [checker.getApparentType(checker.getNonNullableType(type))];
  const seen = new Set<ts.Type>();
  while (queue.length) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    if (t.isUnion() || t.isIntersection()) {
      queue.push(...t.types);
      continue;
    }
    const name = t.getSymbol()?.getName();
    if (name && !name.startsWith('__')) names.push(name);
    const target = (t as ts.TypeReference).target ?? t;
    if (target.isClassOrInterface()) queue.push(...(checker.getBaseTypes(target) ?? []));
  }
  return names;
}

function memberPath(owner: string, member: string, isStatic: boolean): string | undefined {
  const candidates = isStatic
    ? [`api.${owner}.${member}_static`, `api.${owner}.${member}`, `javascript.builtins.${owner}.${member}`]
    : [`api.${owner}.${member}`, `javascript.builtins.${owner}.${member}`];
  return candidates.find((p) => compatAt(p));
}

interface Resolved {
  path: string;
  subject: string;
  /** For instance members: the BCD path of the interface the instance belongs to. */
  ownerPath?: string;
}

function resolveMember(a: Analysis, node: ts.PropertyAccessExpression): Resolved | undefined {
  const member = node.name.text;
  const decls = libDeclarations(a.program, a.checker.getSymbolAtLocation(node.name));
  if (decls.length === 0) return undefined;

  const declaredOn = containerName(decls[0]!);
  // `ObjectConstructor.groupBy`, `namespace CSS { function supports }`: static members.
  if (declaredOn && (declaredOn.endsWith('Constructor') || ts.isModuleBlock(decls[0]!.parent) || ts.isTypeLiteralNode(decls[0]!.parent))) {
    const owner = declaredOn.replace(/Constructor$/, '');
    const path = memberPath(owner, member, true);
    return path ? { path, subject: `${owner}.${member}` } : undefined;
  }

  for (const owner of [...receiverNames(a.checker, a.checker.getTypeAtLocation(node.expression)), ...(declaredOn ? [declaredOn] : [])]) {
    const path = memberPath(owner, member, false);
    if (path) {
      // Elements are the exception: the parser creates `<dialog>` as a plain HTMLElement where
      // HTMLDialogElement is unsupported, so the instance exists and the member call still fails.
      const ownerPath = /Element$/.test(owner) ? undefined : path.slice(0, path.lastIndexOf('.'));
      return { path, subject: `${owner}.${member}`, ownerPath };
    }
  }
  return undefined;
}

function resolveGlobal(a: Analysis, node: ts.Identifier): Resolved | undefined {
  const decls = libDeclarations(a.program, a.checker.getSymbolAtLocation(node));
  if (decls.length === 0) return undefined;
  const topLevel = decls.some(
    (d) =>
      (ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent.parent.parent)) ||
      (ts.isFunctionDeclaration(d) && ts.isSourceFile(d.parent)),
  );
  if (!topLevel) return undefined;
  const name = node.text;
  const path = [`api.${name}`, `javascript.builtins.${name}`, `api.Window.${name}`].find((p) => compatAt(p));
  return path ? { path, subject: name } : undefined;
}

function isValuePosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if ((ts as unknown as { isPartOfTypeNode(n: ts.Node): boolean }).isPartOfTypeNode(node)) return false;
  if (
    (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
      ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) ||
      ts.isExportSpecifier(parent) || ts.isBindingElement(parent)) &&
    (parent as { name?: ts.Node }).name === node
  ) {
    return false;
  }
  return true;
}

function mentions(expr: ts.Node, name: string): boolean {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(expr.getText());
}

/**
 * What happens at this use when the feature is missing. A missing global is a
 * ReferenceError wherever it is read; a missing member throws only when called or constructed.
 */
function failureOf(node: ts.Node, isGlobal: boolean): FailureMode {
  if (isGlobal) return 'throws';
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return 'throws';
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'no-op';
  return 'undefined-value';
}

function exits(statement: ts.Statement): boolean {
  if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
  if (ts.isBlock(statement)) return statement.statements.some(exits);
  return false;
}

/**
 * A plain read that is itself the detection: tested in a condition (`if (navigator.share)`,
 * `!x.y`, `a.b && …`), or returned from a getter or stored in a constant for later testing
 * (`get available() { return document.startViewTransition }`). Reading never throws, so these
 * are harmless where the feature is missing.
 */
function detectionRead(node: ts.Node): string | undefined {
  const parent = node.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) return undefined;
  let n: ts.Node = node;
  while (
    ts.isParenthesizedExpression(n.parent) ||
    (ts.isPrefixUnaryExpression(n.parent) && n.parent.operator === ts.SyntaxKind.ExclamationToken) ||
    (ts.isBinaryExpression(n.parent) &&
      [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        n.parent.operatorToken.kind,
      ))
  ) {
    n = n.parent;
  }
  const p = n.parent;
  if (
    (ts.isIfStatement(p) && p.expression === n) ||
    (ts.isConditionalExpression(p) && p.condition === n) ||
    ((ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === n)
  ) {
    return 'read as a condition';
  }
  if (n !== node || !ts.isPropertyAccessExpression(node)) return undefined;
  if (ts.isReturnStatement(p) && ts.isBlock(p.parent) && ts.isGetAccessorDeclaration(p.parent.parent)) return 'returned from a detection getter';
  if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isVariableDeclarationList(p.parent) && p.parent.flags & ts.NodeFlags.Const) {
    return 'stored for detection';
  }
  return undefined;
}

/**
 * Whether a condition tests for the feature: it names it directly, or it calls or reads a
 * helper in user code (a getter, method, function or constant) whose body names it, as in
 * `get viewTransitionsAvailable() { return document.startViewTransition }`. One level deep.
 */
function detects(a: Analysis, condition: ts.Node, name: string): boolean {
  if (mentions(condition, name)) return true;
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n)) {
      const symbol = a.checker.getSymbolAtLocation(n);
      for (const d of symbol?.declarations ?? []) {
        if (isLibFile(a.program, d.getSourceFile())) continue;
        const body =
          ts.isGetAccessorDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionDeclaration(d)
            ? d.body
            : ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)
              ? d.initializer
              : undefined;
        if (body && mentions(body, name)) found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(condition);
  return found;
}

/**
 * Feature detection around a use: `if ('showModal' in d)`, `typeof X !== 'undefined'`,
 * `CSS.supports(…) && …`, `x.y?.()`, early `if (!X) return;`, or a `try` block.
 * Guards outside an inline callback count (the callback only exists once the guard
 * passed); a `try` outside one does not, since it can't catch the callback's errors.
 */
function featureGuard(a: Analysis, node: ts.Node, name: string): string | undefined {
  const parent = node.parent;
  if (ts.isTypeOfExpression(parent)) return 'typeof check';
  if (ts.isCallExpression(parent) && parent.expression === node && parent.questionDotToken) return 'optional call';
  // `navigator.permissions?.query(…)`: the result is checked for undefined before use.
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node && parent.questionDotToken) {
    return 'optional chaining';
  }
  // `x?.y`: only reached when the receiver exists, which is usually the feature being detected.
  if (ts.isPropertyAccessExpression(node) && node.questionDotToken) return 'optional chaining on receiver';
  const detection = detectionRead(node);
  if (detection) return detection;

  let child: ts.Node = node;
  let inCallback = false;
  for (let p: ts.Node | undefined = parent; p && !ts.isSourceFile(p); child = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === child && detects(a, p.expression, name)) return `if (${p.expression.getText()})`;
    if (ts.isConditionalExpression(p) && p.whenTrue === child && detects(a, p.condition, name)) return 'conditional expression';
    if (ts.isBinaryExpression(p) && p.right === child && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && detects(a, p.left, name)) {
      return `${p.left.getText()} &&`;
    }
    if (ts.isTryStatement(p) && p.tryBlock === child && !inCallback) return 'try block';
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      const statements = (p as ts.Block).statements;
      const index = statements.indexOf(child as ts.Statement);
      const early = statements.slice(0, Math.max(index, 0)).find(
        (s) => ts.isIfStatement(s) && detects(a, s.expression, name) && exits(s.thenStatement),
      ) as ts.IfStatement | undefined;
      if (early) return `early exit: if (${early.expression.getText()})`;
    }
    if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) inCallback = true;
    else if (ts.isFunctionLike(p)) break;
  }
  return undefined;
}

export function analyzeJs(a: Analysis, file: string, targets: Target[]): Finding[] {
  const sf = a.program.getSourceFile(file);
  if (!sf) return [];
  const findings: Finding[] = [];
  const seen = new Set<string>();

  const report = (node: ts.Node, nameNode: ts.Node, resolved: Resolved, guardName: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf));
    const key = `${resolved.path}@${line}:${character}`;
    if (seen.has(key)) return;
    seen.add(key);
    const candidate: SupportCandidate = {
      bcdPath: resolved.path,
      subject: resolved.subject,
      location: { file, line: line + 1, column: character + 1 },
      ownerPath: resolved.ownerPath,
      failure: failureOf(node, ts.isIdentifier(node)),
    };
    const finding = supportFinding(candidate, targets);
    if (!finding) return;
    const guard = featureGuard(a, node, guardName);
    if (guard) finding.suppressed = { reason: 'feature-detect', detail: guard };
    findings.push(finding);
  };

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const resolved = resolveMember(a, node);
      if (resolved) report(node, node.name, resolved, node.name.text);
    } else if (ts.isIdentifier(node) && isValuePosition(node)) {
      const resolved = resolveGlobal(a, node);
      if (resolved) report(node, node, resolved, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

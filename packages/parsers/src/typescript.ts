import ts from 'typescript';
import type { CallRecord, ExtractedEntity, ImportRecord, Marker, ParsedFile } from '@repoatlas/core';
import { addProblem, emptyResult, type ParserContext, type SourceParser } from './contract.js';

/**
 * TypeScript / JavaScript extractor built on the TypeScript compiler API.
 *
 * Why the compiler API rather than regular expressions: it is the only approach
 * that gives a real AST for JavaScript's comment syntax, template literals and
 * destructuring, and it ships with the toolchain we already depend on — no grammar
 * downloads, no native build step. Regex extraction of imports and function names
 * is wrong often enough to corrupt the dependency graph.
 *
 * The parser is read-only and offline. `ts.createSourceFile` parses text without
 * resolving modules or touching the filesystem, so no repository-supplied code is
 * loaded, imported or executed.
 */

const PRODUCER = 'typescript-compiler-api';

export class TypeScriptSourceParser implements SourceParser {
  readonly producer = PRODUCER;
  readonly language = 'typescript';

  supports(context: ParserContext): boolean {
    return context.language === 'typescript' || context.language === 'javascript';
  }

  parse(source: string, context: ParserContext): ParsedFile {
    const started = performance.now();
    const result = emptyResult(context, this.producer);

    const sourceFile = ts.createSourceFile(
      context.path,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      scriptKindFor(context.path),
    );

    // `parseDiagnostics` is reachable but not part of the public typings; it is the
    // documented way to read syntax errors off a source file.
    const syntactic = (sourceFile as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] })
      .parseDiagnostics;
    if (syntactic) {
      for (const diagnostic of syntactic.slice(0, context.maxProblems)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        addProblem(
          result,
          {
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
            line: line + 1,
            code: `TS${diagnostic.code}`,
          },
          context.maxProblems,
        );
      }
    }

    const ctx: WalkContext = {
      sourceFile,
      result,
      maxCalls: context.maxCalls,
      stack: [],
    };

    for (const statement of sourceFile.statements) {
      visit(statement, ctx);
    }

    result.durationMs = Math.round(performance.now() - started);
    return result;
  }
}

interface WalkContext {
  sourceFile: ts.SourceFile;
  result: ParsedFile;
  maxCalls: number;
  /** Enclosing entity qualified names, outermost first. */
  stack: string[];
}

/**
 * Depth-first walk.
 *
 * Named declarations that introduce a *scope* are handled here rather than in a
 * `forEachChild` continuation so the scope stack can be pushed and popped correctly.
 * Without that, a sibling method would inherit the previous method's name as its parent.
 */
function visit(node: ts.Node, ctx: WalkContext): void {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    ctx.result.imports.push(makeImport(node.moduleSpecifier.text, node, ctx, node.importClause?.isTypeOnly ? 'type_only' : 'static'));
    return;
  }

  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    ctx.result.imports.push(makeImport(node.moduleSpecifier.text, node, ctx, node.isTypeOnly ? 'type_only' : 'reexport'));
    return;
  }

  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    if (ts.isStringLiteralLike(expression)) {
      ctx.result.imports.push(makeImport(expression.text, node, ctx, 'require'));
    }
    return;
  }

  if (ts.isCallExpression(node)) {
    handleCallExpression(node, ctx);
  }

  // Control flow is recorded only from explicit source constructs. Nothing downstream infers
  // a branch or a loop from the shape of a call graph: an activity diagram built from calls
  // would be a diagram of the dependency structure wearing a workflow's clothes.
  const flow = controlFlowMarker(node, ctx);
  if (flow) ctx.result.markers.push(flow);

  const declaration = describeDeclaration(node, ctx);
  if (declaration) {
    ctx.result.entities.push(declaration.entity);
    if (declaration.opensScope) {
      // Only callable containers own the code inside them. A `const x = f()` does
      // not make `f` a call made *by x*; attributing it that way would misreport the
      // call graph and produce nonsense qualified names like `handler.value`.
      ctx.stack.push(declaration.entity.qualifiedName);
      node.forEachChild((child) => visit(child, ctx));
      ctx.stack.pop();
      return;
    }
  }

  node.forEachChild((child) => visit(child, ctx));
}

interface DeclarationDescription {
  entity: ExtractedEntity;
  /** True when the declaration introduces a scope that contains other declarations. */
  opensScope: boolean;
}

/** Returns an entity for named declarations, or `undefined` for everything else. */
function describeDeclaration(node: ts.Node, ctx: WalkContext): DeclarationDescription | undefined {
  const base = (
    kind: ExtractedEntity['kind'],
    name: string,
    target: ts.Node,
    extra: Partial<ExtractedEntity> = {},
    opensScope = false,
  ): DeclarationDescription => ({
    entity: buildEntity(kind, name, target, ctx, extra),
    opensScope,
  });

  if (ts.isFunctionDeclaration(node) && node.name) {
    const modifiers = modifiersOf(node);
    return base(
      'function',
      node.name.text,
      node,
      {
        signature: signatureOf(node, ctx),
        modifiers,
        // Explicitly `async`, or explicitly not. Absent would mean "the source did not say",
        // which for a declaration is a different claim from "synchronous".
        ...(modifiers?.includes('async') ? { isAsync: true } : { isAsync: false }),
      },
      true,
    );
  }


  if (ts.isClassDeclaration(node)) {
return base(
      'class',
      node.name?.text ?? 'default',
      node,
      {
        extendsFrom: heritageNames(node.heritageClauses, ts.SyntaxKind.ExtendsKeyword, ctx.sourceFile),
        implementsFrom: heritageNames(node.heritageClauses, ts.SyntaxKind.ImplementsKeyword, ctx.sourceFile),
        modifiers: modifiersOf(node),
      },
      true,
    );
  }

  if (ts.isInterfaceDeclaration(node)) {
return base(
      'interface',
      node.name.text,
      node,
      {
        extendsFrom: heritageNames(node.heritageClauses, ts.SyntaxKind.ExtendsKeyword, ctx.sourceFile),
        modifiers: modifiersOf(node),
      },
      true,
    );
  }

  if (ts.isTypeAliasDeclaration(node)) {
    return base('type', node.name.text, node);
  }

if (ts.isEnumDeclaration(node)) {
    return base('constant', node.name.text, node, {}, true);
  }

  // `module Foo {}` is not extracted here: the graph builder already creates a module
  // node per file, and a second module entity for the same scope would be a duplicate.

  if (ts.isMethodDeclaration(node)) {
    const name = propertyNameText(node.name);
    if (!name) return undefined;
    const modifiers = modifiersOf(node);
    return base(
      'function',
      name,
      node,
      {
        signature: signatureOf(node, ctx),
        modifiers,
        ...(modifiers?.includes('async') ? { isAsync: true } : { isAsync: false }),
      },
      true,
    );
  }

  if (ts.isConstructorDeclaration(node)) {
    return base('function', 'constructor', node, { signature: signatureOf(node, ctx) }, true);
  }

  // A property or variable whose initialiser is a function *is* a scope: the arrow
  // function body belongs to it. A plain initialiser is not, so `const x = f()` keeps
  // the call attributed to whatever encloses the declaration.
  if (ts.isPropertyDeclaration(node) && node.name && node.initializer) {
    const name = propertyNameText(node.name);
    if (!name) return undefined;
    const functional = isArrowOrFunction(node.initializer);
    return base(
      functional ? 'function' : 'constant',
      name,
      node,
      {
        ...(functional
          ? {
              signature: signatureOf(node.initializer as ts.SignatureDeclaration, ctx),
              isAsync: hasAsyncModifier(node.initializer),
            }
          : {}),
      },
      functional,
    );
  }

  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
    const functional = isArrowOrFunction(node.initializer);
    const typeText = node.type?.getText(ctx.sourceFile).replace(/\s+/g, ' ');
    return base(
      functional ? 'function' : 'constant',
      node.name.text,
      node,
      {
        ...(functional
          ? {
              signature: signatureOf(node.initializer as ts.SignatureDeclaration, ctx),
              isAsync: hasAsyncModifier(node.initializer),
            }
          : {}),
        ...(typeText ? { attributes: { declaredType: typeText } } : {}),
      },
      functional,
    );
  }

  if (ts.isEnumMember(node) && node.name) {
    const name = propertyNameText(node.name);
    return name ? base('constant', name, node) : undefined;
  }

  return undefined;
}

function buildEntity(
  kind: ExtractedEntity['kind'],
  name: string,
  node: ts.Node,
  ctx: WalkContext,
  extra: Partial<ExtractedEntity> = {},
): ExtractedEntity {
  const parent = ctx.stack.at(-1);
  const start = safeStart(node, ctx);

  return {
    kind,
    name,
    qualifiedName: parent ? `${parent}.${name}` : name,
    language: ctx.sourceFile.languageVariant === ts.LanguageVariant.JSX ? 'javascript' : 'typescript',
    startLine: lineOf(ctx, start),
    endLine: lineOf(ctx, node.getEnd()),
    ...extra,
  };
}

function safeStart(node: ts.Node, ctx: WalkContext): number {
  try {
    return node.getStart(ctx.sourceFile);
  } catch {
    return node.pos >= 0 ? node.pos : 0;
  }
}

function handleCallExpression(node: ts.CallExpression, ctx: WalkContext): void {
  // `import(...)` has an ImportKeyword expression rather than an identifier, so it must
  // be recognised structurally before any name-based handling.
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier)) {
      ctx.result.imports.push(makeImport(specifier.text, node, ctx, 'dynamic'));
    }
    // A dynamic import is not a call to a repository function; do not record one.
    return;
  }

  const calleeText = calleeName(node.expression);

  if (calleeText === 'require' && node.arguments.length >= 1) {
    const first = node.arguments[0];
    if (first && ts.isStringLiteralLike(first)) {
      ctx.result.imports.push(makeImport(first.text, node, ctx, 'require'));
    }
  }

  const query = sqlQueryMarker(node.arguments, ctx);
  if (query) ctx.result.markers.push(query);

const route = routeMarker(node, ctx);
  if (route) ctx.result.markers.push(route);

  const middleware = middlewareMarker(node, ctx);
  if (middleware) ctx.result.markers.push(middleware);

  const testCase = testMarker(node, ctx);
  if (testCase) ctx.result.markers.push(testCase);

  if (ctx.result.calls.length < ctx.maxCalls && calleeText) {
    const call: CallRecord = {
      callee: calleeText,
      line: lineOf(ctx, safeStart(node, ctx)),
      isLocalIdentifier: isPlainIdentifier(calleeText),
      argCount: node.arguments.length,
    };
    const enclosing = ctx.stack.at(-1);
    if (enclosing) call.fromQualifiedName = enclosing;
    ctx.result.calls.push(call);
  }
}

function makeImport(
  specifier: string,
  node: ts.Node,
  ctx: WalkContext,
  kind: ImportRecord['kind'],
): ImportRecord {
  const names: string[] = [];
  const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
  if (clause?.name) names.push(clause.name.text);
  if (clause?.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.push(`* as ${clause.namedBindings.name.text}`);
    } else {
      for (const element of clause.namedBindings.elements) {
        names.push(
          element.propertyName
            ? `${element.propertyName.text} as ${element.name.text}`
            : element.name.text,
        );
      }
    }
  }
  if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      names.push(
        element.propertyName ? `${element.propertyName.text} as ${element.name.text}` : element.name.text,
      );
    }
  }

  return {
    specifier,
    names,
    kind,
    line: lineOf(ctx, safeStart(node, ctx)),
    isExternal: isExternalSpecifier(specifier),
  };
}

/** A specifier is external unless it is relative, an absolute path, or a Node subpath. */
function isExternalSpecifier(specifier: string): boolean {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false;
  if (specifier.startsWith('node:')) return false;
  return true;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const object = calleeName(expression.expression);
    return object ? `${object}.${expression.name.text}` : expression.name.text;
  }
  if (ts.isElementAccessExpression(expression)) {
    const object = calleeName(expression.expression);
    const argument = expression.argumentExpression;
    const key = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
    return key ? `${object ?? ''}[${key}]` : undefined;
  }
  if (ts.isCallExpression(expression)) {
    const inner = calleeName(expression.expression);
    return inner ? `${inner}()` : undefined;
  }
  if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression);
  if (ts.isNewExpression(expression)) return `new ${calleeName(expression.expression) ?? '?'}`;
  return undefined;
}

function isPlainIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options', 'all']);
const ROUTE_HOLDERS = new Set([
  'app', 'server', 'router', 'api', 'route', 'fastify', 'express', 'hono', 'index',
]);

/**
 * Recognises Express/Fastify/Hono route registration.
 *
 * Only method-plus-string-literal calls on a known router variable qualify, so a
 * `store.get('/x')` call is not mistaken for an HTTP endpoint.
 */
function routeMarker(node: ts.CallExpression, ctx: WalkContext): Marker | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const method = callee.name.text.toLowerCase();
  if (!HTTP_METHODS.has(method)) return undefined;

  const holder = expressionRoot(callee.expression);
  if (!holder || !ROUTE_HOLDERS.has(holder)) return undefined;

  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;

  const attributes: Marker['attributes'] = { httpMethod: method.toUpperCase(), path: first.text };
  const handler = node.arguments[1];
  if (handler) attributes.handler = handler.getText(ctx.sourceFile).replace(/\s+/g, ' ').slice(0, 120);

  return { name: 'http.route', line: lineOf(ctx, safeStart(node, ctx)), attributes };
}

/** Recognises `app.use('/mount', router)` so middleware boundaries become visible. */
function middlewareMarker(node: ts.CallExpression, ctx: WalkContext): Marker | undefined {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'use') return undefined;
  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;
  return {
    name: 'middleware.mount',
    line: lineOf(ctx, safeStart(node, ctx)),
    attributes: { path: first.text, target: node.getText(ctx.sourceFile).replace(/\s+/g, ' ').slice(0, 120) },
  };
}

/** Test-framework entry points recognised in JavaScript and TypeScript. */
const TEST_SUITE_FUNCTIONS = new Set(['describe', 'suite', 'context']);
const TEST_CASE_FUNCTIONS = new Set(['it', 'test']);

/**
 * Recognises test declarations.
 *
 * A `describe`/`it` call with a string-literal title is how almost every JavaScript and
 * TypeScript test suite names its cases, so it is the most reliable test evidence
 * available without executing anything. The title is taken from the literal the source
 * actually contains.
 */
function testMarker(node: ts.CallExpression, ctx: WalkContext): Marker | undefined {
  const callee = node.expression;
  if (!ts.isIdentifier(callee)) return undefined;

  const isSuite = TEST_SUITE_FUNCTIONS.has(callee.text);
  const isCase = TEST_CASE_FUNCTIONS.has(callee.text);
  if (!isSuite && !isCase) return undefined;

  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;

  const attributes: Marker['attributes'] = { title: first.text };
  if (isCase) {
    const mode = node.arguments[1];
    if (mode && ts.isStringLiteralLike(mode)) attributes.mode = mode.text;
  }

  return {
    name: isSuite ? 'test.suite' : 'test.case',
    line: lineOf(ctx, safeStart(node, ctx)),
    attributes,
  };
}

function expressionRoot(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expressionRoot(expression.expression);
  return undefined;
}

/**
 * Reads heritage clause type names.
 *
 * `getText` requires the source file to be passed explicitly: the parse tree is built
 * with `setParentNodes: false`, so a node cannot find its source file by walking parents
 * and an argument-less `getText()` throws.
 */
function heritageNames(
  clauses: readonly ts.HeritageClause[] | undefined,
  kind: ts.SyntaxKind,
  sourceFile: ts.SourceFile,
): string[] | undefined {
  if (!clauses) return undefined;
  const names: string[] = [];
  for (const clause of clauses) {
    if (clause.token !== kind) continue;
    for (const type of clause.types) {
      names.push(stripTypeArguments(type.expression.getText(sourceFile)));
    }
  }
  return names.length > 0 ? names : undefined;
}

function stripTypeArguments(text: string): string {
  const index = text.indexOf('<');
  return (index === -1 ? text : text.slice(0, index)).trim();
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isArrowOrFunction(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** True when a function expression or arrow carries the `async` modifier. */
function hasAsyncModifier(node: ts.Node): boolean {
  try {
    return modifiersOf(node)?.includes('async') ?? false;
  } catch {
    return false;
  }
}

/**
 * Control-flow constructs, mapped to the marker that records them.
 *
 * A `try` is recorded as a `handler` rather than a branch: the interesting fact is that an
 * exception path exists at all, and a `catch` clause is where the repository states what
 * happens when something fails.
 */
type ControlFlowKind = 'branch' | 'loop' | 'handler';

function controlFlowMarker(node: ts.Node, ctx: WalkContext): Marker | undefined {
  const kind = controlFlowKind(node);
  if (!kind) return undefined;

  // Attributed to the innermost named scope. A condition in a module-level statement has no
  // scope to attach to, and inventing one would produce an unattached decision point.
  const scope = ctx.stack.at(-1);
  if (!scope) return undefined;

  const condition = controlFlowCondition(node, ctx.sourceFile);
  return {
    name: `control.${kind}`,
    line: lineOf(ctx, safeStart(node, ctx)),
    attributes: {
      flow: kind,
      scope,
      ...(condition ? { condition } : {}),
    },
  };
}

function controlFlowKind(node: ts.Node): ControlFlowKind | undefined {
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node)) return 'branch';
  if (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  ) {
    return 'loop';
  }
  if (ts.isTryStatement(node)) return 'handler';
  return undefined;
}

/**
 * The condition as written, collapsed to one line.
 *
 * Truncated because a generated condition can be arbitrarily long, and the projection shows
 * it as a label rather than as code.
 */
function controlFlowCondition(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  let expression: ts.Expression | undefined;
  if (ts.isIfStatement(node)) expression = node.expression;
  else if (ts.isConditionalExpression(node)) expression = node.condition;
  else if (ts.isSwitchStatement(node)) expression = node.expression;
  else if (ts.isWhileStatement(node) || ts.isDoStatement(node)) expression = node.expression;
  else if (ts.isForStatement(node)) expression = node.condition;
  else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) expression = node.expression;

  if (!expression) return undefined;
  try {
    const text = expression.getText(sourceFile).replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A SQL statement passed as a string literal to a call.
 *
 * This is the only place data flow comes from: a `reads`/`writes` edge exists when the code
 * literally contains a query naming a table. No ORM, repository naming convention or
 * "module looks like a data layer" heuristic is used, because each of those produces data
 * flow that the repository never states.
 */
function sqlQueryMarker(args: readonly ts.Expression[], ctx: WalkContext): Marker | undefined {
  for (const argument of args) {
    if (!ts.isStringLiteralLike(argument)) continue;
    const statement = parseSqlStatement(argument.text);
    if (!statement) continue;
    return {
      name: 'sql.query',
      line: lineOf(ctx, safeStart(argument, ctx)),
      attributes: {
        operation: statement.operation,
        table: statement.table,
      },
    };
  }
  return undefined;
}

/**
 * Recognises a single-table SQL statement written in a string literal.
 *
 * Deliberately narrow: one statement, one table, no joins and no subquery. A join names two
 * tables and the code does not say which of them this call reads or writes, so such a
 * statement is reported as unsupported by the data projection rather than attributed to the
 * first table matched.
 */
export function parseSqlStatement(text: string): { operation: string; table: string } | null {
  const statement = text.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  if (statement.length === 0) return null;

  const single = (primary: RegExp, other: readonly RegExp[]): boolean => {
    if (countMatches(statement, primary) !== 1) return false;
    return other.every((pattern) => countMatches(statement, pattern) === 0);
  };

  const select = /^SELECT\s+.+?\s+FROM\s+([A-Za-z_][\w.]*)/i.exec(statement);
  if (select && single(/\bFROM\s+[A-Za-z_][\w.]*/gi, [/\bJOIN\s+[A-Za-z_][\w.]*/gi])) {
    return tableOf('read', select[1]);
  }

  const insert = /^INSERT\s+INTO\s+([A-Za-z_][\w.]*)/i.exec(statement);
  if (insert && single(/\bINTO\s+[A-Za-z_][\w.]*/gi, [/\bFROM\s+/gi])) {
    return tableOf('write', insert[1]);
  }

  const update = /^UPDATE\s+([A-Za-z_][\w.]*)\s+SET\s+/i.exec(statement);
  if (update && single(/\bUPDATE\s+[A-Za-z_][\w.]*/gi, [/\bFROM\s+/gi, /\bJOIN\s+/gi])) {
    return tableOf('write', update[1]);
  }

  const del = /^DELETE\s+FROM\s+([A-Za-z_][\w.]*)/i.exec(statement);
  if (del && single(/\bFROM\s+[A-Za-z_][\w.]*/gi, [/\bJOIN\s+[A-Za-z_][\w.]*/gi])) {
    return tableOf('write', del[1]);
  }

  return null;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** Normalises a possibly quoted, possibly qualified table name to its bare name. */
function tableOf(operation: string, raw: string | undefined): { operation: string; table: string } | null {
  if (!raw) return null;
  const table = raw.replace(/^["`[]|["`\]]$/g, '').split('.').at(-1);
  return table ? { operation, table } : null;
}


function modifiersOf(node: ts.Node): string[] | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  const modifiers = ts.getModifiers(node);
  if (!modifiers || modifiers.length === 0) return undefined;
  const names = modifiers
    .map((modifier) => ts.tokenToString(modifier.kind))
    .filter((text): text is string => typeof text === 'string');
  return names.length > 0 ? names : undefined;
}

/** Renders a parameter list as a compact signature for the entity inspector. */
function signatureOf(node: ts.SignatureDeclaration, ctx: WalkContext): string {
  const params = node.parameters
    .map((parameter) => parameter.getText(ctx.sourceFile).replace(/\s+/g, ' '))
    .join(', ');
  const returnType = node.type ? `: ${node.type.getText(ctx.sourceFile).replace(/\s+/g, ' ')}` : '';
  return `(${params})${returnType}`;
}

function lineOf(ctx: WalkContext, position: number): number {
  return ctx.sourceFile.getLineAndCharacterOfPosition(Math.max(0, position)).line + 1;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  if (path.endsWith('.json')) return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

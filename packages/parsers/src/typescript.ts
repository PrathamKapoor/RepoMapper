import ts from 'typescript';
import type { CallRecord, CallResult, ExtractedEntity, ImportRecord, Marker, ParsedFile } from '@repoatlas/core';
import { addProblem, emptyResult, type ParserContext, type SourceParser } from './contract.js';
import { analyzeSql } from './sql.js';

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
      inlineHandlers: new Map(),
      awaitedCalls: new Set(),
      returnedExpressions: new Map(),
      responseStatus: new Map(),
      pendingResponseStatus: [],
      pendingStatusOnly: [],
    };

    for (const statement of sourceFile.statements) {
      visit(statement, ctx);
    }

    resolveChainedResponseStatuses(ctx);

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
  /**
   * Inline route handler nodes already named by a registration seen earlier in the walk.
   *
   * Keyed by node identity: the source file is parsed without parent pointers, so the arrow
   * cannot discover its own registration after the fact.
   */
  inlineHandlers: Map<ts.Node, InlineHandler>;
  /**
   * Phase 4. Return and await context, recorded by node identity during the walk.
   *
   * The source file is parsed without parent pointers, so a call cannot ask whether it is
   * `await`ed or what a `return` statement does with its value. The `await` and `return` nodes
   * are visited first — a parent is always visited before its children — so they register the
   * fact and the call reads it.
   */
  awaitedCalls: Set<ts.Node>;
  returnedExpressions: Map<ts.Node, CallResult>;
  /** Status literals from configuring calls, keyed by the call that carries them. */
  responseStatus: Map<ts.Node, number>;
  /** `res.status(201).json(…)` pairs awaiting the status their configuring call records. */
  pendingResponseStatus: { producer: ts.Node; configurer: ts.Node }[];
  /**
   * Phase 4. A status set on a response object with no call yet known to produce a body.
   *
   * Held rather than recorded immediately because `reply.status(201).send(x)` also matches, and
   * in that case the status belongs to the producing call. Recording both would report one
   * answered request as two.
   */
  pendingStatusOnly: { node: ts.CallExpression; status: number; scope: string | undefined }[];
}

/**
 * Depth-first walk.
 *
 * Named declarations that introduce a *scope* are handled here rather than in a
 * `forEachChild` continuation so the scope stack can be pushed and popped correctly.
 * Without that, a sibling method would inherit the previous method's name as its parent.
 */
function visit(node: ts.Node, ctx: WalkContext): void {
  // Phase 4. Recorded before anything else, because both facts are about a *descendant* and a
  // parent is always visited before its children.
  recordAwait(node, ctx);
  recordBinding(node, ctx);
  recordReturn(node, ctx);
  recordThrow(node, ctx);
  recordHttpResponse(node, ctx);

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
/**
 * The name given to an inline route handler.
 *
 * `app.get('/reports', async (request, response) => { … })` is the most common shape in
 * Express, Fastify and Hono code, and an anonymous arrow in a call argument is not a
 * declaration the walker would otherwise record. Without a name, the calls inside that arrow
 * are attributed to the module and the endpoint has nothing behind it — no sequence message,
 * no use-case step, nothing traceable to a file and a line.
 *
 * The name is derived from the registration the source already contains, and it is the same
 * string in the route marker and in the function entity, so the two resolve to each other. It
 * is not a claim that the author named the function; the entity records `routeHandler`, which
 * is how the graph knows why this name exists.
 */
export function inlineRouteHandlerName(method: string, path: string): string {
  return `${method.toUpperCase()} ${path} handler`;
}

interface InlineHandler {
  name: string;
  method: string;
  path: string;
}

/**
 * Names inline route handlers found while walking.
 *
 * Recorded rather than re-derived: the source file is parsed without parent pointers, for
 * speed, so an arrow function cannot ask what call it belongs to. The route registration is
 * seen first during the walk, so it registers the handler node by identity and the declaration
 * pass looks it up.
 */
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

  // An inline route handler is a function the source does contain; only its name is ours.
  const inline = ctx.inlineHandlers.get(node);
  if (inline) {
    const async = hasAsyncModifier(node);
    return base(
      'function',
      inline.name,
      node,
      {
        modifiers: async ? ['async'] : undefined,
        isAsync: async,
        attributes: { routeHandler: true, method: inline.method, path: inline.path },
      },
      true,
    );
  }

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

  for (const query of sqlQueryMarkers(node.arguments, ctx)) ctx.result.markers.push(query);

const route = routeMarker(node, ctx);
  if (route) {
    ctx.result.markers.push(route);
    // Name an inline handler now, while the registration is in hand. The declaration pass runs
    // over the same nodes later and looks the name up by identity.
    const registration = routeRegistration(node);
    const handler = registration?.handler;
    if (registration && handler && isArrowOrFunction(handler) && route.attributes.handlerDerived === true) {
      ctx.inlineHandlers.set(handler, {
        name: String(route.attributes.handler),
        method: registration.method.toUpperCase(),
        path: registration.path,
      });
    }
  }

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

    // Phase 4. The call's result context, recorded by the `await` and `return` statements that
    // were visited before this call. Absent means the source says nothing about the result,
    // which is preserved rather than defaulted to "returns nothing".
    if (ctx.awaitedCalls.has(node)) call.awaited = true;
    const returned = ctx.returnedExpressions.get(node);
    if (returned) call.result = returned;
    else if (ctx.awaitedCalls.has(node)) call.result = { kind: 'awaited_call', line: call.line, awaited: true };

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
 * The route registration a call expression performs, if any.
 *
 * Shared by the route marker and by inline-handler naming so the two can never disagree about
 * which call is a route.
 *
 * Only a method-plus-string-literal call on a known router variable qualifies, so a
 * `store.get('/x')` call is not mistaken for an HTTP endpoint.
 */
function routeRegistration(node: ts.Node): { method: string; path: string; handler: ts.Expression | undefined } | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  const method = callee.name.text.toLowerCase();
  if (!HTTP_METHODS.has(method)) return undefined;

  const holder = expressionRoot(callee.expression);
  if (!holder || !ROUTE_HOLDERS.has(holder)) return undefined;

  const first = node.arguments[0];
  if (!first || !ts.isStringLiteralLike(first)) return undefined;

  return { method, path: first.text, handler: node.arguments[1] };
}

function routeMarker(node: ts.CallExpression, ctx: WalkContext): Marker | undefined {
  const registration = routeRegistration(node);
  if (!registration) return undefined;

  const attributes: Marker['attributes'] = { httpMethod: registration.method.toUpperCase(), path: registration.path };
  const handler = registration.handler;
  if (handler) {
    if (isArrowOrFunction(handler)) {
      // Name the handler from the registration, so the endpoint resolves to the function that
      // serves it. Keeping the arrow's source text instead resolves to nothing, and an
      // endpoint with no handler is an endpoint with no behaviour behind it.
      attributes.handler = inlineRouteHandlerName(registration.method, registration.path);
      attributes.handlerDerived = true;
    } else {
      attributes.handler = handler.getText(ctx.sourceFile).replace(/\s+/g, ' ').slice(0, 120);
    }
  }

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
 * SQL statements passed as a string literal to a call.
 *
 * This is where data access comes from: a `reads`/`writes` relationship exists when the code
 * literally contains a query naming a table. No ORM, repository naming convention or "module
 * looks like a data layer" heuristic is used, because each of those produces data flow the
 * repository never states.
 *
 * One marker is emitted per table the statement touches, so a join or a subquery yields two
 * facts rather than one guess about which table the call "really" used. Each marker carries the
 * role the name appeared in, which is what makes the read/write split checkable rather than
 * merely plausible.
 *
 * A statement this analyser will not classify still produces a `sql.statement` marker, so the
 * data projection can say "a query is here and I did not understand it" instead of silence.
 */
function sqlQueryMarkers(args: readonly ts.Expression[], ctx: WalkContext): Marker[] {
  const markers: Marker[] = [];

  for (const argument of args) {
    if (!ts.isStringLiteralLike(argument)) continue;
    const analysis = analyzeSql(argument.text);
    if (!analysis) continue;

    const line = lineOf(ctx, safeStart(argument, ctx));
    const scope = ctx.stack.at(-1);

    if (analysis.tables.length === 0) {
      markers.push({
        name: 'sql.statement',
        line,
        attributes: {
          summary: analysis.summary,
          unsupported: analysis.unsupportedReason ?? null,
          ...(scope ? { scope } : {}),
        },
      });
      continue;
    }

    for (const access of analysis.tables) {
      markers.push({
        name: 'sql.query',
        line,
        attributes: {
          operation: access.operation,
          table: access.table,
          role: access.role,
          statement: analysis.summary,
          statementCount: analysis.statementCount,
          ...(scope ? { scope } : {}),
        },
      });
    }

    if (analysis.ctes.length > 0) {
      markers.push({
        name: 'sql.cte',
        line,
        attributes: {
          names: analysis.ctes.join(','),
          statement: analysis.summary,
          ...(scope ? { scope } : {}),
        },
      });
    }
  }

  return markers;
}

/**
 * Recognises a single-table SQL statement written in a string literal.
 *
 * Retained as the narrow compatibility surface used by callers that only need a single
 * operation/table pair. It now delegates to the statement analyser, so a join is refused here
 * exactly as it is refused in the marker path, and the two can never disagree.
 */
export function parseSqlStatement(text: string): { operation: string; table: string } | null {
  const analysis = analyzeSql(text);
  if (!analysis || analysis.tables.length !== 1) return null;
  const access = analysis.tables[0]!;
  return { operation: access.operation, table: access.table };
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

/**
 * Phase 4: what an interaction hands back.
 *
 * These helpers record three facts the sequence view needs and the call graph alone cannot
 * supply: a call that is `await`ed, a `return` statement's use of a call's value, and an HTTP
 * response written by a handler. Each is recorded at the *site* that states it, because that
 * is where the evidence is: `return service.find(id)` says the caller hands back the callee's
 * value, while `service.find(id)` on its own says nothing about the result.
 *
 * Absence is preserved. A call with no recorded result is a call the source says nothing about,
 * which is not the same as a call that returns nothing, and the sequence view says so rather
 * than drawing an empty return.
 */

/** Response methods whose call *is* the response. */
const RESPONSE_METHODS = new Set(['json', 'jsonp', 'send', 'sendFile', 'sendStatus', 'download', 'redirect', 'write', 'end']);

/** Methods that configure a response rather than produce it. */
const RESPONSE_CONFIGURERS = new Set(['status', 'statusCode', 'code', 'set', 'header', 'setHeader', 'type', 'contentType', 'location']);

/**
 * Identifiers that name a response object.
 *
 * `reply.status(404)` is a response; `queue.status(200)` is not, and the two are written
 * identically. Without this the extractor reports an HTTP response for every object in the
 * repository that happens to have a `status` method — the fabricated-evidence failure mode the
 * whole design exists to avoid. Naming the object is the same evidence a reader would use, taken
 * from the code rather than from convention about what a handler looks like.
 */
const RESPONSE_OBJECTS = new Set(['reply', 'res', 'response', 'ctx', 'this']);

/**
 * Records that a call is the operand of `await`.
 *
 * `await service.get(id)` resumes with a value; `service.get(id)` on its own says nothing about
 * what happens next. Drawing a return for the second would be a claim the source never made.
 */
function recordAwait(node: ts.Node, ctx: WalkContext): void {
  if (!ts.isAwaitExpression(node)) return;
  const operand = unwrapParens(node.expression);
  if (ts.isCallExpression(operand)) ctx.awaitedCalls.add(operand);
}

/**
 * Records what a `return` statement does with its expression.
 *
 * Only the outer expression is classified. `return a + b` is recorded as an expression with no
 * name, because naming a value there would mean inventing one; `return findById(id)` names the
 * callee, because that name is written in the source.
 */
function recordReturn(node: ts.Node, ctx: WalkContext): void {
  if (!ts.isReturnStatement(node)) return;

  // `return;` returns nothing, and that is still a return statement. Recording it keeps "returns
  // nothing explicitly" distinct from "has no return statement at all".
  if (!node.expression) {
    (ctx.result.returns ??= []).push({
      line: lineOf(ctx, safeStart(node, ctx)),
      ...(ctx.stack.at(-1) ? { fromQualifiedName: ctx.stack.at(-1) } : {}),
      kind: 'bare',
    });
    return;
  }

  const expression = unwrapParens(node.expression);
  const line = lineOf(ctx, safeStart(node, ctx));
  const result = classifyReturnedExpression(expression, line);
  if (!result) return;

  ctx.returnedExpressions.set(expression, result);
  (ctx.result.returns ??= []).push({
    line,
    ...(ctx.stack.at(-1) ? { fromQualifiedName: ctx.stack.at(-1) } : {}),
    kind: result.kind,
    ...(result.name ? { name: result.name } : {}),
    ...(result.awaited ? { awaited: true } : {}),
    expression: clip(expression.getText(ctx.sourceFile), 120),
  });
}

/**
 * Records a local binding whose initialiser is a call.
 *
 * `const rows = await findAll()` followed by `return rows` is the most common way a handler
 * returns something, and the return statement names neither the callee nor a type. Recording the
 * binding is what lets the graph connect the two — as an explicitly weaker inference than a
 * direct `return findAll()`.
 */
function recordBinding(node: ts.Node, ctx: WalkContext): void {
  if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;

  const awaited = ts.isAwaitExpression(node.initializer);
  const initializer = awaited ? unwrapParens(node.initializer.expression) : node.initializer;
  if (!ts.isCallExpression(initializer)) return;

  const callee = calleeName(initializer.expression);
  if (!callee) return;

  (ctx.result.bindings ??= []).push({
    name: node.name.text,
    callee,
    line: lineOf(ctx, safeStart(node, ctx)),
    ...(awaited ? { awaited: true } : {}),
    ...(ctx.stack.at(-1) ? { fromQualifiedName: ctx.stack.at(-1) } : {}),
  });
}

/** Records an explicit failure site: `throw`, or a rejection the source constructs. */
function recordThrow(node: ts.Node, ctx: WalkContext): void {
  if (ts.isThrowStatement(node)) {
    (ctx.result.throws ??= []).push({
      line: lineOf(ctx, safeStart(node, ctx)),
      ...(ctx.stack.at(-1) ? { fromQualifiedName: ctx.stack.at(-1) } : {}),
      ...(node.expression ? { expression: clip(node.expression.getText(ctx.sourceFile), 120) } : {}),
      via: 'throw',
      ...(isInAsyncScope(ctx) ? { inAsyncFunction: true } : {}),
    });
    return;
  }

  // `Promise.reject(…)` and a bare `reject(…)` are failures the source states rather than
  // thrown exceptions. Both are recorded; the difference matters to a caller reading them.
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    if (name !== 'Promise.reject' && name !== 'reject') return;
    (ctx.result.throws ??= []).push({
      line: lineOf(ctx, safeStart(node, ctx)),
      ...(ctx.stack.at(-1) ? { fromQualifiedName: ctx.stack.at(-1) } : {}),
      ...(node.arguments[0] ? { expression: clip(node.arguments[0].getText(ctx.sourceFile), 120) } : {}),
      via: 'reject',
      ...(isInAsyncScope(ctx) ? { inAsyncFunction: true } : {}),
    });
  }
}

/**
 * True when any enclosing scope was declared `async`.
 *
 * A throw inside an async function becomes a rejected promise, which is a different observable
 * behaviour from a synchronous exception. Recording it separately stops a sequence view drawing
 * a synchronous error arrow for a function that can only reject.
 */
function isInAsyncScope(ctx: WalkContext): boolean {
  return ctx.stack.some((qualifiedName) =>
    ctx.result.entities.some((entity) => entity.qualifiedName === qualifiedName && entity.isAsync === true),
  );
}

function classifyReturnedExpression(expression: ts.Expression, line: number): CallResult | undefined {
  const awaitedByAwait = ts.isAwaitExpression(expression);
  const inner = awaitedByAwait ? unwrapParens(expression.expression) : expression;

  if (ts.isCallExpression(inner)) {
    return {
      kind: awaitedByAwait ? 'awaited_call' : 'call',
      ...(calleeName(inner.expression) ? { name: calleeName(inner.expression)! } : {}),
      line,
      ...(awaitedByAwait ? { awaited: true } : {}),
    };
  }
  if (ts.isNewExpression(inner)) {
    const name = calleeName(inner.expression);
    return { kind: 'constructor', ...(name ? { name } : {}), line };
  }
  if (ts.isIdentifier(inner)) return { kind: 'identifier', name: inner.text, line };
if (isLiteralExpression(inner)) return { kind: 'literal', line };
  return { kind: 'expression', line };
}

function isLiteralExpression(node: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isStringLiteralLike(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  );
}

/**
 * Recognises an HTTP response constructed in code.
 *
 * Three shapes, all read from the code itself:
 * - `res.status(201).json(order)` — a configuring call whose status travels to the producing call;
 * - `reply.send(x)` — a producing call directly;
 * - `return Response.json(data)` / `return new Response(body)` — a response returned rather than
 *   written to an object.
 *
 * Nothing is inferred from a route's name or path, so an endpoint called `/users` never gains a
 * response shape it did not write.
 */
function recordHttpResponse(node: ts.Node, ctx: WalkContext): void {
  // `new Response(body)` is a NewExpression, not a call, so a guard on `isCallExpression`
  // dropped it before the constructor check that was written to accept it (D-055).
if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return;
  const expression = node.expression;
  const callee = calleeName(expression);
  if (!callee) return;

  const method = callee.split('.').at(-1) ?? callee;
  const isCall = ts.isCallExpression(node);

  // A configuring call records its status for the producing call that is built on it.
  if (RESPONSE_CONFIGURERS.has(method) && isCall) {
    const status = literalStatusArgument(node);
    if (status !== undefined) ctx.responseStatus.set(node, status);
    // `void reply.status(404); return { error };` — Fastify's own idiom, and the one this
    // repository uses on every one of its endpoints. The configuring call produces no response
    // on its own, so it is recorded as a response *intent*: the status is stated in the code,
    // and whether a value comes back is a separate fact the return pass establishes.
    if (status !== undefined && RESPONSE_OBJECTS.has(callee.split('.')[0] ?? '')) {
      // Not a response on its own when another call is built on it: `reply.status(201).send(x)`
      // produces the response, and the producer records it with this status. The producing call
      // is visited first, so the decision is made after the walk (see
      // `resolveChainedResponseStatuses`).
      ctx.pendingStatusOnly.push({ node, status, scope: ctx.stack.at(-1) });
    }
    return;
  }

  const isMemberCall = isCall && callee.includes('.') && RESPONSE_METHODS.has(method);
  const isResponseConstructor =
    (isCall && (callee === 'Response.json' || callee === 'Response.redirect' || callee === 'NextResponse.json' || callee === 'NextResponse.redirect')) ||
    callee === 'Response';
  if (!isMemberCall && !isResponseConstructor) return;

  const line = lineOf(ctx, safeStart(node, ctx));
  const payload = node.arguments?.[0];
  const payloadShape = payload ? classifyReturnedExpression(payload, line) : undefined;
  const own = isCall ? literalStatusArgument(node) : undefined;

  // `res.status(201).json(order)`: the configuring call is the receiver of this one, and a parent
  // is walked before its children, so the status is not in the map yet. The pair is remembered
  // and resolved after the walk, which is the only point at which both calls have been seen.
  const receiver = isCall ? node.expression : undefined;
  const pendingStatus =
    receiver !== undefined && ts.isPropertyAccessExpression(receiver) && ts.isCallExpression(receiver.expression)
      ? { producer: node, configurer: receiver.expression }
      : undefined;

  (ctx.result.responses ??= []).push({
    line,
    method: isResponseConstructor ? 'Response' : method,
    ...(own ? { status: own } : {}),
    ...(payloadShape?.name ? { payload: payloadShape.name } : {}),
    ...(payloadShape ? { payloadKind: payloadShape.kind } : {}),
    ...(ctx.returnedExpressions.has(node) ? { returned: true } : {}),
  });

  if (pendingStatus) ctx.pendingResponseStatus.push(pendingStatus);

  // Emitted as a marker as well, so the graph builder can link the response to the route that
  // names this function. The marker carries the scope; the response record carries the detail.
  ctx.result.markers.push({
    name: 'http.response',
    line,
    attributes: {
      method: isResponseConstructor ? 'Response' : method,
      ...(own ? { status: own } : {}),
      ...(payloadShape?.name ? { payload: payloadShape.name } : {}),
      ...(payloadShape ? { payloadKind: payloadShape.kind } : {}),
      ...(ctx.stack.at(-1) ? { scope: ctx.stack.at(-1) } : {}),
    },
  });
}

/**
 * Applies a chained status to the response it configures.
 *
 * Run once after the walk. Doing this during the walk would miss every case, because the
 * producing call is visited before the configuring call it is built on.
 */
function resolveChainedResponseStatuses(ctx: WalkContext): void {
  if (ctx.pendingResponseStatus.length === 0 && ctx.pendingStatusOnly.length === 0) return;

  for (const { producer, configurer } of ctx.pendingResponseStatus) {
    const status = ctx.responseStatus.get(configurer);
    if (status === undefined) continue;
    const line = lineOf(ctx, safeStart(producer, ctx));
    const response = ctx.result.responses?.find((entry) => entry.line === line);
    if (response && response.status === undefined) response.status = status;
    const marker = ctx.result.markers.find((entry) => entry.name === 'http.response' && entry.line === line);
    if (marker && marker.attributes.status === undefined) marker.attributes.status = status;
  }

  // A configuring call another call is built on does not answer by itself: the producer does,
  // and it has just been given this status. Recording both would count one answer twice.
  const configurers = new Set(ctx.pendingResponseStatus.map((pair) => pair.configurer));
  for (const { node, status, scope } of ctx.pendingStatusOnly) {
    if (configurers.has(node)) continue;
    recordStatusOnlyResponse(node, status, scope, ctx);
  }
}

/**
 * Records a status the code sets on a response without producing one.
 *
 * `void reply.status(404); return { error };` is Fastify's documented way of answering, and this
 * repository uses it on all 22 endpoints. Recognising only `res.json(...)` / `reply.send(...)`
 * meant the response arrows on this repository's own API were zero — a real answer to a real
 * endpoint recorded as no answer at all, which is the failure mode Phase 4 exists to remove.
 *
 * What is claimed is narrow and stated in the record: the code sets this status. Whether a body
 * is then returned is recorded separately by the return pass, so `statusOnly` stays true and a
 * reader can tell "this endpoint sets 404 and returns a value" from "this endpoint only sets 404".
 * Nothing here is derived from the route path.
 */
function recordStatusOnlyResponse(
  node: ts.CallExpression,
  status: number,
  scope: string | undefined,
  ctx: WalkContext,
): void {
  const line = lineOf(ctx, safeStart(node, ctx));

  (ctx.result.responses ??= []).push({
    line,
    method: 'status',
    status,
    statusOnly: true,
  });

  ctx.result.markers.push({
    name: 'http.response',
    line,
    attributes: {
      method: 'status',
      status,
      statusOnly: true,
      ...(scope ? { scope } : {}),
    },
  });
}

/** Status literal from `res.status(201)`, when the code states a number. */
function literalStatusArgument(node: ts.CallExpression): number | undefined {
  const argument = node.arguments[0];
  if (!argument) return undefined;
  if (ts.isNumericLiteral(argument)) return Number(argument.text);
  if (ts.isStringLiteralLike(argument) && /^\d{3}$/.test(argument.text)) return Number(argument.text);
  return undefined;
}



function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

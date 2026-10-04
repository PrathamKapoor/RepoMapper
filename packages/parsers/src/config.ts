import type { Marker, ParsedFile } from '@repoatlas/core';
import { addProblem, emptyResult, type ParserContext, type SourceParser } from './contract.js';

/**
 * Configuration, manifest and infrastructure extractor.
 *
 * This parser turns the files that describe a system — package manifests, lockfiles,
 * container definitions, CI workflows, IaC — into `marker` facts. It reports declared
 * values only. A dependency listed in `package.json` is EXPLICIT evidence that the
 * manifest declares it; whether the code imports it is a separate question answered
 * later by the consistency engine.
 */

const PRODUCER = 'config-scanner';

export class ConfigSourceParser implements SourceParser {
  readonly producer = PRODUCER;
  readonly language = 'config';

  supports(context: ParserContext): boolean {
    return ['json', 'yaml', 'toml', 'dockerfile', 'markdown', 'sql', 'graphql', 'proto', 'unknown'].includes(
      context.language,
    );
  }

  parse(source: string, context: ParserContext): ParsedFile {
    const started = performance.now();
    const result = emptyResult(context, this.producer);

    switch (context.path) {
      case 'package.json':
        parsePackageJson(source, result, context.maxProblems);
        break;
      case 'docker-compose.yml':
      case 'docker-compose.yaml':
        parseCompose(source, result);
        break;
      case 'Dockerfile':
        parseDockerfile(source, result);
        break;
      default:
        if (/^Dockerfile\./.test(context.path)) parseDockerfile(source, result);
        else if (context.language === 'json') parseGenericJson(source, result);
        else if (context.language === 'sql') parseSql(source, result);
        else if (context.language === 'yaml') parseYaml(source, result);
        else if (context.language === 'markdown') parseMarkdown(source, result);
        break;
    }

    result.durationMs = Math.round(performance.now() - started);
    return result;
  }
}

/** Reads declared dependencies and scripts from an npm manifest. */
function parsePackageJson(source: string, result: ParsedFile, maxProblems: number): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(stripJsonComments(source));
  } catch (error) {
    addProblem(
      result,
      {
        message: `package.json is not valid JSON: ${(error as Error).message}`,
        line: 1,
        code: 'CONFIG_INVALID_JSON',
      },
      maxProblems,
    );
    return;
  }

  if (typeof manifest !== 'object' || manifest === null) return;
  const record = manifest as Record<string, unknown>;

  const name = typeof record.name === 'string' ? record.name : undefined;
  if (name) {
    result.markers.push({
      name: 'manifest.name',
      line: lineOfKey(source, '"name"'),
      attributes: { name, version: typeof record.version === 'string' ? record.version : null },
    });
  }

  const dependencySections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ] as const;

  for (const section of dependencySections) {
    const deps = record[section];
    if (typeof deps !== 'object' || deps === null) continue;
    for (const [dependency, range] of Object.entries(deps as Record<string, unknown>)) {
      result.markers.push({
        name: 'manifest.dependency',
        line: lineOfKey(source, `"${dependency}"`),
        attributes: {
          dependency,
          section,
          range: typeof range === 'string' ? range : null,
        },
      });
    }
  }

  const scripts = record.scripts;
  if (typeof scripts === 'object' && scripts !== null) {
    for (const [scriptName, command] of Object.entries(scripts as Record<string, unknown>)) {
      if (typeof command !== 'string') continue;
      result.markers.push({
        name: 'manifest.script',
        line: lineOfKey(source, `"${scriptName}"`),
        attributes: { script: scriptName, command },
      });
    }
  }

  // Declared entry points and workspace layout are strong evidence for module structure.
  for (const field of ['main', 'module', 'types', 'browser', 'bin'] as const) {
    const value = record[field];
    if (typeof value === 'string') {
      result.markers.push({ name: 'manifest.entrypoint', line: lineOfKey(source, `"${field}"`), attributes: { field, value } });
    }
  }

  const workspaces = record.workspaces;
  if (Array.isArray(workspaces)) {
    result.markers.push({
      name: 'manifest.workspaces',
      line: lineOfKey(source, '"workspaces"'),
      attributes: { patterns: workspaces.filter((item): item is string => typeof item === 'string').join(',') },
    });
  }
}

/**
 * Reads service names, images, build contexts and declared ports from a compose file.
 *
 * Scoped to the `services:` block on purpose. A compose file also declares top-level
 * `volumes:`, `networks:`, `configs:` and `secrets:` whose entries have the same
 * two-space indentation as a service, so a pattern that matched "any indented name" reported
 * a named volume as a deployable unit — a container in the architecture view that cannot run.
 *
 * `build:` is accepted in both forms: the short scalar (`build: ./api`) and the long mapping
 * (`build:\n  context: ./api`), the latter being what Compose writes by default.
 */
function parseCompose(source: string, result: ParsedFile): void {
  const lines = source.split(/\r?\n/);
  let inServices = false;
  let serviceIndent = -1;
  let current: { service: string; line: number; body: string[] } | null = null;
  const services: { service: string; line: number; body: string[] }[] = [];

  for (const [index, line] of lines.entries()) {
    // A top-level key ends the services block. Comments and blank lines do not.
    const topLevel = /^([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (topLevel && line.length > 0 && !/^\s/.test(line)) {
      inServices = topLevel[1] === 'services';
      serviceIndent = -1;
      if (current) {
        services.push(current);
        current = null;
      }
      continue;
    }
    if (!inServices || /^\s*#/.test(line)) continue;

    if (serviceIndent < 0) {
      // First indented name inside `services:` fixes the indentation services are written at.
      const header = /^(\s+)([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
      if (!header?.[1]) continue;
      serviceIndent = header[1].length;
    }

    const name = new RegExp(`^\\s{${serviceIndent}}([A-Za-z0-9_.-]+):\\s*(#.*)?$`).exec(line);
    if (name?.[1]) {
      if (current) services.push(current);
      current = { service: name[1], line: index + 1, body: [] };
      continue;
    }
    current?.body.push(line);
  }
  if (current) services.push(current);

  for (const service of services) {
    const block = service.body.join('\n');
    const image = /^\s+image:\s*(\S+)/m.exec(block)?.[1] ?? null;
    const build = buildContextOf(block);
    const ports = [...block.matchAll(/^\s+-\s+["']?(\d+[:/]?\d*)["']?/gm)].map((entry) => entry[1] ?? '');
    result.markers.push({
      name: 'compose.service',
      line: service.line,
      attributes: {
        service: service.service,
        image,
        build,
        publishedPorts: ports.filter((port) => port.length > 0).join(','),
      },
    });
  }
}

/**
 * The build context of a service, from either supported `build:` form.
 *
 * `build: ./api` is a scalar. `build:\n  context: ./api` is a mapping. Returns `null` for a
 * mapping with no `context:` (the Dockerfile then sits beside the compose file) and for a
 * scalar that is not a path, which is then not a path this analysis can reason about.
 */
function buildContextOf(block: string): string | null {
  const scalar = /^\s+build:\s*(\S+)\s*$/m.exec(block)?.[1];
  if (scalar) return scalar;
  const mapping = /^\s+build:\s*$/m.exec(block);
  if (!mapping) return null;
  const tail = block.slice(mapping.index + mapping[0].length);
  const context = /^\s+context:\s*(\S+)\s*$/m.exec(tail)?.[1];
  return context ?? null;
}

/** Reads the base image and exposed ports from a Dockerfile. */
function parseDockerfile(source: string, result: ParsedFile): void {
  const stages: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    const base = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(trimmed);
    if (base) {
      stages.push(base[2] ?? 'default');
      result.markers.push({
        name: 'docker.base_image',
        line: lineOfIndex(source, source.indexOf(line)),
        attributes: { image: base[1] ?? '', stage: base[2] ?? 'default' },
      });
      continue;
    }
    const exposed = /^EXPOSE\s+(.+)/i.exec(trimmed);
    if (exposed) {
      result.markers.push({
        name: 'docker.expose',
        line: lineOfIndex(source, source.indexOf(line)),
        attributes: { ports: (exposed[1] ?? '').trim() },
      });
    }
  }
  if (stages.length > 0) {
    result.markers.push({
      name: 'docker.build_stage',
      line: 1,
      attributes: { stageCount: stages.length, stages: stages.join(',') },
    });
  }
}

/**
 * Minimal YAML scan for top-level and one-level-nested keys.
 *
 * A general YAML parser is deliberately not used here: it would add a dependency for
 * the handful of keys that matter, and CI/IaC files are the least trustworthy input
 * in a repository. Key names and scalar values are read; anchors, tags and complex
 * structures are ignored rather than misinterpreted.
 */
function parseYaml(source: string, result: ParsedFile): void {
  const lines = source.split(/\r?\n/);
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const topLevel = /^([A-Za-z_][\w.-]*):\s*(.*)$/.exec(raw);
    if (topLevel?.[1]) {
      section = topLevel[1];
      if (topLevel[2]) {
        result.markers.push({
          name: 'config.key',
          line: index + 1,
          attributes: { key: section, value: topLevel[2].trim(), depth: 0 },
        });
      }
      continue;
    }

    const nested = /^ {2,}([A-Za-z_][\w.-]*):\s*(.+)$/.exec(raw);
    if (nested?.[1] && nested[2] && section) {
      result.markers.push({
        name: 'config.key',
        line: index + 1,
        attributes: { key: `${section}.${nested[1]}`, value: nested[2].trim(), depth: 1 },
      });
    }
  }
}

/** Reads top-level keys from JSON files that are not manifests (tsconfig, openapi). */
function parseGenericJson(source: string, result: ParsedFile): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(source));
  } catch {
    // JSONC files legitimately contain comments and trailing commas; not an error.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // Nested objects are skipped: this scanner reports declared scalars, not the whole
    // document tree. Stringifying an object would yield "[object Object]".
    if (typeof value === 'object' && value !== null) continue;
    result.markers.push({
      name: 'config.key',
      line: lineOfKey(source, `"${key}"`),
      attributes: { key, value: scalarToString(value), depth: 0 },
    });
  }
}

/** Renders a JSON scalar for a marker attribute without producing "[object Object]". */
function scalarToString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Reads stated requirements from Markdown.
 *
 * Only a line that *declares* a requirement is read. Recognised forms:
 *
 * - `REQ-012: The system shall ...` — an explicit identifier and a statement;
 * - a list item whose text begins with a requirement verb: `must`, `shall`, `should`,
 *   `is required to`, `has to`, `needs to`, `must not`, `may not`.
 *
 * Prose that merely describes the system is not read. This is the line between recovering what
 * a repository states and writing requirements on its behalf, and the second is not this tool's
 * job. A bullet in a changelog saying "must fix the parser" is a requirement in form only; it
 * is still recorded, because deciding it is not a requirement would be a judgement the
 * repository never made. What is *not* done is inferring a requirement from a sentence that
 * makes no claim of obligation.
 *
 * `implementsRef` is captured from a trailing path or backticked symbol on the same line, so
 * the graph can link the requirement to code that names it. Absence is left as absence: no
 * reference means no `implements_requirement` relationship.
 */
function parseMarkdown(source: string, result: ParsedFile): void {
  const lines = source.split(/\r?\n/);
  let inFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    // A requirement inside a code block is an example, not a statement.
    if (inFence) continue;

    const lineNumber = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('|')) continue;

    const bullet = trimmed.startsWith('-') || trimmed.startsWith('*') || /^\d+\./.test(trimmed);
    const text = bullet ? trimmed.replace(/^(?:[-*]|\d+\.)\s+/, '') : trimmed;
    if (text === '') continue;

    const identified = /^([A-Z][A-Z0-9]*-\d+)\s*[:.—-]\s*(.+)$/.exec(text);
    const obligation = /\b(must not|shall not|may not|must|shall|should|is required to|has to|needs to)\b/i;
    const sentence = identified?.[2]?.trim() ?? text;
    if (!identified && !obligation.test(sentence)) continue;

    const { statement, implementsRef } = splitImplementsRef(sentence);
    if (statement.length === 0) continue;

    result.markers.push({
      name: 'doc.requirement',
      line: lineNumber,
      attributes: {
        statement,
        identifier: identified?.[1] ?? null,
        ...(implementsRef ? { implementsRef } : {}),
      },
    });
  }
}

/**
 * Separates a requirement's statement from a trailing implementation reference.
 *
 * Only two unambiguous forms are honoured: a path (`src/routes.ts`) and a backticked symbol.
 * Anything else is left inside the statement, because splitting prose on a guess would change
 * what the repository said.
 */
function splitImplementsRef(sentence: string): { statement: string; implementsRef: string | null } {
  const backticked = /`([^`]+)`\s*$/.exec(sentence);
  if (backticked?.[1]) {
    return { statement: sentence.slice(0, backticked.index).trim(), implementsRef: backticked[1] };
  }

  const path = /((?:^|\s)(?:[\w.-]+\/)*[\w.-]+\.[a-z]{1,5})\s*$/.exec(sentence);
  if (path?.[1]) {
    const reference = path[1].trim();
    return { statement: sentence.slice(0, path.index).trim(), implementsRef: reference };
  }

  return { statement: sentence, implementsRef: null };
}

/**
 * Reads `CREATE TABLE` statements so the ER projection has a source of truth.
 *
 * Beyond names and types, this records what the DDL actually constrains: primary keys,
 * foreign-key targets, nullability and uniqueness. Those are the facts that turn a list of
 * columns into a schema. They are read from the statement rather than inferred from column
 * names, because a column called `report_id` is not a foreign key unless the DDL says so.
 */
function parseSql(source: string, result: ParsedFile): void {
  const tableMarkers: Marker[] = [];
  const columnMarkers: Marker[] = [];
  const foreignKeyMarkers: Marker[] = [];
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(source)) !== null) {
    const table = match[1];
    if (!table) continue;
    const tableLine = lineOfIndex(source, match.index);

    // Column-level constraints, collected before the columns so each column marker can carry
    // them. A table-level `PRIMARY KEY (a, b)` is folded in afterwards.
    const inline = new Map<string, { primaryKey: boolean; notNull: boolean; unique: boolean; references?: string }>();
    const tablePrimaryKey: string[] = [];
    const columns: string[] = [];

    for (const raw of splitTopLevel(match[2] ?? '')) {
      const column = raw.trim();
      if (column.length === 0) continue;

      const reference = /\bREFERENCES\s+["'`]?([\w.]+)["'`]?(?:\s*\(\s*["'`]?(\w+)["'`]?\s*\))?/i.exec(column);
      if (reference?.[1]) {
        // Recorded as its own relationship rather than as a column attribute, so the ER
        // projection can draw the relationship and the consistency engine can check it.
        foreignKeyMarkers.push({
          name: 'schema.foreign_key',
          line: tableLine,
          attributes: {
            table,
            column: (columnName(column) ?? '').length > 0 ? columnName(column)! : '',
            referencesTable: reference[1],
            ...(reference[2] ? { referencesColumn: reference[2] } : {}),
          },
        });
      }

      if (/^PRIMARY\s+KEY\b/i.test(column)) {
        tablePrimaryKey.push(...(columnNameList(column, 'PRIMARY\\s+KEY') ?? []));
        continue;
      }
      if (/^FOREIGN\s+KEY\b/i.test(column)) {
        const names = columnNameList(column, 'FOREIGN\\s+KEY') ?? [];
        const target = /\bREFERENCES\s+["'`]?([\w.]+)["'`]?/i.exec(column)?.[1];
        if (target) {
          for (const name of names) {
            foreignKeyMarkers.push({
              name: 'schema.foreign_key',
              line: tableLine,
              attributes: { table, column: name, referencesTable: target },
            });
          }
        }
        continue;
      }
      if (/^(UNIQUE|KEY|INDEX|CONSTRAINT|CHECK)\b/i.test(column)) continue;

      const name = columnName(column);
      if (!name) continue;
      const body = column.slice(name.length);
      inline.set(name, {
        primaryKey: /\bPRIMARY\s+KEY\b/i.test(body),
        notNull: /\bNOT\s+NULL\b/i.test(body),
        unique: /\bUNIQUE\b/i.test(body),
        ...(reference?.[1] ? { references: reference[1] } : {}),
      });
      columns.push(name);
    }

    for (const name of columns) {
      const flags = inline.get(name) ?? { primaryKey: false, notNull: false, unique: false };
      const isPrimary = flags.primaryKey || tablePrimaryKey.includes(name);
      columnMarkers.push({
        name: 'schema.column',
        line: tableLine,
        attributes: {
          table,
          column: name,
          dataType: typeOf(columnDefinition(source, table, name)) ?? null,
          // A primary key is always NOT NULL, whatever the DDL says or omits.
          primaryKey: isPrimary,
          notNull: flags.notNull || isPrimary,
          unique: flags.unique,
          ...(flags.references ? { referencesTable: flags.references } : {}),
        },
      });
    }

    // The table marker is emitted before its columns so the graph builder can attach
    // columns to a table that already exists. Emitting it last silently dropped every
    // column, because a column with no owning table is not representable.
    tableMarkers.push({
      name: 'schema.table',
      line: tableLine,
      attributes: {
        table,
        columnCount: columns.length,
        primaryKey: tablePrimaryKey.join(','),
      },
    });
  }

  result.markers.push(...tableMarkers, ...columnMarkers, ...foreignKeyMarkers);
}

/** The identifier at the start of a column or constraint definition, unquoted. */
function columnName(definition: string): string | undefined {
  return /^["'`]?([A-Za-z_]\w*)["'`]?/.exec(definition.trim())?.[1];
}

/** The parenthesised column list of a table-level constraint, e.g. `PRIMARY KEY (a, b)`. */
function columnNameList(definition: string, keyword: string): string[] | undefined {
  const list = new RegExp(`${keyword}\\s*\\(([^)]*)\\)`, 'i').exec(definition)?.[1];
  if (!list) return undefined;
  const names = list
    .split(',')
    .map((entry) => columnName(entry))
    .filter((name): name is string => Boolean(name));
  return names.length > 0 ? names : undefined;
}

/** The declared type of a column, found by locating its definition in the source. */
function columnDefinition(source: string, table: string, column: string): string | undefined {
  const pattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${table}["'\`]?\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i');
  const body = pattern.exec(source)?.[1];
  if (!body) return undefined;
  for (const raw of splitTopLevel(body)) {
    const definition = raw.trim();
    if (columnName(definition) === column) return definition;
  }
  return undefined;
}

function typeOf(definition: string | undefined): string | undefined {
  if (!definition) return undefined;
  const name = columnName(definition);
  if (!name) return undefined;
  const type = /\b(\w+(?:\s+\w+)*)\s*(?:\([^)]*\))?\s*(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY|UNIQUE|$)/i.exec(
    definition.slice(name.length),
  )?.[1];
  return type?.trim();
}

/** Strips `//` and `/* *\/` comments and trailing commas so JSONC parses as JSON. */
export function stripJsonComments(source: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        const escaped = source[i + 1];
        if (escaped !== undefined) {
          out += escaped;
          i += 1;
        }
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }

  // Remove trailing commas before `}` or `]`.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function lineOfIndex(source: string, index: number): number {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function lineOfKey(source: string, key: string): number {
  const index = source.indexOf(key);
  return index < 0 ? 1 : lineOfIndex(source, index);
}

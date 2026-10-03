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

/** Reads service names and declared ports from a compose file. */
function parseCompose(source: string, result: ParsedFile): void {
  const servicePattern = /^ {2}([A-Za-z0-9_.-]+):\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = servicePattern.exec(source)) !== null) {
    const service = match[1];
    if (!service) continue;
    const block = sliceBlock(source, match.index + match[0].length);
    const image = /^\s+image:\s*(\S+)/m.exec(block)?.[1];
    const build = /^\s+build:\s*(\S+)/m.exec(block)?.[1];
    const ports = [...block.matchAll(/^\s+-\s+["']?(\d+[:/]?\d*)["']?/gm)].map((entry) => entry[1] ?? '');
    result.markers.push({
      name: 'compose.service',
      line: lineOfIndex(source, match.index),
      attributes: {
        service,
        image: image ?? null,
        build: build ?? null,
        publishedPorts: ports.filter((port) => port.length > 0).join(','),
      },
    });
  }
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

/** Reads `CREATE TABLE` statements so ER projection has a source of truth. */
function parseSql(source: string, result: ParsedFile): void {
  const tableMarkers: Marker[] = [];
  const columnMarkers: Marker[] = [];
  const tablePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w.]+)["'`]?\s*\(([\s\S]*?)\)\s*;/gi;
  let match: RegExpExecArray | null;
  while ((match = tablePattern.exec(source)) !== null) {
    const table = match[1];
    if (!table) continue;

    const columns: string[] = [];
    for (const raw of splitTopLevel(match[2] ?? '')) {
      const column = raw.trim();
      if (column.length === 0) continue;
      if (/^(PRIMARY|FOREIGN|UNIQUE|KEY|CONSTRAINT|INDEX|CHECK)\b/i.test(column)) continue;
      const name = /^["'`]?([\w]+)["'`]?/.exec(column)?.[1];
      if (!name) continue;
      const type = /\b(\w+(?:\s+\w+)*)\s*(?:\([^)]*\))?\s*(?:NOT\s+NULL|NULL|DEFAULT|$)/i.exec(column.slice(name.length))?.[1];
      columns.push(name);
      columnMarkers.push({
        name: 'schema.column',
        line: lineOfIndex(source, match.index),
        attributes: { table, column: name, dataType: type?.trim() ?? null },
      });
    }

    // The table marker is emitted before its columns so the graph builder can attach
    // columns to a table that already exists. Emitting it last silently dropped every
    // column, because a column with no owning table is not representable.
    tableMarkers.push({
      name: 'schema.table',
      line: lineOfIndex(source, match.index),
      attributes: { table, columnCount: columns.length },
    });
  }

  result.markers.push(...tableMarkers, ...columnMarkers);
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

function sliceBlock(source: string, fromIndex: number): string {
  const nextService = /^ {2}[A-Za-z0-9_.-]+:\s*$/m.exec(source.slice(fromIndex));
  if (!nextService) return source.slice(fromIndex);
  return source.slice(fromIndex, fromIndex + nextService.index);
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

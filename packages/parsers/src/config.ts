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
      case 'Dockerfile':
        parseDockerfile(source, result);
        break;
      default:
        // Suffixed compose files are how multi-environment stacks are written in practice
        // (`docker-compose.prod.yml`), and matching only the two canonical names silently
        // reported nothing for them.
        if (/^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)?\.ya?ml$/.test(context.path)) {
          parseCompose(source, result);
        } else if (/^Dockerfile\./.test(context.path)) parseDockerfile(source, result);
        else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(context.path)) parseWorkflow(source, result);
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

  const topLevelNetworks = listTopLevelKeys(source, 'networks');

  for (const service of services) {
    const block = service.body.join('\n');
    const image = /^\s+image:\s*(\S+)/m.exec(block)?.[1] ?? null;
    const build = buildContextOf(block);
    const ports = containerPortsOf(block);
    const buildFile = buildFileOf(block);
    result.markers.push({
      name: 'compose.service',
      line: service.line,
      attributes: {
        service: service.service,
        image,
        build,
        // Container ports, which is what the image has to listen on. The host side of a
        // published port is the operator's choice and says nothing about the image.
        publishedPorts: ports.join(','),
        // Phase 6. Both are recorded so identity and reconciliation do not depend on where the
        // service happens to sit in the file. A service's identity is its name; its declaring
        // file is provenance, not identity (D-078).
        ...(buildFile ? { buildFile } : {}),
      },
    });

    // Phase 6: published ports keep the host side.
    //
    // Phase 5 kept only the container port, which was the right call for "what must the image
    // listen on". It is the wrong answer to "what does this deployment expose", because
    // `127.0.0.1:4300:4300` and `0.0.0.0:4300:4300` expose the same container port to
    // *different* audiences, and Phase 6's security view has to be able to say which. The host
    // side is recorded as a declaration about reachability scope — never as a fact that anything
    // is reachable.
    for (const published of publishedPortsOf(block)) {
      result.markers.push({
        name: 'compose.port_publish',
        line: service.line,
        attributes: {
          service: service.service,
          containerPort: published.containerPort,
          ...(published.hostPort ? { hostPort: published.hostPort } : {}),
          ...(published.hostIp ? { hostIp: published.hostIp } : {}),
          ...(published.protocol ? { protocol: published.protocol } : {}),
        },
      });
    }

    // Phase 6: a command the service overrides. `command:` in compose replaces the image's CMD,
    // which means a Dockerfile CMD is *not* necessarily what runs (D-079).
    const command = commandOf(block);
    if (command) {
      result.markers.push({
        name: 'compose.command',
        line: lineOfKey(source, 'command'),
        attributes: { service: service.service, value: command },
      });
    }

    // Phase 5. Each of the following is a *declaration* read from this service's own block.
    // Nothing here is inferred from the fact that another service exists: a service that shares
    // no network key with `db` is not recorded as reaching it, because the compose file does not
    // say that it does (D-072).
    for (const dependency of declaredDependencies(block)) {
      result.markers.push({
        name: 'compose.depends_on',
        line: lineOfKey(source, dependency),
        attributes: { service: service.service, dependsOn: dependency },
      });
    }

    for (const network of declaredNetworks(block, topLevelNetworks)) {
      result.markers.push({
        name: 'compose.network',
        line: service.line,
        attributes: { service: service.service, network },
      });
    }

    for (const variable of environmentReferences(block)) {
      result.markers.push({
        name: 'compose.environment',
        line: service.line,
        attributes: { service: service.service, variable },
      });
    }

    // Phase 6. A service-address reference: `http://api:3000` inside this service's own
    // configuration.
    //
    // This is the strongest service-to-service evidence a repository can state. It is still not
    // a connection: it says the service is *configured to address* another service by the name
    // compose gives it. Whether that address resolves, and whether a request succeeds, are
    // runtime facts (D-083). The value is read only for the host and port, and the variable name
    // travels with it so the reader can see which setting carries the address.
    for (const address of serviceAddressesOf(block)) {
      result.markers.push({
        name: 'compose.service_address',
        line: lineOfKey(source, address.variable),
        attributes: {
          service: service.service,
          target: address.target,
          port: address.port,
          variable: address.variable,
        },
      });
    }

    for (const mount of declaredVolumeMounts(block)) {
      result.markers.push({
        name: 'compose.volume_mount',
        line: lineOfKey(source, mount.volume),
        attributes: {
          service: service.service,
          volume: mount.volume,
          ...(mount.target ? { target: mount.target } : {}),
          ...(mount.readOnly ? { readOnly: 'true' } : {}),
          ...(mount.source ? { source: mount.source } : {}),
        },
      });
    }

    // Phase 6: a healthcheck records the *target* as well as its existence.
    //
    // `healthcheck: test: ["CMD", "curl", "-f", "http://localhost/api/health"]` names an
    // endpoint. That is enough to check the endpoint exists in the application graph — and it is
    // emphatically not enough to say the check passes (D-084).
    const healthcheck = healthcheckOf(block);
    if (healthcheck) {
      result.markers.push({
        name: 'compose.healthcheck',
        line: service.line,
        attributes: {
          service: service.service,
          ...(healthcheck.kind ? { kind: healthcheck.kind } : {}),
          ...(healthcheck.command ? { command: healthcheck.command } : {}),
          ...(healthcheck.endpoint ? { endpoint: healthcheck.endpoint } : {}),
        },
      });
    }

    const restart = /^\s+restart:\s*(\S+)/m.exec(block)?.[1] ?? null;
    if (restart) {
      result.markers.push({
        name: 'compose.restart_policy',
        line: lineOfKey(source, 'restart'),
        attributes: { service: service.service, restart },
      });
    }
  }

for (const network of topLevelNetworks) {
      result.markers.push({
        name: 'compose.network_declared',
        line: lineOfKey(source, network),
        attributes: { network },
      });
    }

    // Phase 6. A declared volume is a resource a service is given, not a unit that runs.
    //
    // Reporting named volumes as services produced containers in the architecture view that
    // could not start (D-039), so `listTopLevelKeys('volumes')` was never read. It is read now,
    // into its own node kind, so a mount has both endpoints: the service and the volume.
    for (const volume of listTopLevelKeys(source, 'volumes')) {
      result.markers.push({
        name: 'compose.volume_declared',
        line: lineOfKey(source, volume),
        attributes: { volume },
      });
    }
}

/**
 * The container ports a service's `ports:` block declares.
 *
 * Compose writes a published port as `[host_ip:]host_port:container_port[/protocol]`, so the
 * container port — the one the image must listen on — is the **last** numeric segment. Reading
 * the first segment reported `127` for `127.0.0.1:8080:8080`, which is an IP fragment rather than
 * a port (D-075).
 *
 * Only the port is kept. `127.0.0.1:8080:8080` says a port is published on the loopback
 * interface; whether anything is listening, and from where, is not established by the file.
 */
/**
 * Every published port, with the host side intact.
 *
 * Phase 6 split this from `containerPortsOf` because the two questions have different answers.
 * "What must the image listen on" is the container port. "What does this deployment expose" needs
 * the host binding too: `127.0.0.1:4300:4300` publishes to the loopback interface and
 * `4300:4300` publishes on every interface, and those are materially different exposures. Neither
 * says anything is *reachable* — only that the compose file asks for the binding.
 */
function publishedPortsOf(block: string): {
  containerPort: string;
  hostPort?: string;
  hostIp?: string;
  protocol?: string;
}[] {
  const found: { containerPort: string; hostPort?: string; hostIp?: string; protocol?: string }[] = [];
  const seen = new Set<string>();

  for (const candidate of portCandidates(block)) {
    const [spec, protocol] = candidate.split('/');
    const segments = (spec ?? '').split(':');
    const containerPort = segments.at(-1) ?? '';
    if (!/^\d+(?:-\d+)?$/.test(containerPort)) continue;

    // `[host_ip:][host_port]:container_port[/protocol]` — the container port is always last.
    const hostPort = segments.length >= 2 && /^\d+(?:-\d+)?$/.test(segments[segments.length - 2] ?? '')
      ? segments[segments.length - 2]
      : undefined;
    const hostIp = segments.length >= 3 ? segments[0] : undefined;

    const key = `${hostIp ?? ''}:${hostPort ?? ''}:${containerPort}/${protocol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      containerPort,
      ...(hostPort ? { hostPort } : {}),
      ...(hostIp ? { hostIp } : {}),
      ...(protocol ? { protocol } : {}),
    });
  }
  return found.sort((a, b) => `${a.hostIp ?? ''}${a.hostPort ?? ''}${a.containerPort}`.localeCompare(`${b.hostIp ?? ''}${b.hostPort ?? ''}${b.containerPort}`));
}

/** The raw port specifications written in a service's `ports:` block, list or inline form. */
function portCandidates(block: string): string[] {
  const candidates: string[] = [];
  const inline = /^\s+ports:\s*\[([^\]]*)\]/m.exec(block)?.[1];
  if (inline) {
    for (const part of inline.split(',')) candidates.push(unquote(part));
  }

  const list = /^\s+ports:\s*$/m.exec(block);
  if (list) {
    const tail = block.slice((list.index ?? 0) + list[0].length);
    for (const line of tail.split('\n')) {
      const item = /^\s+-\s+(.+)$/.exec(line);
      if (!item?.[1]) {
        if (line.trim().length > 0) break;
        continue;
      }
      candidates.push(unquote(item[1]));
    }
  }
  return candidates;
}

function unquote(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

function containerPortsOf(block: string): string[] {
  const found = new Set<string>();
  for (const candidate of portCandidates(block)) {
    const withoutProtocol = candidate.split('/')[0] ?? '';
    const segments = withoutProtocol.split(':');
    const container = segments.at(-1) ?? '';
    // A range (`8000-9000:80`) expands, because the image listens on all of it.
    if (/^\d+-\d+$/.test(container)) {
      const [from, to] = container.split('-').map(Number);
      if (from !== undefined && to !== undefined && to >= from && to - from <= 64) {
        for (let port = from; port <= to; port += 1) found.add(String(port));
      }
      continue;
    }
    if (/^\d+$/.test(container)) found.add(container);
  }
  return [...found].sort((a, b) => Number(a) - Number(b));
}

/**
 * The top-level keys of one compose section, at the same indentation services are written at.
 *
 * `volumes:` and `networks:` hold named entries at the same indentation as `services:`, which is
 * why the Phase 3 parser scoped itself to the `services:` block. Reading them here is safe
 * because each entry is attributed to the section it was found in, and a named volume is not
 * turned into a service or a container (D-039).
 */
function listTopLevelKeys(source: string, section: string): string[] {
  const lines = source.split(/\r?\n/);
  const found: string[] = [];
  let inSection = false;
  let indent = -1;

  for (const line of lines) {
    const topLevel = /^([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (topLevel && !/^\s/.test(line)) {
      inSection = topLevel[1] === section;
      indent = -1;
      continue;
    }
    if (!inSection || /^\s*#/.test(line)) continue;
    if (indent < 0) {
      const header = /^(\s+)([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
      if (!header?.[1]) continue;
      indent = header[1].length;
    }
    const entry = new RegExp(`^\\s{${indent}}([A-Za-z0-9_.-]+):\\s*(#.*)?$`).exec(line);
    if (entry?.[1]) found.push(entry[1]);
  }
  return found;
}

/**
 * Services named in `depends_on`, from either supported form.
 *
 * The list form (`depends_on: [db, cache]`) and the mapping form
 * (`depends_on:\n  db:\n    condition: service_healthy`) both occur, and the mapping form also
 * carries a `condition` worth recording because "waits until healthy" is a stronger statement
 * than "starts first".
 */
function declaredDependencies(block: string): string[] {
  const found = new Set<string>();
  const inline = /^\s+depends_on:\s*\[([^\]]*)\]/m.exec(block)?.[1];
  if (inline) {
    for (const part of inline.split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '');
      if (name.length > 0) found.add(name);
    }
  }

  const mapping = /^\s+depends_on:\s*$/m.exec(block);
  if (mapping) {
    for (const name of blockEntriesAfter(block, mapping)) found.add(name);
  }
  return [...found];
}

/**
 * The names written under a `key:` line that opens a nested block, until the indentation drops.
 *
 * Both spellings a compose file uses for a dependency or a network are read: `db:` (a mapping
 * entry, which may carry a `condition:` beneath it) and a bare `db` or `- db` (a list entry).
 * Reading only the mapping form silently dropped every dependency written as a list, which is
 * the more common of the two for `networks:` (D-076).
 *
 * Stops at the first line that is less indented than the entries, or at a line that is neither a
 * name nor a continuation of the entry above it — so a following `restart:` key ends the block
 * rather than being read as a dependency called `restart`.
 */
function blockEntriesAfter(block: string, opener: RegExpExecArray): string[] {
  const tail = block.slice((opener.index ?? 0) + opener[0].length);
  const names: string[] = [];
  let indent = -1;

  for (const line of tail.split('\n')) {
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;

    const leading = /^\s*/.exec(line)?.[0].length ?? 0;
    if (indent < 0) {
      if (leading === 0) break;
      indent = leading;
    }
    if (leading < indent) break;

    const listEntry = /^\s*-\s*([A-Za-z0-9_.-]+)\s*:?\s*(#.*)?$/.exec(line);
    if (listEntry?.[1]) {
      names.push(listEntry[1]);
      continue;
    }
    const mappingEntry = /^\s*([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (mappingEntry?.[1]) {
      names.push(mappingEntry[1]);
      continue;
    }
    // A bare name with neither colon nor dash. Strictly this is not valid YAML for these keys,
    // but it appears in hand-written files often enough that refusing it loses real
    // dependencies, and within a block whose indentation is already fixed a bare token is
    // unambiguous.
    const bare = /^\s*([A-Za-z0-9_.-]+)\s*(#.*)?$/.exec(line);
    if (bare?.[1] && !/^(true|false|null|yes|no|on|off)$/i.test(bare[1])) {
      names.push(bare[1]);
      continue;
    }
    // Deeper than an entry: a `condition:` beneath `db:`. Not a name of its own.
    if (leading > indent) continue;
    break;
  }
  return names;
}

/**
 * Networks a service joins, from either supported form.
 *
 * `networks: [front]` and `networks:\n  front:\n    aliases: [web]` both occur. The short
 * `default` network every compose project creates is not added: it is implicit rather than
 * written, and a network nothing declares is not evidence of a boundary.
 */
function declaredNetworks(block: string, topLevel: readonly string[]): string[] {
  const found = new Set<string>();
  const inline = /^\s+networks:\s*\[([^\]]*)\]/m.exec(block)?.[1];
  if (inline) {
    for (const part of inline.split(',')) {
      const name = part.trim().replace(/^["']|["']$/g, '');
      if (name.length > 0) found.add(name);
    }
  }

  const mapping = /^\s+networks:\s*$/m.exec(block);
  if (mapping) {
    for (const name of blockEntriesAfter(block, mapping)) found.add(name);
  }

  // A network is only recorded when the compose file declares it at the top level. An inline
  // name that exists nowhere else is a reference to something this file does not define, and
  // reporting it as a joined network would draw a boundary the file never describes.
  return [...found].filter((name) => topLevel.includes(name));
}

/**
 * Configuration a service receives, by *name*.
 *
 * Only the variable name is read. `- DATABASE_URL=postgres://user:pw@host/db` yields
 * `DATABASE_URL`; the value never enters the marker, so it cannot reach the graph, the API, the
 * UI or a snapshot (D-074). `- DATABASE_URL` with no `=` is a pass-through reference and is read
 * the same way.
 */
function environmentReferences(block: string): string[] {
  const found = new Set<string>();
  const section = /^\s+environment:\s*$/m.exec(block);
  if (!section) return [];
  const tail = block.slice((section.index ?? 0) + section[0].length);

  for (const line of tail.split('\n')) {
    if (/^\s+[A-Za-z0-9_.-]+:\s*/.test(line) && /^\s{2,}[A-Za-z0-9_.-]+:\s*$/.test(line)) break;
    const listItem = /^\s+-\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(=.*)?$/.exec(line);
    if (listItem?.[1]) {
      found.add(listItem[1]);
      continue;
    }
    // `KEY: value` mapping form. The value is deliberately discarded.
    const mapping = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (mapping?.[1]) {
      found.add(mapping[1]);
      continue;
    }
    if (line.trim().length > 0 && /^\s+[A-Za-z0-9_.-]+:/.test(line)) break;
  }
  return [...found];
}

/**
 * A service-address reference inside a service's configuration.
 *
 * Reads `http://api:3000` out of a declared environment value and reports the host (`api`) and
 * port as a reference to *another service*. This is the strongest service-to-service evidence a
 * repository can state, and it is still not a connection: a compose file can name a service that
 * does not exist, and whether the address resolves or a request succeeds are runtime facts
 * (D-083).
 *
 * The value is never recorded on the marker, for the same reason no other environment value is
 * (D-070) — a URL can carry a token in its userinfo or query string. Only the host, the port and
 * the variable name travel, which is enough to ask "which setting addresses which service".
 */
function serviceAddressesOf(block: string): { variable: string; target: string; port: string }[] {
  const found: { variable: string; target: string; port: string }[] = [];

  const record = (rawVariable: string, rawValue: string): void => {
    const variable = rawVariable.trim();
    const url = /https?:\/\/([^\s/@:'"]+)(?::(\d+))?/.exec(rawValue);
    const host = url?.[1];
    if (!host) return;

    // Only a name-shaped host counts. An IP address, `localhost`, or anything with credentials
    // in it is not a compose service reference, and treating it as one would invent a dependency
    // on a service no file names.
    if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(host)) return;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return;
    if (host === 'localhost') return;
    if (host.includes('%40') || rawValue.includes('@', url.index)) return;

    found.push({ variable, target: host, port: url[2] ?? '' });
  };

  const inline = /^\s+environment:\s*\[([^\]]*)\]/m.exec(block)?.[1];
  if (inline) {
    for (const part of inline.split(',')) {
      const [variable, ...rest] = unquote(part).split('=');
      if (variable && rest.length > 0) record(variable, rest.join('='));
    }
  }

  const section = /^\s+environment:\s*$/m.exec(block);
  if (section) {
    const tail = block.slice(section.index + section[0].length);
    for (const line of tail.split('\n')) {
      if (line.trim().length === 0 || /^\s*#/.test(line)) continue;

      const mapping = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line);
      // A key with no value at two-or-more spaces of indentation is the next section
      // (`healthcheck:`, `restart:`), not an environment entry. Breaking on `KEY:` alone rather
      // than on `KEY: value` is what lets the mapping form be read at all — the entries
      // themselves are written as `KEY: value` at the same indentation.
      if (!mapping && /^\s{2,}[A-Za-z0-9_.-]+:\s*(#.*)?$/.test(line)) break;
      if (mapping?.[1] && mapping[2] !== undefined) {
        record(mapping[1], unquote(mapping[2]));
        continue;
      }
      const listItem = /^\s+-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (listItem?.[1] && listItem[2] !== undefined) record(listItem[1], unquote(listItem[2]));
    }
  }

  return found;
}

/**
 * Volumes a service mounts, with the container path and read-only flag.
 *
 * Read from the `volumes:` block only, never from the whole service body. The short form
 * `- source:target[:ro]` is textually identical to a published port entry, so scanning the body
 * reported `- "3000:3000"` under `ports:` as a bind mount named `(bind) "3000` — a mount of a
 * string that is not a path. Scoping to the block that opens `volumes:` is what makes the two
 * distinguishable at all.
 */
function declaredVolumeMounts(
  block: string,
): { volume: string; target?: string; readOnly?: boolean; source?: string }[] {
  const found = new Map<string, { volume: string; target?: string; readOnly?: boolean; source?: string }>();

  const add = (rawSource: string, rawTarget?: string, readOnly = false): void => {
    const source = unquote(rawSource);
    if (source.length === 0) return;
    const target = rawTarget ? unquote(rawTarget) : undefined;
    // `./repos` and `/var/lib/x` are host paths, not volumes this repository declares. Recorded
    // under a distinct key so a bind mount is never reported as a declared volume.
    const volume = /^[A-Za-z0-9_.-]+$/.test(source) ? source : `(bind) ${source}`;
    const key = `${volume}|${target ?? ''}`;
    found.set(key, {
      volume,
      ...(target ? { target } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...(source !== volume ? { source } : {}),
    });
  };

  const section = /^\s+volumes:\s*$/m.exec(block);
  const tail = section ? block.slice(section.index + section[0].length) : '';
  // A service with no `volumes:` has no mounts. Returning early keeps the port/mount confusion
  // structurally impossible rather than relying on the pattern above to reject ports.
  if (!section) return [];

  let inEntry = false;
  let entryIndent = -1;
  const pending: { source: string; target?: string; readOnly: boolean }[] = [];

  const flush = (): void => {
    if (pending.length > 0) {
      // A long-form entry with `source:` but no `target:` still names a volume.
      const last = pending[pending.length - 1]!;
      if (last.source.length > 0 && last.target === undefined) add(last.source, undefined, last.readOnly);
      pending.length = 0;
    }
  };

  for (const line of tail.split('\n')) {
    if (line.trim().length === 0 || /^\s*#/.test(line)) continue;
    const leading = /^\s*/.exec(line)?.[0].length ?? 0;
    if (leading === 0) break;

    if (entryIndent < 0) entryIndent = leading;

    // Short form: `- source:target[:ro]`
    const short = /^\s*-\s*([^:]+):([^:]+)(:ro)?\s*$/.exec(line);
    if (short?.[1] !== undefined && short[2] !== undefined && leading === entryIndent) {
      flush();
      add(short[1], short[2], short[3] === ':ro');
      inEntry = false;
      continue;
    }

    if (!/^\s*-\s*\S/.test(line) || leading < entryIndent) continue;

    if (!inEntry) {
      flush();
      inEntry = true;
    }
    // Long form keys.
    const source = /^\s*source:\s*(.+)$/.exec(line)?.[1];
    if (source !== undefined) {
      pending.push({ source: unquote(source), readOnly: false });
      continue;
    }
    const target = /^\s*target:\s*(\S+)\s*$/.exec(line)?.[1];
    if (target !== undefined) {
      const last = pending[pending.length - 1];
      if (last) last.target = unquote(target);
      continue;
    }
  }
  flush();

  return [...found.values()].sort((a, b) => `${a.volume}|${a.target ?? ''}`.localeCompare(`${b.volume}|${b.target ?? ''}`));
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

/**
 * The Dockerfile a build uses, from `build.dockerfile`.
 *
 * Recorded because `context` alone is not enough to find the image's instructions. Compose's
 * default is `<context>/Dockerfile`, but an explicit `dockerfile:` is ordinary in a monorepo, and
 * an entrypoint can only be reconciled to application code through the Dockerfile the service
 * actually builds from.
 *
 * The value is relative to the build context in Compose's own semantics, so it is stored as
 * written and resolved against the context by the graph builder, which is the only place that
 * knows the repository root.
 */
function buildFileOf(block: string): string | null {
  const mapping = /^\s+build:\s*$/m.exec(block);
  if (!mapping) return null;
  const tail = block.slice(mapping.index + mapping[0].length);
  return /^\s+dockerfile:\s*(\S+)\s*$/m.exec(tail)?.[1] ?? null;
}

/**
 * A compose `command:` override, as a single normalised string.
 *
 * Recorded because a compose `command` *replaces* the image's `CMD`. Reading an entrypoint from a
 * Dockerfile and attributing it to a service that overrides the command is how a deployment view
 * ends up describing a process that never starts (D-079). The value is a command, not code, and is
 * never executed.
 */
function commandOf(block: string): string | null {
  const inlineArray = /^\s+command:\s*\[([^\]]*)\]/m.exec(block)?.[1];
  if (inlineArray !== undefined) {
    const parts = inlineArray
      .split(',')
      .map((part) => unquote(part))
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join(' ').slice(0, 200) : null;
  }

  const section = /^\s+command:\s*$/m.exec(block);
  if (section) {
    const tail = block.slice(section.index + section[0].length);
    const parts: string[] = [];
    for (const line of tail.split('\n')) {
      const item = /^\s+-\s*(.+)$/.exec(line);
      if (!item?.[1]) {
        if (line.trim().length > 0) break;
        continue;
      }
      parts.push(unquote(item[1]));
    }
    return parts.length > 0 ? parts.join(' ').slice(0, 200) : null;
  }
  const scalar = /^\s+command:\s*(.+)$/m.exec(block)?.[1];
  return scalar ? unquote(scalar).slice(0, 200) : null;
}

/**
 * A healthcheck's declared target.
 *
 * Both compose spellings occur: the exec array (`test: ["CMD", "curl", …]`) and the
 * `CMD-SHELL` string. The URL inside is read as the *name of a target*, which is enough to ask
 * whether that endpoint exists in the application graph.
 *
 * It is emphatically not a statement that the check runs or passes. Nothing in a file can
 * establish that, and Phase 5's D-084 exists because this shape was previously reported without
 * its target, leaving no way to tell a health check of a real endpoint from one naming a path
 * nothing serves.
 */
function healthcheckOf(block: string): { kind?: string; command?: string; endpoint?: string } | null {
  const section = /^\s+healthcheck:\s*$/m.exec(block);
  if (!section) return null;

  const tail = block.slice(section.index + section[0].length);
  const inline = /^\s+test:\s*\[([^\]]*)\]/m.exec(tail)?.[1];
  const parts: string[] = [];

  if (inline !== undefined) {
    for (const part of inline.split(',')) parts.push(unquote(part));
  } else {
    // `test: ["CMD", ...]` written as a list, or `test: curl …` as a scalar.
    const list = /^\s+test:\s*$/m.exec(tail);
    if (list) {
      const listTail = tail.slice(list.index + list[0].length);
      for (const line of listTail.split('\n')) {
        const item = /^\s+-\s*(.+)$/.exec(line);
        if (!item?.[1]) {
          if (line.trim().length > 0) break;
          continue;
        }
        parts.push(unquote(item[1]));
      }
    }
    if (parts.length === 0) {
      const scalar = /^\s+test:\s*(.+)$/m.exec(tail)?.[1];
      if (scalar) parts.push(unquote(scalar));
    }
  }

  if (parts.length === 0) return { kind: 'unknown' };

  const kind = parts[0] === 'CMD' || parts[0] === 'NONE' ? parts[0] : parts[0] === 'CMD-SHELL' ? 'CMD-SHELL' : 'none';
  if (kind === 'NONE') return { kind: 'NONE' };

  const command = parts.slice(1).join(' ').slice(0, 200);
  const endpoint = /https?:\/\/[^\s"'`)]+/.exec(command)?.[0];
  return {
    kind,
    ...(command.length > 0 ? { command } : {}),
    // Only the path is kept. A healthcheck written against an internal hostname names a target;
    // the host part is the container's own address and says nothing about reachability from
    // outside the deployment.
    ...(endpoint ? { endpoint: endpointPath(endpoint) } : {}),
  };
}

/** The path of a URL, with any query string removed. Never the host. */
function endpointPath(url: string): string {
  const withoutScheme = url.replace(/^https?:\/\/[^/]+/i, '');
  return withoutScheme.length > 0 ? withoutScheme.split(/[?#]/)[0]!.slice(0, 120) : '/';
}

/**
 * Reads what a Dockerfile declares, and nothing it does not.
 *
 * Every marker here is a **declaration**. `EXPOSE 4300` states that the image declares a port;
 * it does not state that the port is reachable from outside the container, and nothing in this
 * extractor can establish that. `USER node` states a configured runtime user; it is not a
 * statement that the resulting process is safe to run. Both are recorded as what they are and
 * labelled that way downstream (D-071).
 *
 * `COPY` and `ADD` are read for the *paths* they mention, never executed. `RUN` is counted but
 * its body is not interpreted: a `RUN` line can contain anything, and reading it as a command
 * would mean analysing a shell script with a regex.
 */
function parseDockerfile(source: string, result: ParsedFile): void {
  const stages: string[] = [];
  const lines = source.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    // A comment is not an instruction. Without this, a commented-out `EXPOSE` would appear as a
    // declared port.
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const lineNumber = index + 1;

    const base = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(trimmed);
    if (base) {
      stages.push(base[2] ?? 'default');
      result.markers.push({
        name: 'docker.base_image',
        line: lineNumber,
        attributes: { image: base[1] ?? '', stage: base[2] ?? 'default' },
      });
      continue;
    }

    const exposed = /^EXPOSE\s+(.+)/i.exec(trimmed);
    if (exposed) {
      result.markers.push({
        name: 'docker.expose',
        line: lineNumber,
        attributes: { ports: (exposed[1] ?? '').trim() },
      });
      continue;
    }

    const workdir = /^WORKDIR\s+(\S+)/i.exec(trimmed);
    if (workdir) {
      result.markers.push({ name: 'docker.workdir', line: lineNumber, attributes: { path: workdir[1] ?? '' } });
      continue;
    }

    // `USER node` or `USER 1001:1001`. Recorded as a configuration fact, not a judgement.
    const user = /^USER\s+(\S+)/i.exec(trimmed);
    if (user) {
      result.markers.push({
        name: 'docker.user',
        line: lineNumber,
        attributes: { user: user[1] ?? '', configured: 'true' },
      });
      continue;
    }

    const entrypoint = /^ENTRYPOINT\s+(.+)/i.exec(trimmed);
    if (entrypoint) {
      result.markers.push({
        name: 'docker.entrypoint',
        line: lineNumber,
        attributes: { value: commandText(entrypoint[1] ?? '') },
      });
      continue;
    }

    const cmd = /^CMD\s+(.+)/i.exec(trimmed);
    if (cmd) {
      result.markers.push({ name: 'docker.cmd', line: lineNumber, attributes: { value: commandText(cmd[1] ?? '') } });
      continue;
    }

    const volume = /^VOLUME\s+(.+)/i.exec(trimmed);
    if (volume) {
      result.markers.push({
        name: 'docker.volume',
        line: lineNumber,
        attributes: { paths: (volume[1] ?? '').trim() },
      });
      continue;
    }

    if (/^HEALTHCHECK\b/i.test(trimmed)) {
      // A configured healthcheck is recorded as configured. Nothing here can establish that the
      // container was ever started, let alone that the check passed.
      result.markers.push({
        name: 'docker.healthcheck',
        line: lineNumber,
        attributes: { configured: 'true' },
      });
      continue;
    }

    // `ENV KEY value` and `ENV KEY=value`. Only names are recorded for variables whose name
    // implies a credential; every other variable is recorded as configuration (D-074).
    const env = /^ENV\s+(.+)/i.exec(trimmed);
    if (env) {
      for (const [name] of declaredEnvNames(env[1] ?? '')) {
        result.markers.push({
          name: 'docker.env',
          line: lineNumber,
          attributes: {
            variable: name,
            ...(looksLikeSecretName(name) ? { secretLike: 'true' } : { secretLike: 'false' }),
          },
        });
      }
      continue;
    }

    const copy = /^(COPY|ADD)\s+(.+)/i.exec(trimmed);
    if (copy) {
      const sources = (copy[2] ?? '')
        .replace(/--[a-z-]+=\S+/gi, '')
        .replace(/--(from|chown|chmod|as)=\S+/gi, '')
        .trim()
        .split(/\s+/)
        .slice(0, -1);
      result.markers.push({
        name: 'docker.copy',
        line: lineNumber,
        attributes: { instruction: copy[1]!.toUpperCase(), sources: sources.filter((entry) => entry.length > 0).join(',') },
      });
      continue;
    }

    if (/^RUN\s+/i.test(trimmed)) {
      // Counted, not interpreted. A `RUN` line is a shell command; reading it as one with a
      // regex is how an analyser starts executing a repository's intentions in its own head.
      result.markers.push({ name: 'docker.run', line: lineNumber, attributes: { present: 'true' } });
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

/** Strips the JSON-array or exec-form wrapper so the label reads as a command, not as syntax. */
function commandText(raw: string): string {
  return raw
    .replace(/^\[\s*"?/, '')
    .replace(/"?\s*\]$/, '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Variable names in a Dockerfile `ENV`, from the space-separated and `=`-separated forms. */
function declaredEnvNames(raw: string): [string][] {
  const names: [string][] = [];
  const pairs = raw.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S*)/g);
  for (const pair of pairs) {
    if (pair[1]) names.push([pair[1]]);
  }
  if (names.length > 0) return names;

  // Space-separated form: the first token is the name, the rest is the value.
  const tokens = raw.trim().split(/\s+/);
  if (tokens[0]) names.push([tokens[0]]);
  return names;
}

/**
 * Whether a variable *name* implies a credential.
 *
 * This is a name test and nothing more. It supports "this repository references a variable
 * called `STRIPE_SECRET_KEY`", and it does not support any statement about what the variable
 * contains or how it is managed.
 */
export function looksLikeSecretName(name: string): boolean {
  return /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL|CREDENTIALS|ACCESS_KEY|CLIENT_SECRET|AUTH)(?:$|_)/i.test(
    name,
  );
}

/**
 * Reads a GitHub Actions workflow as **declared steps**, not as a deployment.
 *
 * The distinction is the whole point of this function. A workflow that runs `docker build`
 * states that the workflow builds an image; it does not state that the image is deployed, and a
 * step named `deploy` says no more about what happened than its name does. So each step records
 * its name, its `run:` text or its `uses:` reference, and the *kind* of work it names — and
 * whether a deployment step exists is left as a question the projection answers by looking for
 * one, not something inferred from the presence of a build (D-073).
 *
 * `secrets.NAME` and `env.NAME` references are read as names only. A workflow's value is never
 * read, so no secret can enter the graph through this path.
 */
function parseWorkflow(source: string, result: ParsedFile): void {
  const lines = source.split(/\r?\n/);
  let inJobs = false;
  let jobIndent = -1;
  let currentJob: { job: string; line: number; body: string[] } | null = null;
  const jobs: { job: string; line: number; body: string[] }[] = [];

  for (const [index, line] of lines.entries()) {
    const topLevel = /^([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
    if (topLevel && !/^\s/.test(line)) {
      inJobs = topLevel[1] === 'jobs';
      jobIndent = -1;
      if (currentJob) {
        jobs.push(currentJob);
        currentJob = null;
      }
      continue;
    }
    if (!inJobs || /^\s*#/.test(line)) continue;

    if (jobIndent < 0) {
      const header = /^(\s+)([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line);
      if (!header?.[1]) continue;
      jobIndent = header[1].length;
    }

    const name = new RegExp(`^\\s{${jobIndent}}([A-Za-z0-9_.-]+):\\s*(#.*)?$`).exec(line);
    if (name?.[1]) {
      if (currentJob) jobs.push(currentJob);
      currentJob = { job: name[1], line: index + 1, body: [] };
      continue;
    }
    currentJob?.body.push(line);
  }
  if (currentJob) jobs.push(currentJob);

  for (const job of jobs) {
    const lines = job.body;
    const block = lines.join('\n');

    // The job itself is the declared unit of CI work. Without it, the deployment view can say a
    // repository has CI but cannot name what that CI does, and a `secrets.X` reference has no job
    // to belong to.
    const runsOn = /^\s+runs-on:\s*(.+)$/m.exec(block)?.[1]?.trim().slice(0, 80) ?? '';

    result.markers.push({
      name: 'workflow.job',
      line: job.line,
      attributes: {
        job: job.job,
        ...(runsOn.length > 0 ? { runsOn } : {}),
        stepCount: String(countSteps(lines)),
      },
    });

    // Each step carries **its own** line, not the job's. Configuration nodes are keyed by
    // path#line, so a step recorded on the job's line is the same node as the job and every step
    // after the first is silently dropped.
    lines.forEach((raw, offset) => {
      const step = /^\s*-\s+(?:name:\s*(.+)|(run|uses):\s*(.+))/.exec(raw);
      if (!step) return;

      const stepName = (step[1] ?? '').trim();
      const kind = step[2];
      const body = (step[3] ?? '').trim();
      const uses = kind === 'uses';
      result.markers.push({
        name: 'workflow.step',
        line: job.line + offset + 1,
        attributes: {
          job: job.job,
          ...(stepName.length > 0 ? { step: stepName } : {}),
          ...(uses ? { uses: body.slice(0, 120) } : { run: body.replace(/\s+/g, ' ').slice(0, 160) }),
          // A step that *names* deployment work. The claim is about the text of the step, not
          // about what it did; the projection is where that becomes a statement.
          namesDeployment: /deploy|publish|release|push.*image|kubectl|helm/i.test(`${stepName} ${body}`)
            ? 'true'
            : 'false',
          namesBuild: /build|compile|bundle/i.test(`${stepName} ${body}`) ? 'true' : 'false',
          namesTest: /test|vitest|jest|pytest|spec/i.test(`${stepName} ${body}`) ? 'true' : 'false',
        },
      });
    });

    // A secret reference is recorded on the line it appears on, so two jobs referencing the same
    // name remain distinguishable and the graph can say where each reference lives.
    lines.forEach((raw, offset) => {
      for (const secret of new Set([...raw.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!))) {
        result.markers.push({
          name: 'workflow.secret',
          line: job.line + offset + 1,
          attributes: { job: job.job, variable: secret },
        });
      }
    });
  }
}

/** How many step lines a job body has. Counted rather than reported by the job marker alone. */
function countSteps(lines: readonly string[]): number {
  return lines.filter((line) => /^\s*-\s+(?:name:\s*.+|run:|uses:)/.test(line)).length;
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

  // `ALTER TABLE … ADD [CONSTRAINT …] FOREIGN KEY (col) REFERENCES table(col)` is how a
// foreign key is added to a table that already exists, and how migration files express it.
// Reading it is what keeps the ER diagram honest for a schema that was evolved rather than
// written in one statement.
const alterPattern =
  /ALTER\s+TABLE\s+(?:ONLY\s+)?["'`]?([\w.]+)["'`]?\s+ADD\s+(?:CONSTRAINT\s+[\w"`]+\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+["'`]?([\w.]+)["'`]?(?:\s*\(\s*["'`]?(\w+)["'`]?\s*\))?/gi;
while ((match = alterPattern.exec(source)) !== null) {
  const [, table, columnList, target, targetColumn] = match;
  if (!table || !target) continue;
  const alterLine = lineOfIndex(source, match.index);
  for (const name of columnNameList(`FOREIGN KEY (${columnList ?? ''})`, 'FOREIGN\\s+KEY') ?? []) {
    foreignKeyMarkers.push({
      name: 'schema.foreign_key',
      line: alterLine,
      attributes: { table, column: name, referencesTable: target, ...(targetColumn ? { referencesColumn: targetColumn } : {}) },
    });
  }
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

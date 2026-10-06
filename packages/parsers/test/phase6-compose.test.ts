import { describe, expect, it } from 'vitest';
import { ConfigSourceParser, type ParserContext } from '@repoatlas/parsers';

/**
 * Phase 6 fixture extraction.
 *
 * The fixture is a four-service stack — web, api, worker, database — written the way people
 * actually write compose: dependents before dependencies, list-form `depends_on`, a mix of
 * published-port spellings, and a healthcheck that names an endpoint the application graph can
 * recognise.
 *
 * Every assertion here is about a fact a reader could check by opening the file. Nothing asserts
 * that anything runs.
 */

const parser = new ConfigSourceParser();
const context = (path: string, language: string): ParserContext => ({
  path,
  language,
  maxProblems: 10,
  maxCalls: 50,
});

/**
 * web → api → database, with worker → database.
 *
 * `depends_on` appears *above* the service it names for `web`, which is the normal shape of a
 * compose file and the case Phase 5's D-080 got wrong.
 */
const STACK = `services:
  web:
    build:
      context: ./web
      dockerfile: Dockerfile
    image: acme/web:1
    ports:
      - "127.0.0.1:8080:8080"
      - "8443"
    depends_on:
      - api
    networks:
      - edge
      - backend
    environment:
      API_URL: http://api:3000
      NODE_ENV: production
      SESSION_SECRET: shhh-do-not-store-this
    restart: unless-stopped

  api:
    build: ./api
    image: acme/api:1
    ports:
      - "3000:3000"
    depends_on:
      db:
        condition: service_healthy
    networks:
      - backend
    environment:
      DATABASE_URL: postgres://user:hunter2@db:5432/app
    volumes:
      - api-cache:/var/cache
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 10s

  worker:
    build: ./worker
    image: acme/worker:1
    command: ["node", "dist/worker.js"]
    depends_on:
      - db
    networks:
      - backend
    environment:
      DATABASE_URL: postgres://user:hunter2@db:5432/app
      QUEUE_URL: amqp://db:5672
    volumes:
      - ./worker-data:/data:ro

  db:
    image: postgres:16
    networks:
      - backend
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]

networks:
  edge:
  backend:

volumes:
  api-cache:
  db-data:
`;

const markersOf = (source: string, name: string, path = 'docker-compose.yml') =>
  parser.parse(source, context(path, 'yaml')).markers.filter((marker) => marker.name === name);

describe('compose service identity', () => {
  it('names every service, and identity does not depend on file order', () => {
    const services = markersOf(STACK, 'compose.service');
    expect(services.map((marker) => marker.attributes.service).sort()).toEqual(['api', 'db', 'web', 'worker']);
  });

  it('records the same identity when the services are written in a different order', () => {
    // Phase 6 requirement: identity must survive reordering. Reordering must not change which
    // service is which, or every unrelated edit becomes a deployment diff. The service *blocks*
    // are reversed as units — reversing raw lines would interleave keys from different services
    // and produce a different file, which tests nothing about identity.
    const lines = STACK.split('\n');
    const servicesStart = lines.indexOf('services:');
    const networksStart = lines.indexOf('networks:');

    const blocks: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines.slice(servicesStart + 1, networksStart)) {
      if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(line)) {
        if (current) blocks.push(current);
        current = [line];
      } else {
        current?.push(line);
      }
    }
    if (current) blocks.push(current);

    const reordered = [
      ...lines.slice(0, servicesStart + 1),
      ...blocks.reverse().flat(),
      ...lines.slice(networksStart),
    ].join('\n');

    const identity = (source: string): Record<string, string> =>
      Object.fromEntries(
        markersOf(source, 'compose.service').map((marker) => [
          String(marker.attributes.service),
          `${marker.attributes.image}|${marker.attributes.build}|${marker.attributes.publishedPorts}`,
        ]),
      );

    expect(reordered).not.toBe(STACK);
    expect(identity(reordered)).toEqual(identity(STACK));
  });

  it('records the build file a service builds from, for reconciliation', () => {
    const web = markersOf(STACK, 'compose.service').find((marker) => marker.attributes.service === 'web');
    expect(web?.attributes.build).toBe('./web');
    expect(web?.attributes.buildFile).toBe('Dockerfile');
  });
});

describe('published port reconciliation', () => {
  it('keeps the container port, the host port and the host binding apart', () => {
    const published = markersOf(STACK, 'compose.port_publish');
    // Three entries: two for `web` and one for `api`.
    expect(published.length).toBe(3);

    const webLoopback = published.find(
      (marker) => marker.attributes.service === 'web' && marker.attributes.containerPort === '8080',
    );
    // The host binding is what makes `127.0.0.1:8080:8080` and `0.0.0.0:8080:8080` different
    // exposures. Reading only the container port throws that away.
    expect(webLoopback?.attributes.hostPort).toBe('8080');
    expect(webLoopback?.attributes.hostIp).toBe('127.0.0.1');

    // A single-port entry publishes to every interface, and says so by saying nothing.
    const webBare = published.find(
      (marker) => marker.attributes.service === 'web' && marker.attributes.containerPort === '8443',
    );
    expect(webBare?.attributes.hostPort).toBeUndefined();
    expect(webBare?.attributes.hostIp).toBeUndefined();

    // `3000:3000` names both sides; the host binding is absent, so it binds every interface.
    const api = published.find((marker) => marker.attributes.service === 'api');
    expect(api?.attributes.containerPort).toBe('3000');
    expect(api?.attributes.hostPort).toBe('3000');
    expect(api?.attributes.hostIp).toBeUndefined();
  });

  it('still never reports a host IP fragment as a port', () => {
    // The Phase 5 D-075 regression must stay fixed. Container ports are per service, so the
    // assertion is that no service anywhere reports a fragment of its host IP.
    for (const marker of markersOf(STACK, 'compose.service')) {
      const ports = String(marker.attributes.publishedPorts);
      expect(ports, String(marker.attributes.service)).not.toContain('127');
      expect(ports, String(marker.attributes.service)).toMatch(/^\d*(,\d+)*$/);
    }
    expect(markersOf(STACK, 'compose.service').find((m) => m.attributes.service === 'web')?.attributes.publishedPorts).toBe(
      '8080,8443',
    );
  });
});

describe('network and dependency separation', () => {
  it('records membership and ordering as separate facts', () => {
    const memberships = markersOf(STACK, 'compose.network').map(
      (marker) => `${marker.attributes.service}->${marker.attributes.network}`,
    );
    expect(memberships.sort()).toEqual(['api->backend', 'db->backend', 'web->backend', 'web->edge', 'worker->backend']);

    const dependencies = markersOf(STACK, 'compose.depends_on').map(
      (marker) => `${marker.attributes.service}->${marker.attributes.dependsOn}`,
    );
    expect(dependencies.sort()).toEqual(['api->db', 'web->api', 'worker->db']);
  });

  it('records a dependency declared before the service it names', () => {
    // `web` names `api` above the block that declares `api`. Reading in file order reaches the
    // dependency first, which is exactly what Phase 5's D-080 dropped.
    const before = markersOf(STACK, 'compose.depends_on').find((marker) => marker.attributes.service === 'web');
    const target = markersOf(STACK, 'compose.service').find((marker) => marker.attributes.service === 'api');
    expect(before?.attributes.dependsOn).toBe('api');
    expect(before!.line).toBeLessThan(target!.line);
  });
});

describe('healthcheck reconciliation', () => {
  it('records the endpoint a healthcheck names', () => {
    const api = markersOf(STACK, 'compose.healthcheck').find((marker) => marker.attributes.service === 'api');
    expect(api?.attributes.kind).toBe('CMD');
    expect(api?.attributes.command).toBe('curl -f http://localhost:3000/api/health');
    // Only the path. The host is the container's own address and says nothing about exposure.
    expect(api?.attributes.endpoint).toBe('/api/health');
  });

  it('records a command-only healthcheck without inventing an endpoint', () => {
    const db = markersOf(STACK, 'compose.healthcheck').find((marker) => marker.attributes.service === 'db');
    expect(db?.attributes.kind).toBe('CMD-SHELL');
    expect(db?.attributes.command).toBe('pg_isready -U postgres');
    expect(db?.attributes.endpoint).toBeUndefined();
  });

  it('never says a healthcheck passed', () => {
    for (const marker of markersOf(STACK, 'compose.healthcheck')) {
      expect(marker.attributes.passed).toBeUndefined();
      expect(marker.attributes.status).toBeUndefined();
    }
  });
});

describe('volume, command and environment reconciliation', () => {
  it('records a declared volume and where it appears in the container', () => {
    const mounts = markersOf(STACK, 'compose.volume_mount').map(
      (marker) => `${marker.attributes.volume}:${marker.attributes.target}`,
    );
    expect(mounts.sort()).toEqual([
      '(bind) ./worker-data:/data',
      'api-cache:/var/cache',
      'db-data:/var/lib/postgresql/data',
    ]);
  });

  it('marks a read-only bind mount as read-only', () => {
    const worker = markersOf(STACK, 'compose.volume_mount').find(
      (marker) => marker.attributes.service === 'worker',
    );
    expect(worker?.attributes.readOnly).toBe('true');
  });

  it('records the volumes the file declares', () => {
    expect(markersOf(STACK, 'compose.volume_declared').map((marker) => marker.attributes.volume).sort()).toEqual([
      'api-cache',
      'db-data',
    ]);
  });

  it('records a compose command override, which replaces the image CMD', () => {
    const worker = markersOf(STACK, 'compose.command').find((marker) => marker.attributes.service === 'worker');
    expect(worker?.attributes.value).toBe('node dist/worker.js');
  });

  it('records environment names only, never values', () => {
    const names = markersOf(STACK, 'compose.environment').map((marker) => marker.attributes.variable);
    expect(names).toContain('API_URL');
    expect(names).toContain('SESSION_SECRET');
    expect(names).toContain('DATABASE_URL');

    const serialised = JSON.stringify(markersOf(STACK, 'compose.environment'));
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('shhh-do-not-store-this');
  });

  it('records a service-to-service URL as an address, without calling it reachable', () => {
    // `http://api:3000` names another service by its compose name. That is evidence the
    // application is configured to talk to `api`, and nothing more — whether the call succeeds
    // is a runtime fact (D-083).
    const api = markersOf(STACK, 'compose.environment').find((marker) => marker.attributes.variable === 'API_URL');
    expect(api?.attributes.variable).toBe('API_URL');
    expect(api?.attributes.value).toBeUndefined();
  });
});

describe('service-address evidence', () => {
  it('reads a service name out of a declared URL, as a reference not a connection', () => {
    const source = `services:
  api:
    image: acme/api:1
    environment:
      UPSTREAM: http://db:5432
`;
    const marker = markersOf(source, 'compose.service_address')[0];
    expect(marker?.attributes.service).toBe('api');
    expect(marker?.attributes.target).toBe('db');
    expect(marker?.attributes.port).toBe('5432');
  });
});
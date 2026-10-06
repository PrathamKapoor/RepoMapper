import type { FixtureTree } from './fixtures.js';

export const MULTI_SERVICE_FIXTURE: FixtureTree = {
  'package.json': JSON.stringify({
    name: 'multi-service-app',
    version: '1.0.0',
    scripts: { build: 'tsc', test: 'vitest run' },
    dependencies: { express: '^4.19.2', zod: '^3.23.8' },
  }),

  'docker-compose.yml': `services:
  web:
    build:
      context: ./web
    ports:
      - "8080:80"
    depends_on:
      - api
    networks:
      - frontend
    environment:
      WEB_SECRET_KEY: super-secret-value-12345
    restart: unless-stopped
  api:
    build:
      context: ./api
    ports:
      - "3000:3000"
    depends_on:
      - worker
      - db
    networks:
      - frontend
      - backend
    environment:
      API_SECRET_KEY: another-secret-value-67890
    restart: unless-stopped
  worker:
    build:
      context: ./worker
    depends_on:
      - db
      - cache
    networks:
      - backend
    restart: unless-stopped
  db:
    image: postgres:16-alpine
    volumes:
      - db_data:/var/lib/postgresql/data
    networks:
      - backend
    environment:
      POSTGRES_PASSWORD: db-password-secret
  cache:
    image: redis:7-alpine
    networks:
      - backend
networks:
  frontend:
  backend:
volumes:
  db_data:
`,

  'web/Dockerfile': `FROM nginx:alpine
COPY dist/ /usr/share/nginx/html/
EXPOSE 80
`,

  'web/src/index.ts': `import express from 'express';
const app = express();
app.get('/health', (req, res) => { res.json({ status: 'ok' }); });
export default app;
`,

  'api/Dockerfile': `FROM node:22-alpine
WORKDIR /app
EXPOSE 3000
CMD ["node", "dist/index.js"]
`,

  'api/src/index.ts': `import express from 'express';
import { DataService } from './services/data.js';
const app = express();
const dataService = new DataService();
app.get('/api/health', (req, res) => { res.json({ status: 'ok' }); });
app.get('/api/users', async (req, res) => { res.json(await dataService.findAllUsers()); });
app.post('/api/users', async (req, res) => { res.status(201).json(await dataService.createUser(req.body)); });
export default app;
`,

  'api/src/services/data.ts': `import { Database } from '../db/database.js';
export interface User { id: string; name: string; email: string; }
export class DataService {
  private readonly db: Database;
  constructor() { this.db = new Database(); }
  async findAllUsers(): Promise<User[]> { return this.db.query('SELECT * FROM users'); }
  async createUser(data: { name: string; email: string }): Promise<User> {
    return this.db.query('INSERT INTO users (name, email) VALUES (?, ?) RETURNING *', [data.name, data.email]);
  }
}
`,

  'api/src/db/database.ts': `export class Database {
  query(sql: string, params: unknown[] = []): Promise<any[]> { return Promise.resolve([]); }
}
`,

  'worker/Dockerfile': `FROM node:22-alpine
WORKDIR /app
CMD ["node", "dist/index.js"]
`,

  'worker/src/index.ts': `import { ProcessQueue } from './queue.js';
const queue = new ProcessQueue();
async function main(): Promise<void> { await queue.processJobs(); }
main().catch(console.error);
`,

  'worker/src/queue.ts': `import { Database } from './db.js';
export class ProcessQueue {
  private readonly db: Database;
  constructor() { this.db = new Database(); }
  async processJobs(): Promise<void> {
    const jobs = await this.db.query('SELECT * FROM jobs WHERE status = ?', ['pending']);
    for (const job of jobs) { await this.processJob(job); }
  }
  private async processJob(job: { id: string }): Promise<void> {
    await this.db.query('UPDATE jobs SET status = ? WHERE id = ?', ['completed', job.id]);
  }
}
`,

  'worker/src/db.ts': `export class Database {
  query(sql: string, params: unknown[] = []): Promise<any[]> { return Promise.resolve([]); }
}
`,

  'schema.sql': `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
`,

  '.github/workflows/ci.yml': `name: CI
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test
  deploy:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - run: docker compose build
        env:
          DEPLOY_SECRET: \${{ secrets.DEPLOY_SECRET }}
`,

  'README.md': `# Multi-Service Application
## Services
- web: Frontend web server
- api: Backend API server
- worker: Background job processor
- db: PostgreSQL database
- cache: Redis cache
`,
};

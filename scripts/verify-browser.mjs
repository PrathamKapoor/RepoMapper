/**
 * Browser verification driver.
 *
 * Speaks the Chrome DevTools Protocol over Node's built-in WebSocket — no dependencies — so
 * the UI can be checked in a real browser. This exists because the repository has no DOM test
 * harness, and "the UI was never opened" is not an acceptable permanent answer for a product
 * whose whole claim is about what a user can see.
 *
 * It verifies rendering and interaction: every tab loads, the C4 levels draw, selecting a C4
 * element opens its derivation and evidence, the behaviour and traceability views render their
 * lists and drill through, and a drift row drills through to the entity inspector in the right
 * snapshot.
 *
 * This is verification tooling, not product code, and it is not part of `npm run verify`: it
 * needs a running server with at least two analyses of the same repository, and a browser
 * binary. Both are supplied by the caller.
 *
 *   node scripts/verify-browser.mjs <baseUrl> <browserPath> [userDataDir]
 *
 * Example:
 *
 *   REPOATLAS_ALLOWED_ROOTS=/repos npm start
 *   curl -X POST localhost:4300/api/analyses -d '{"repositoryPath":"/repos/x"}'   # twice,
 *   # after changing something in between
 *   node scripts/verify-browser.mjs http://localhost:4300 \
 *     "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */

const [, , baseUrl, edgePath, userDataDir] = process.argv;

if (!baseUrl || !edgePath) {
  console.error('usage: node scripts/verify-browser.mjs <baseUrl> <browserPath> [userDataDir]');
  process.exit(2);
}

const { spawn } = await import('node:child_process');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const profile = mkdtempSync(join(tmpdir(), 'repoatlas-cdp-'));
const child = spawn(
  edgePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${userDataDir ?? profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = '';
  const timer = setTimeout(() => reject(new Error('devtools endpoint never appeared')), 30_000);
  child.stderr.on('data', (chunk) => {
    buffer += String(chunk);
    const match = /ws:\/\/[^\s]+/.exec(buffer);
    if (match) {
      clearTimeout(timer);
      resolve(match[0]);
    }
  });
  child.on('exit', (code) => reject(new Error(`browser exited ${code}`)));
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));

let nextId = 1;
const pending = new Map();
const consoleErrors = [];

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'exception');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

// The browser-level endpoint has no Page or Runtime domain, so a page target is created and
// attached to with flattened sessions; every later message carries that sessionId.
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

const evaluate = async (expression) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluation failed');
  return result.result.value;
};

let visit = 0;

/**
 * Polls for an expression rather than sleeping.
 *
 * Waiting a fixed time would either be flaky or slow, and — worse — would let a check pass
 * against a page whose data had not arrived yet, which is how a broken view gets reported as
 * a working one.
 */
const waitFor = async (expression, label, attempts = 120) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    // A navigation destroys the execution context mid-poll, so a transient evaluation error
    // is expected here and must not be mistaken for a failed page.
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* context is being replaced; keep polling */
    }
  }
  const where = await evaluate('location.href').catch(() => '<unknown>');
  const seen = await evaluate('document.body.textContent.slice(0, 300)').catch(() => '<none>');
  throw new Error(`never became true: ${label ?? expression} at ${where} | saw: ${seen}`);
};

const goto = async (url, readyExpression = `document.querySelectorAll('.tabs button').length > 0`) => {
  // A unique query makes every visit a distinct document load: a fragment-only change does
  // not reload, and each check must start from a fresh application. The query goes *before*
  // the fragment — appending it after would make it part of the route, and `#/c4/container`
  // would be read as the level `container?visit=3`.
  visit += 1;
  const [path, fragment] = url.split('#');
  const separator = path.includes('?') ? '&' : '?';
  const target = `${path}${separator}visit=${visit}${fragment ? `#${fragment}` : ''}`;
  await send('Page.navigate', { url: target }, sessionId);
  await waitFor(readyExpression, target);
};

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);

try {
  // ---------------------------------------------------------------- application shell
  await goto(`${baseUrl}/`, `document.body.textContent.includes('Entities')`);
  record('application loads and React mounts', await evaluate(`!!document.querySelector('h1')?.textContent?.includes('RepoAtlas')`));
  record(
    'all ten tabs render',
    (await evaluate(`document.querySelectorAll('.tabs button').length`)) === 10,
    `${await evaluate(`[...document.querySelectorAll('.tabs button')].map((b) => b.textContent).join(' ')`)}`,
  );
  record('stored analyses are listed', await evaluate(`document.querySelectorAll('.list button').length > 0`));
  record('health status reaches the top bar', await evaluate(`document.body.textContent.includes('API v0.1.0')`));
  record('no allow-list warning when enforced', !(await evaluate(`document.body.textContent.includes('no path allow-list')`)));

  // ---------------------------------------------------------------- C4, all three levels
  for (const [index, level] of ['context', 'container', 'component'].entries()) {
    // Waiting for the scope string means the artifact has arrived, not merely that the tab opened.
    await goto(`${baseUrl}/#/c4/${level}`, `document.body.textContent.includes('Level ${index + 1}.')`);
    const nodes = await evaluate(`document.querySelectorAll('.react-flow__node').length`);
    record(`C4 level ${level} renders`, nodes > 0, `${nodes} canvas nodes`);
    record(`C4 level ${level} reports what it could not draw`, await evaluate(`document.body.textContent.includes('Not represented in this view')`));
  }

  // ---------------------------------------------------------------- C4 element drill-through
  await goto(`${baseUrl}/#/c4/container`, `document.body.textContent.includes('Level 2.')`);
  await evaluate(`document.querySelectorAll('.react-flow__node')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await waitFor(`document.body.textContent.includes('Why RepoAtlas believes this')`, 'C4 element panel');
  record('selecting a C4 element opens the element panel with its derivation', true);
  record('the element panel shows evidence locations', await evaluate(`document.body.textContent.includes('Evidence (')`));
  record(
    'the element panel shows relationships with their graph support',
    await evaluate(`document.body.textContent.includes('justified by') || document.body.textContent.includes('No relationship to another element')`),
  );
  record('the graph entity inspector opens for the same element', await evaluate(`document.body.textContent.includes('Outgoing') || document.body.textContent.includes('Incoming')`));
  record('the cited source file is reachable from the C4 element', await evaluate(`document.querySelector('.drawer')?.textContent?.includes('docker-compose.yml') ?? false`));

  // ---------------------------------------------------------------- behaviour
  // Each behaviour view is a separate claim about the repository, so each is opened by name
  // rather than checked by whatever happened to render.
  for (const [view, marker] of [
    ['Sequence', 'Sequence'],
    ['Activity', 'Activity'],
    ['Data flow', 'Data flow'],
  ]) {
    await goto(`${baseUrl}/#/behaviour`, `document.body.textContent.includes('Sequence')`);
    const clicked = await evaluate(`
      (() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(view)});
        if (button) button.click();
        return !!button;
      })()
    `);
    await waitFor(`document.body.textContent.includes(${JSON.stringify(marker)})`, `behaviour ${view}`);
    record(`behaviour view ${view} renders`, clicked);
  }

await goto(`${baseUrl}/#/behaviour`, `document.body.textContent.includes('Sequence')`);
  const lineage = await evaluate(`document.body.textContent.includes('Data lineage')`);
  record('behaviour offers data lineage alongside the projections', lineage);
  record(
    'lineage either traces a store or says the repository moves no data to one',
    lineage &&
      (await evaluate(
        String.raw`new RegExp('\\d+ hop\\(s\\) upstream').test(document.body.textContent) || document.body.textContent.includes('nothing in') || document.body.textContent.includes('declares no table')`,
      )),
  );

  // ------------------------------------------------------------ return messages
  // The sequence view has to show what the graph holds about hand-backs and failures. The
  // artefact is fetched over the same origin the page uses, so a message that exists in the
  // graph but never renders fails here rather than passing on an empty view.
  await goto(`${baseUrl}/#/behaviour`, `document.body.textContent.includes('Sequence')`);
  await evaluate(`
    (() => {
      const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Sequence');
      if (button) button.click();
      return !!button;
    })()
  `);
  await waitFor(`document.querySelectorAll('.react-flow__node').length > 0`, 'behaviour sequence nodes');

  const analyses = await (await fetch(`${baseUrl}/api/analyses?limit=1`)).json();
  const analysisId = analyses?.analyses?.[0]?.id;
  const returnFacts = await evaluate(`
    (async () => {
      const id = ${JSON.stringify(analysisId ?? '')};
      if (!id) return { ok: false, reason: 'no analysis available' };
      const response = await fetch('/api/analyses/' + id + '/artifacts/sequence');
      if (!response.ok) return { ok: false, reason: 'artifact request failed: ' + response.status };
      const artifact = await response.json();
      const body = document.body.textContent;
      const count = (kind) => (artifact.edges ?? []).filter((edge) => edge.kind === kind).length;
      return {
        ok: true,
        drawn: document.querySelectorAll('.react-flow__node').length,
        drawnEdges: document.querySelectorAll('.react-flow__edge').length,
        // The view states its own cap rather than cutting silently, so a truncated view is
        // not expected to show every message.
        truncated: /Showing \\d+ of \\d+ entities/.test(body),
        returns: count('returns'),
        throws: count('throws'),
        shownReturns: /\\breturns\\b/.test(body),
        shownThrows: /\\bthrows\\b/.test(body),
        omissions: (artifact.omissions ?? []).length,
        statesOmissions: /not read|no recorded return/.test(body),
      };
    })()
  `);
  record(
    'sequence draws the participants the artefact names',
    returnFacts.ok && returnFacts.drawn > 0,
    returnFacts.ok ? `${returnFacts.drawn} participants, ${returnFacts.drawnEdges} messages` : String(returnFacts.reason),
  );
  record(
    'a return message in the graph is drawn in the sequence view',
    returnFacts.ok && (returnFacts.returns === 0 || returnFacts.truncated || returnFacts.shownReturns),
    returnFacts.ok
      ? `${returnFacts.returns} return message(s) in the artefact${returnFacts.truncated ? ', view truncated' : ''}`
      : String(returnFacts.reason),
  );
  record(
    'a failure message in the graph is drawn in the sequence view',
    returnFacts.ok && (returnFacts.throws === 0 || returnFacts.truncated || returnFacts.shownThrows),
    returnFacts.ok
      ? `${returnFacts.throws} failure message(s) in the artefact${returnFacts.truncated ? ', view truncated' : ''}`
      : String(returnFacts.reason),
  );
  record(
    'the sequence view states what it could not read rather than drawing it',
    returnFacts.ok && (returnFacts.omissions === 0 || returnFacts.statesOmissions),
    returnFacts.ok ? `${returnFacts.omissions} omission(s) recorded` : String(returnFacts.reason),
  );

  // ---------------------------------------------------------------- traceability
  // Waiting on the *content*, not on the section button label: the buttons render before their
  // data arrives, and a check that reads the DOM too early reports a working view as empty.
  const requirementLabels =
    '/stated by the repository|derived from code|partly evidenced|not supported by this repository|states no requirement/';
  await goto(`${baseUrl}/#/traceability`, `${requirementLabels}.test(document.body.textContent)`);
  record('traceability renders the requirements view', await evaluate(`${requirementLabels}.test(document.body.textContent)`));
  record(
    'traceability distinguishes stated from derived requirements',
    await evaluate(`/stated by the repository|derived from code/.test(document.body.textContent)`),
  );

  const useCasesClicked = await evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.row.wrap button')].find((b) => b.textContent === 'Use cases');
      if (button) button.click();
      return !!button;
    })()
  `);
  await waitFor(`document.body.textContent.includes('Fully traced')`, 'use cases view');
  record('traceability renders the use-case list', useCasesClicked);
  record(
    'a use case states what is not evidenced about it',
    await evaluate(`document.body.textContent.includes('nothing outstanding') || document.body.textContent.includes('No actor is named')`),
  );

  const chainClicked = await evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.row.wrap button')].find((b) => b.textContent === 'Traceability');
      if (button) button.click();
      return !!button;
    })()
  `);
  await waitFor(`document.body.textContent.includes('Entry points')`, 'traceability index');
  record('traceability renders the chain index', chainClicked);

  const rowClicked = await evaluate(`
    (() => {
      const button = [...document.querySelectorAll('table .link')].find((b) => b.closest('table'));
      if (button) button.click();
      return !!button;
    })()
  `);
if (rowClicked) {
    // The chain arrives asynchronously after the row is selected, so the check waits for the
    // chain's own wording rather than reading the panel the instant it opens.
    await waitFor(
      `/Every joint traced|joint\\(s\\) the repository does not evidence|No chain for this entity|Chain could not be loaded/.test(document.body.textContent)`,
      'chain detail',
    );
    record('selecting an entry point opens its requirement → test chain', true);
    const joints = await evaluate(
      `['requirement', 'use case', 'implementation', 'test'].filter((joint) =>
        [...document.querySelectorAll('.stat .label')].some((label) => (label.textContent ?? '').toLowerCase() === joint),
      )`,
    );
    record(
      'the chain reports every joint, zeros included',
      joints.length === 4,
      // The four joint counters, read from the rendered labels rather than from body text: the
      // table headers are plural ("Tests"), the counters are singular ("test"), and matching
      // body text would pass on the header alone without the chain ever having opened.
      joints.join(', ') ||
        (await evaluate(`[...document.querySelectorAll('.stat .label')].map((n) => n.textContent).join(' | ')`)),
    );
  } else {
    record('this repository declares no entry point, so no chain opens', await evaluate(`document.body.textContent.includes('no entry point')`));
  }

  const consistencyClicked = await evaluate(`
    (() => {
      const button = [...document.querySelectorAll('.row.wrap button')].find((b) => b.textContent === 'Consistency');
      if (button) button.click();
      return !!button;
    })()
  `);
  await waitFor(`document.body.textContent.includes('Compared:') || document.body.textContent.includes('No cross-artifact finding')`, 'consistency view');
  record('consistency view renders with the representations it compared', consistencyClicked);
  record(
    'consistency says absence is not a contradiction',
    await evaluate(`document.body.textContent.includes('contradiction is reserved')`),
  );

  // ---------------------------------------------------------------- drift
  // With fewer than two successful analyses there is nothing to compare, and the view must
  // say so rather than showing an empty report that reads like "nothing changed".
  await goto(
    `${baseUrl}/#/drift`,
    `document.body.textContent.includes('Base state') || document.body.textContent.includes('Drift compares two analyses')`,
  );
  const hasReport = await evaluate(`document.body.textContent.includes('Base state')`);
  if (!hasReport) {
    record('drift explains that it needs two analyses', true);
    record('drift does not present an empty state as "nothing changed"', !(await evaluate(`document.body.textContent.includes('Nothing changed')`)));
  } else {
    record('drift renders the comparison identity table', await evaluate(`document.body.textContent.includes('Base state') && document.body.textContent.includes('Target state')`));

    // Two analyses of an unchanged repository must render as "nothing changed", and the
    // change-level checks below would then be checking for rows that correctly do not exist.
    const identical = await evaluate(`document.body.textContent.includes('Nothing changed')`);
    if (identical) {
      record('drift reports no change between two identical analyses', true);
      record(
        'drift says the two snapshots share a graph digest',
        await evaluate(`/graph digest|snapshot|digest/i.test(document.body.textContent)`),
      );
    } else {
      record('drift renders the change summary', await evaluate(`document.body.textContent.includes('Change summary')`));
      record(
        'drift renders individual changes with evidence on both sides',
        // What the view must show is the evidence on each side, so the check looks for the
        // two labels it renders and any source location. Pinning the check to a list of file
        // extensions would make it fail whenever the only change happened to be in a file it
        // did not think of.
        await evaluate(
          `document.body.textContent.includes('base:') && document.body.textContent.includes('target:') && /[\\w./-]+\\.[a-z]{1,6}:\\d+/.test(document.body.textContent)`,
        ),
      );

      const clicked = await evaluate(`
        (() => {
          const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'inspect entity');
          if (button) button.click();
          return !!button;
        })()
      `);
      record('a drift row offers an inspect action', clicked);
      if (clicked) {
        await waitFor(
          `document.body.textContent.includes('Outgoing') || document.body.textContent.includes('Evidence (')`,
          'drift inspector',
        );
        record('a drift row drills through to the entity inspector', true);
      }
    }
  }

  // ---------------------------------------------------------------- other tabs
  for (const [tab, marker] of [
    ['architecture', 'dependency-graph'],
    ['structure', 'module-graph'],
    ['evidence', 'Evidence records'],
    ['gaps', 'Each item states how much support'],
    ['diagnostics', 'Diagnostics'],
  ]) {
    await goto(`${baseUrl}/#/${tab}`, `document.body.textContent.includes(${JSON.stringify(marker)})`);
    record(`tab ${tab} renders its content`, true);
  }

  record('no uncaught exceptions or console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (error) {
  record('driver completed', false, String(error));
} finally {
  socket.close();
  child.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold the directory; the OS will clean it */
  }
}

const failed = results.filter((entry) => !entry.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

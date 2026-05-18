import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

const client = new Anthropic();
const HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf-8');

const GITHUB_API = 'https://api.github.com';
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';

function githubHeaders() {
  return {
    Authorization: `token ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'music-recommend-lambda',
  };
}

async function getFile(path) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${path}?ref=${BRANCH}`, {
    headers: githubHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
  const data = await res.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha,
  };
}

async function commitFile(path, content, sha, message) {
  const res = await fetch(`${GITHUB_API}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha,
      branch: BRANCH,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub write failed: ${res.status}`);
  }
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  return JSON.parse(raw);
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const path = event.rawPath || '/';
  const method = event.requestContext?.http?.method || 'GET';

  if (method === 'GET' && path === '/') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: HTML };
  }

  let body;
  try {
    body = parseBody(event);
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (body.password !== process.env.APP_PASSWORD) {
    return json(401, { error: 'Unauthorized' });
  }

  if (method === 'POST' && path === '/api/chat') {
    const [claudeMd, recsMd] = await Promise.all([
      getFile('CLAUDE.md'),
      getFile('recommendations.md'),
    ]);

    const systemPrompt = `${claudeMd.content}\n\n## Current Recommendations Log\n\n${recsMd.content}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: body.messages,
    });

    return json(200, { content: response.content[0].text });
  }

  if (method === 'POST' && path === '/api/commit') {
    const { newRow, commitMessage } = body;
    if (!newRow) return json(400, { error: 'newRow is required' });

    const { content, sha } = await getFile('recommendations.md');

    // Insert new row before the blank line that precedes "## Want to listen to",
    // keeping it within the main recommendations table.
    let updated;
    const wantIdx = content.indexOf('\n\n## Want to listen to');
    if (wantIdx !== -1) {
      updated = content.slice(0, wantIdx) + '\n' + newRow + content.slice(wantIdx);
    } else {
      updated = content.trimEnd() + '\n' + newRow + '\n';
    }

    await commitFile('recommendations.md', updated, sha, commitMessage || `Log: ${newRow}`);
    return json(200, { success: true });
  }

  return json(404, { error: 'Not found' });
};

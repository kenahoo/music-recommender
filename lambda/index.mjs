import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';

const client = new Anthropic();
const HTML = readFileSync(new URL('./index.html', import.meta.url), 'utf-8');

const GITHUB_API = 'https://api.github.com';
const REPO = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || 'main';

// ── CloudWatch log links ──────────────────────────────────────────────────────
// CloudWatch console tokens are URL-encoded, then each '%' is replaced with '$25'.
const cwEnc = (s) => encodeURIComponent(s).replace(/%/g, '$25');

function cwBase() {
  const region = process.env.AWS_REGION || 'us-east-1';
  return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#logsV2:log-groups/log-group/`;
}

// Deep link to the exact log stream for this invocation (used in error responses).
function streamLogUrl(context) {
  const group = context?.logGroupName || `/aws/lambda/${process.env.AWS_LAMBDA_FUNCTION_NAME}`;
  let url = cwBase() + cwEnc(group);
  if (context?.logStreamName) url += `/log-events/${cwEnc(context.logStreamName)}`;
  return url;
}

// Link to the whole log group, injected into the page so the frontend can link to
// logs even for gateway/timeout errors that never reach this handler.
function groupLogUrl() {
  return cwBase() + cwEnc(`/aws/lambda/${process.env.AWS_LAMBDA_FUNCTION_NAME}`);
}

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

async function commitFile(path, content, message) {
  // Re-fetch SHA at commit time to handle any delay between proposal and confirm
  const { sha } = await getFile(path);
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

function lineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const removed = new Set();
  const added = new Set();

  // Mark lines removed from old that aren't in new
  for (let i = 0; i < oldLines.length; i++) {
    if (!newLines.includes(oldLines[i])) removed.add(i);
  }
  const result = [];
  for (let i = 0; i < oldLines.length; i++) {
    if (removed.has(i)) result.push(`- ${oldLines[i]}`);
  }
  for (let i = 0; i < newLines.length; i++) {
    if (!oldLines.includes(newLines[i])) result.push(`+ ${newLines[i]}`);
  }
  return result.length ? result.join('\n') : '(no textual diff detected)';
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

const UPDATE_PROTOCOL = `## How updates work

The "Current Recommendations Log" below is the live, saved contents of recommendations.md. Always trust it as the source of truth over anything earlier in the conversation.

To log a listen, add an entry, change a verdict, or make ANY edit to the log, you MUST call the propose_update tool with the complete updated file. That is the only way the file can change. Never say you have logged, added, updated, saved, or committed anything unless you actually called propose_update in that same reply. After you call it, the user reviews the diff and confirms the commit — you never commit yourself. If a change you proposed earlier is not reflected in the log below, it was not saved; propose it again.`;

const tools = [
  {
    name: 'propose_update',
    description: 'Propose changes to recommendations.md. Call this when the user wants to update verdicts, add entries, or make any other edit. This does NOT commit immediately — the user will be shown the diff and asked to confirm before anything is saved.',
    input_schema: {
      type: 'object',
      properties: {
        new_content: {
          type: 'string',
          description: 'The complete proposed new content of recommendations.md',
        },
        commit_message: {
          type: 'string',
          description: 'A short git commit message describing the changes',
        },
      },
      required: ['new_content', 'commit_message'],
    },
  },
];

export const handler = async (event, context) => {
  const path = event.rawPath || '/';
  const method = event.requestContext?.http?.method || 'GET';

  if (method === 'GET' && path === '/') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/html' }, body: HTML };
  }

  if (method === 'POST' && path === '/api/auth') {
    let b;
    try { b = parseBody(event); } catch { return json(400, { error: 'Invalid JSON' }); }
    return b.password === process.env.APP_PASSWORD
      ? json(200, { ok: true, logGroupUrl: groupLogUrl() })
      : json(401, { error: 'Unauthorized' });
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

  if (method === 'POST' && path === '/api/commit') {
    const { newContent, commitMessage } = body;
    if (!newContent) return json(400, { error: 'newContent is required' });
    try {
      await commitFile('recommendations.md', newContent, commitMessage || 'Update recommendations');
      return json(200, { success: true });
    } catch (err) {
      return json(502, { error: err.message, logUrl: streamLogUrl(context) });
    }
  }

  if (method === 'POST' && path === '/api/chat') {
    try {
      const [claudeMd, recsMd] = await Promise.all([
        getFile('CLAUDE.md'),
        getFile('recommendations.md'),
      ]);

      const systemPrompt = `${claudeMd.content}\n\n${UPDATE_PROTOCOL}\n\n## Current Recommendations Log\n\n${recsMd.content}`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages: body.messages,
        tools,
      });

      const text = response.content.find(b => b.type === 'text');
      const toolBlock = response.content.find(
        b => b.type === 'tool_use' && b.name === 'propose_update'
      );

      // When the model proposes an update we return the diff immediately rather
      // than making a second Claude call for a confirmation message — the diff is
      // shown in the pending bar, and the extra round-trip was the main cause of
      // requests exceeding the timeout.
      let pending = null;
      if (toolBlock) {
        pending = {
          newContent: toolBlock.input.new_content,
          commitMessage: toolBlock.input.commit_message,
          diff: lineDiff(recsMd.content, toolBlock.input.new_content),
        };
      }

      const content = text?.text?.trim()
        || (pending ? 'I’ve prepared the change below — review the diff and hit Commit to save it.' : '');

      return json(200, { content, pending });
    } catch (err) {
      console.error('Chat error:', err.message);
      return json(502, { error: err.message || 'Claude API error', logUrl: streamLogUrl(context) });
    }
  }

  return json(404, { error: 'Not found' });
};

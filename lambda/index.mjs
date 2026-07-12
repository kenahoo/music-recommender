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

// Proper LCS-based line diff so the shown +/- lines actually reflect the change
// (the old set-based version mishandled moved/duplicate lines and could report
// "no diff" for a real change).
function lineDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push(`- ${a[i]}`); i++; }
    else { result.push(`+ ${b[j]}`); j++; }
  }
  while (i < m) result.push(`- ${a[i++]}`);
  while (j < n) result.push(`+ ${b[j++]}`);
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

The "Current Listening Log" below is the live, saved contents of listening-log.md. Always trust it as the source of truth over anything earlier in the conversation.

To log a listen, add an entry, change a verdict, or make ANY edit to the log, you MUST call the propose_update tool with the complete updated file. That is the only way the file can change. Never say you have logged, added, updated, saved, or committed anything unless you actually called propose_update in that same reply. After you call it, the user reviews the diff and confirms the commit — you never commit yourself. If a change you proposed earlier is not reflected in the log below, it was not saved; propose it again.

Before proposing an update, check whether the log below already reflects what the user is asking for. Note that many entries are keyed by artist, not album title. If the log already says what they want, just tell them that — do not propose content identical to the current file.`;

const tools = [
  {
    name: 'propose_update',
    description: 'Propose changes to listening-log.md. Call this when the user wants to update verdicts, add entries, or make any other edit. This does NOT commit immediately — the user will be shown the diff and asked to confirm before anything is saved.',
    input_schema: {
      type: 'object',
      properties: {
        new_content: {
          type: 'string',
          description: 'The complete proposed new content of listening-log.md',
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

  if (method === 'GET' && path === '/api/listening-log') {
    if (event.headers?.['x-app-password'] !== process.env.APP_PASSWORD) {
      return json(401, { error: 'Unauthorized' });
    }
    try {
      const { content } = await getFile('listening-log.md');
      return json(200, { content });
    } catch (err) {
      return json(502, { error: err.message, logUrl: streamLogUrl(context) });
    }
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
      await commitFile('listening-log.md', newContent, commitMessage || 'Update listening log');
      return json(200, { success: true });
    } catch (err) {
      return json(502, { error: err.message, logUrl: streamLogUrl(context) });
    }
  }

  if (method === 'POST' && path === '/api/chat') {
    try {
      const [claudeMd, recsMd] = await Promise.all([
        getFile('CLAUDE.md'),
        getFile('listening-log.md'),
      ]);

      const systemPrompt = `${claudeMd.content}\n\n${UPDATE_PROTOCOL}\n\n## Current Listening Log\n\n${recsMd.content}`;
      const msgs = [...body.messages];

      // On a clean proposal we return immediately (no extra confirmation call —
      // the diff is shown in the pending bar). If the model proposes a no-op or an
      // otherwise invalid change, feed the problem back so it can self-correct or
      // explain to the user, bounded to a few attempts.
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          messages: msgs,
          tools,
        });

        const text = response.content.find(b => b.type === 'text');
        const toolUses = response.content.filter(b => b.type === 'tool_use');

        if (toolUses.length === 0) {
          return json(200, { content: text?.text?.trim() || '', pending: null });
        }

        const results = [];
        let pending = null;
        for (const block of toolUses) {
          if (block.name !== 'propose_update') {
            results.push({ type: 'tool_result', tool_use_id: block.id, is_error: true, content: `Unknown tool: ${block.name}` });
            continue;
          }
          const newContent = block.input.new_content ?? '';
          if (newContent === recsMd.content) {
            results.push({
              type: 'tool_result',
              tool_use_id: block.id,
              is_error: true,
              content: 'Your proposed content is identical to the current file, so there is nothing to commit. If the log already reflects what the user asked for, tell them that instead of proposing an update; otherwise make the actual edit.',
            });
            continue;
          }
          pending = {
            newContent,
            commitMessage: block.input.commit_message,
            diff: lineDiff(recsMd.content, newContent),
          };
          results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Prepared and shown to the user for confirmation.' });
        }

        if (pending) {
          const content = text?.text?.trim()
            || 'I’ve prepared the change below — review the diff and hit Commit to save it.';
          return json(200, { content, pending });
        }

        // Every tool call was a no-op or error — let the model correct itself or
        // respond to the user on the next turn.
        msgs.push({ role: 'assistant', content: response.content });
        msgs.push({ role: 'user', content: results });
      }

      return json(200, { content: 'That already looks logged the way you described, so there’s nothing to change.', pending: null });
    } catch (err) {
      console.error('Chat error:', err.message);
      return json(502, { error: err.message || 'Claude API error', logUrl: streamLogUrl(context) });
    }
  }

  return json(404, { error: 'Not found' });
};

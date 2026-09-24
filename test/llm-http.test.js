const assert = require('node:assert/strict');
const test = require('node:test');
const { loadTs } = require('./helpers/load-ts');

const logs = [];
class CancellationError extends Error {}
const vscode = {
  CancellationError,
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  env: { language: 'en' },
  window: { createOutputChannel: () => ({ info: (line) => logs.push(line) }) },
};
const { postJson, sanitizeRemoteMessage } = loadTs('src/llm/http.ts', { vscode });
const originalFetch = global.fetch;
test.afterEach(() => { global.fetch = originalFetch; logs.length = 0; });

function cancellation() {
  const listeners = new Set();
  return {
    isCancellationRequested: false,
    disposed: 0,
    onCancellationRequested(callback) {
      listeners.add(callback);
      return { dispose: () => { listeners.delete(callback); this.disposed++; } };
    },
    cancel() {
      this.isCancellationRequested = true;
      for (const callback of listeners) callback();
    },
  };
}

function request(overrides = {}) {
  return {
    provider: 'gemini', model: 'gemini-3.8-flash', url: 'https://example.test',
    headers: { 'x-goog-api-key': 'top-secret' }, body: { input: 'private essay' },
    token: cancellation(), timeoutMs: 300000, secret: 'top-secret', ...overrides,
  };
}

function pendingFetch(_url, { signal }) {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('posts JSON and returns parsed JSON without logging credentials or essay text', async () => {
  let observed;
  global.fetch = async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const input = request();
  assert.deepEqual(await postJson(input), { ok: true });
  assert.equal(observed.url, 'https://example.test');
  assert.equal(observed.init.method, 'POST');
  assert.equal(new Headers(observed.init.headers).get('content-type'), 'application/json');
  assert.equal(new Headers(observed.init.headers).get('x-goog-api-key'), 'top-secret');
  assert.equal(observed.init.body, '{"input":"private essay"}');
  assert.equal(input.token.disposed, 1);
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs.join('\n'), /top-secret|private essay|x-goog-api-key|https:\/\//);
});

for (const [status, body, kind] of [
  [401, '{"error":{"message":"Key rejected"}}', 'auth'],
  [403, '{"message":"Forbidden"}', 'auth'],
  [429, 'Rate limit reached', 'quota'],
  [404, '{"error":{"message":"Model does not exist"}}', 'model'],
  [400, '{"error":{"message":"Invalid model requested"}}', 'model'],
  [400, '{"error":{"message":"Model gemini-3.8-flash is not available"}}', 'model'],
  [400, '{"error":{"message":"Input exceeds model context length"}}', 'other'],
  [400, '{"error":{"message":"This model supports a maximum context length of 8192 tokens."}}', 'other'],
  [500, 'Server unavailable', 'other'],
]) {
  test(`maps HTTP ${status} (${body}) to ${kind} with request metadata`, async () => {
    global.fetch = async () => new Response(body, { status });
    const input = request();
    await assert.rejects(postJson(input), (error) => {
      assert.equal(error.name, 'LLMError');
      assert.equal(error.kind, kind);
      assert.equal(error.provider, 'gemini');
      assert.equal(error.model, 'gemini-3.8-flash');
      assert.equal(error.status, status);
      assert.equal(error.retryable, false);
      assert.ok(error.message.length < 500);
      return true;
    });
    assert.equal(input.token.disposed, 1);
    assert.doesNotMatch(logs.join('\n'), /Key rejected|Server unavailable|Forbidden/);
  });
}

test('Qwen HTTP 400 Model not exist. is a model error without retaining remote prose', async () => {
  global.fetch = async () => new Response('{"error":{"message":"Model not exist."}}', { status: 400 });
  await assert.rejects(postJson(request({ provider: 'qwen', model: 'qwen-configured-model' })), (error) => {
    assert.equal(error.name, 'LLMError');
    assert.equal(error.kind, 'model');
    assert.equal(error.provider, 'qwen');
    assert.equal(error.model, 'qwen-configured-model');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(JSON.stringify(error), /Model not exist/);
    return true;
  });
});

for (const body of [
  '{"error":{"message":"Rejected top-secret, Bearer abc, sk-secret-key, AIzaSecretGoogleKey123"}}',
  '{"message":"Rejected top-secret, Bearer abc, sk-secret-key, AIzaSecretGoogleKey123"}',
  'Rejected top-secret, Bearer abc, sk-secret-key, AIzaSecretGoogleKey123',
]) {
  test(`redacts credentials from remote error shape ${body.slice(0, 12)}`, async () => {
    global.fetch = async () => new Response(body, { status: 401 });
    await assert.rejects(postJson(request()), (error) => {
      assert.doesNotMatch(error.message, /Rejected/);
      assert.doesNotMatch(error.message, /top-secret|Bearer abc|sk-secret-key|AIzaSecretGoogleKey123/);
      return true;
    });
  });
}

for (const shape of ['nested', 'message', 'plain']) {
  test(`discards echoed private essay text and URLs from ${shape} remote errors`, async () => {
    const remote = 'Rejected private essay fragment at https://example.test/private?token=opaque';
    const body = shape === 'nested' ? JSON.stringify({ error: { message: remote } })
      : shape === 'message' ? JSON.stringify({ message: remote }) : remote;
    global.fetch = async () => new Response(body, { status: 400 });
    await assert.rejects(postJson(request({ body: { input: 'private essay fragment' } })), (error) => {
      assert.equal(error.kind, 'other');
      assert.equal(error.status, 400);
      assert.equal(error.cause, undefined);
      for (const exposed of [error.message, error.stack, JSON.stringify(error), logs.join('\n')]) {
        assert.doesNotMatch(exposed, /private essay fragment|https:\/\/example\.test\/private|opaque|Rejected/);
      }
      return true;
    });
  });
}

test('sanitizer normalizes untrusted text and bounds its length', () => {
  assert.equal(sanitizeRemoteMessage(null), '');
  const result = sanitizeRemoteMessage('Oops\n\u001b[31m Bearer abc sk-secret ' + 'x'.repeat(2000));
  assert.ok(result.length <= 300);
  assert.doesNotMatch(result, /\n|\u001b|Bearer abc|sk-secret/);
});

for (const [header, credential] of [
  ['Authorization', 'Bearer distinct-bearer-credential'],
  ['X-API-KEY', 'distinct-api-key-credential'],
]) {
  test(`redacts a ${header} credential from every diagnostic path when secret is omitted`, async () => {
    global.fetch = async () => new Response('Server error', { status: 500 });
    await assert.rejects(postJson(request({
      headers: { [header]: credential },
      model: credential.replace(/^Bearer\s+/i, ''),
      secret: undefined,
    })), (error) => {
      for (const exposed of [error.message, error.stack, JSON.stringify(error), logs.join('\n')]) {
        assert.doesNotMatch(exposed, new RegExp(credential.replace(/^Bearer\s+/i, '')));
      }
      return true;
    });
  });
}

test('discards invalid successful JSON without surfacing the response body', async () => {
  global.fetch = async () => new Response('private essay top-secret not JSON', { status: 200 });
  await assert.rejects(postJson(request()), (error) => {
    assert.equal(error.kind, 'parse');
    assert.doesNotMatch(error.message, /private essay|top-secret/);
    assert.equal(error.provider, 'gemini');
    return true;
  });
});

test('wraps network failures without exposing fetch error detail', async () => {
  global.fetch = async () => { throw new Error('top-secret private essay in fetch failure'); };
  await assert.rejects(postJson(request()), (error) => {
    assert.equal(error.kind, 'network');
    assert.doesNotMatch(error.message, /top-secret|private essay/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('user cancellation aborts the request and disposes the subscription', async () => {
  global.fetch = pendingFetch;
  const input = request();
  const pending = postJson(input);
  input.token.cancel();
  await assert.rejects(pending, CancellationError);
  assert.equal(input.token.disposed, 1);
});

test('an already cancelled request never reaches fetch', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return new Response('{}'); };
  const input = request();
  input.token.cancel();
  await assert.rejects(postJson(input), CancellationError);
  assert.equal(calls, 0);
});

test('timeout is distinct from user cancellation', async () => {
  global.fetch = pendingFetch;
  const input = request({ timeoutMs: 5 });
  await assert.rejects(postJson(input), (error) => {
    assert.equal(error.kind, 'timeout');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(input.token.disposed, 1);
});

test('user cancellation wins when timeout has already aborted fetch', async () => {
  const input = request({ timeoutMs: 5 });
  global.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      input.token.cancel();
      reject(new Error('network failure after timeout'));
    }, { once: true });
  });
  await assert.rejects(postJson(input), CancellationError);
});

test('user cancellation wins over a concurrently failing network request', async () => {
  const input = request();
  global.fetch = async () => { input.token.cancel(); throw new Error('network failure'); };
  await assert.rejects(postJson(input), CancellationError);
});

test('cancellation also wins while reading a successful response', async () => {
  const input = request();
  global.fetch = async () => ({ ok: true, status: 200, json: async () => {
    input.token.cancel();
    return { ok: true };
  } });
  await assert.rejects(postJson(input), CancellationError);
});

test('stops reading failed bodies at 1000 characters and releases the stream', async () => {
  let reads = 0;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new TextEncoder().encode('x'.repeat(1000)));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 500 });
  await assert.rejects(postJson(request()), (error) => {
    assert.equal(error.kind, 'other');
    assert.ok(error.message.length < 500);
    return true;
  });
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
});

test('clears timeout after a successful request', async () => {
  let signal;
  global.fetch = async (_url, init) => { signal = init.signal; return new Response('{}'); };
  await postJson(request({ timeoutMs: 5 }));
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(signal.aborted, false);
});

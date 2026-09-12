/**
 * Host-half tests: drive the registered route with fake `req`/`res` objects and
 * a fake `llm` service, asserting both the HTTP contract and the model-call
 * arguments.
 *
 * Peer packages (`@deepseek-ai/dsh-llm`) resolve from the profile's
 * node_modules, so run these from the installed package:
 *   node --test <profile>/node_modules/dsh-prompt-tune/test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply, inject, name } from '../lib/index.js'

const OPTIMIZE_PATH = '/dsh-prompt-tune/api/optimize'

/**
 * Build a fake plugin context capturing route registration and model calls.
 * @param options - default-model selection and the chunks the model returns.
 * @returns the context plus its observable state.
 */
function createHost(options = {}) {
  const state = {
    routes: [],
    streams: [],
    disposers: [],
  }
  // `selection: undefined` is itself a case under test (no configured model),
  // so the default applies only when the key is absent.
  const selection = 'selection' in options
    ? options.selection
    : { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const chunks = options.chunks ?? [{ type: 'text-delta', index: 0, text: 'optimized' }]
  const ctx = {
    effect(callback) {
      const dispose = callback()
      state.disposers.push(dispose)
      return dispose
    },
    webServer: {
      register(route) {
        state.routes.push(route)
        return () => {
          const index = state.routes.indexOf(route)
          if (index !== -1) state.routes.splice(index, 1)
        }
      },
    },
    agentDefaultModel: { currentSelection: () => selection },
    llm: {
      stream(callOptions) {
        state.streams.push(callOptions)
        if (options.throws !== undefined) throw options.throws
        return (async function* generate() {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
  return { ctx, state }
}

/**
 * Invoke one route with a streamed request body.
 * @param route - the registered route.
 * @param request - method, url, and raw body.
 * @returns the settled response.
 */
async function callRoute(route, request = {}) {
  const { method = 'POST', url = OPTIMIZE_PATH, body } = request
  const req = Readable.from(body === undefined ? [] : [body])
  req.method = method
  req.url = url
  let settle
  const settled = new Promise((resolve) => {
    settle = resolve
  })
  const res = {
    statusCode: undefined,
    headers: undefined,
    text: undefined,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.text = text
      settle()
    },
  }
  await route.handler(req, res)
  await settled
  let json
  try {
    json = JSON.parse(res.text)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, headers: res.headers, text: res.text, json }
}

/**
 * Mount the plugin and return its single route.
 * @param options - forwarded to {@link createHost}.
 * @returns the route plus the captured host state.
 */
function mount(options) {
  const { ctx, state } = createHost(options)
  apply(ctx)
  assert.equal(state.routes.length, 1)
  return { route: state.routes[0], state }
}

test('declares the services it needs and mounts one namespaced prefix route', () => {
  assert.equal(name, 'dsh-prompt-tune')
  assert.deepEqual([...inject].sort(), ['agentDefaultModel', 'llm', 'webServer'])
  const { route, state } = mount()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dsh-prompt-tune/api')
  assert.equal(typeof route.handler, 'function')
  state.disposers[0]()
  assert.equal(state.routes.length, 0, 'the effect disposer unregisters the route')
})

test('answers 404 for another method or another path', async () => {
  const { route } = mount()
  assert.deepEqual(await callRoute(route, { method: 'GET', url: OPTIMIZE_PATH }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    text: '{"error":"not found"}',
    json: { error: 'not found' },
  })
  assert.equal((await callRoute(route, { url: '/dsh-prompt-tune/api/other', body: '{}' })).status, 404)
})

test('answers 400 for a body that is not JSON', async () => {
  const { route } = mount()
  const response = await callRoute(route, { body: 'not json' })
  assert.equal(response.status, 400)
  assert.deepEqual(response.json, { error: 'invalid JSON body' })
})

test('answers 400 for a missing or blank prompt', async () => {
  const { route, state } = mount()
  for (const body of ['{}', '{"prompt":""}', '{"prompt":"   "}', '{"prompt":42}']) {
    const response = await callRoute(route, { body })
    assert.equal(response.status, 400, body)
    assert.deepEqual(response.json, { error: 'prompt is required' })
  }
  assert.equal(state.streams.length, 0)
})

test('answers 413 for an over-long prompt', async () => {
  const { route, state } = mount()
  const response = await callRoute(route, { body: JSON.stringify({ prompt: 'x'.repeat(20_001) }) })
  assert.equal(response.status, 413)
  assert.match(response.json.error, /longer than 20000 characters/)
  assert.equal(state.streams.length, 0)
})

test('answers 503 when no default model is configured', async () => {
  for (const selection of [undefined, { model: 'deepseek-v4-flash' }, { provider: 'deepseek-official' }]) {
    const { route, state } = mount({ selection })
    const response = await callRoute(route, { body: '{"prompt":"hi"}' })
    assert.equal(response.status, 503)
    assert.deepEqual(response.json, { error: 'no default model is configured' })
    assert.equal(state.streams.length, 0)
  }
})

test('aggregates text deltas and calls the configured model with the fixed contract', async () => {
  const { route, state } = mount({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '  写一个 ' },
      { type: 'text-delta', index: 0, text: '二分查找。  ' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  })
  const response = await callRoute(route, { body: '{"prompt":"写个二分"}' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.json, { optimized: '写一个 二分查找。' })

  assert.equal(state.streams.length, 1)
  const call = state.streams[0]
  assert.equal(call.provider, 'deepseek-official')
  assert.equal(call.model, 'deepseek-v4-flash')
  assert.equal(call.temperature, 0.3)
  assert.equal(call.maxTokens, 2048)
  assert.equal(call.reasoningEffort, 'off')
  assert.ok(call.signal instanceof AbortSignal, 'the call carries a timeout signal')
  assert.match(call.system, /提示词优化助手/)
  assert.match(call.system, /只输出优化后的提示词本身/)
  assert.match(call.system, /不要回答草稿里提出的问题/)

  assert.equal(call.messages.length, 1)
  const [message] = call.messages
  assert.equal(message.role, 'user')
  assert.equal(typeof message.id, 'string', 'the message is built by createUserMessage')
  assert.deepEqual(message.content, [{ type: 'text', text: '写个二分' }])
})

test('honours an explicit reasoning effort from the default selection', async () => {
  const { route, state } = mount({ selection: { provider: 'p', model: 'm', reasoningEffort: 'high' } })
  await callRoute(route, { body: '{"prompt":"hi"}' })
  assert.equal(state.streams[0].reasoningEffort, 'high')
})

test('surfaces a model-reported failure as 500', async () => {
  const { route } = mount({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }],
  })
  const response = await callRoute(route, { body: '{"prompt":"hi"}' })
  assert.equal(response.status, 500)
  assert.deepEqual(response.json, { error: 'provider exploded' })
})

test('surfaces an aborted call as 504', async () => {
  const { route } = mount({
    chunks: [{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } }],
  })
  const response = await callRoute(route, { body: '{"prompt":"hi"}' })
  assert.equal(response.status, 504)
  assert.deepEqual(response.json, { error: 'the model call timed out' })
})

test('surfaces an empty model answer as 502', async () => {
  const { route } = mount({ chunks: [{ type: 'text-delta', index: 0, text: '   ' }] })
  const response = await callRoute(route, { body: '{"prompt":"hi"}' })
  assert.equal(response.status, 502)
  assert.deepEqual(response.json, { error: 'the model returned an empty prompt' })
})

test('surfaces a thrown stream failure as 500', async () => {
  const { route } = mount({ throws: new Error('no such provider route') })
  const response = await callRoute(route, { body: '{"prompt":"hi"}' })
  assert.equal(response.status, 500)
  assert.deepEqual(response.json, { error: 'no such provider route' })
})

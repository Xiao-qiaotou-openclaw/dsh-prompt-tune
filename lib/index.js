/**
 * dsh-prompt-tune — host half.
 *
 * Exposes exactly one endpoint,
 * `POST /dsh-prompt-tune/api/optimize`, which rewrites a draft prompt
 * through the model DSH is already configured with. The browser half
 * (`./client`) owns the composer button; this half owns the model call, so the
 * page never needs credentials of its own.
 *
 * The call reuses the harness building blocks rather than talking to a
 * provider directly: `agentDefaultModel` picks the route, `llm.stream` runs it
 * with the same retry/waterfall path a session request takes.
 *
 * @module dsh-prompt-tune
 */
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-prompt-tune'

/** Registered services this plugin cannot work without. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Route prefix owned by this plugin (namespaced to avoid collisions). */
const ROUTE_PREFIX = '/dsh-prompt-tune/api'

/** The single endpoint under {@link ROUTE_PREFIX}. */
const OPTIMIZE_PATH = `${ROUTE_PREFIX}/optimize`

/** Server-side bound on one model call; the browser stops waiting sooner. */
const REQUEST_TIMEOUT_MS = 60_000

/** Draft length bound, so a pasted document cannot become a silent huge request. */
const MAX_PROMPT_CHARS = 20_000

/** Output bound; an optimized prompt is a prompt, not an essay. */
const MAX_OUTPUT_TOKENS = 2_048

/** Low temperature: rewriting should be stable, not creative. */
const TEMPERATURE = 0.3

/**
 * Fixed instruction. It asks for a rewritten prompt — never an answer to it —
 * because the result is written straight back into the composer.
 */
const SYSTEM_PROMPT = [
  '你是一个提示词优化助手。',
  '把用户给出的提示词草稿改写得更清晰、具体、可执行，保留原意与草稿里已经写明的约束。',
  '只输出优化后的提示词本身：不要解释，不要加任何前后缀，不要用代码块包裹，不要回答草稿里提出的问题。',
].join('\n')

/** Thrown when the model call ends as aborted (including our own timeout). */
class OptimizeAborted extends Error {
  constructor(message) {
    super(message)
    this.name = 'OptimizeAborted'
  }
}

/**
 * Whether one unknown value is an abort-shaped failure.
 * @param error - the value thrown by the model call.
 * @returns true when the call was aborted or timed out.
 */
function isAbort(error) {
  return (
    error instanceof OptimizeAborted
    || (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
}

/**
 * Read a whole request body.
 * @param req - the incoming request.
 * @returns the decoded body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * Answer one request with JSON.
 * @param res - the response owner.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * Aggregate a model stream into the optimized prompt.
 * @param stream - the chunk stream returned by `llm.stream`.
 * @returns the trimmed text of every text block.
 */
async function collectText(stream) {
  let text = ''
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message ?? 'the model call failed')
      }
      if (chunk.reason.kind === 'aborted') {
        throw new OptimizeAborted(chunk.reason.failure?.message ?? 'the model call was aborted')
      }
    }
  }
  return text.trim()
}

/**
 * Validate one request and run the optimization it asks for.
 * @param ctx - the plugin context carrying `llm` and `agentDefaultModel`.
 * @param req - the incoming request.
 * @param res - the response owner.
 */
async function handleOptimize(ctx, req, res) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (req.method !== 'POST' || path !== OPTIMIZE_PATH) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  let prompt
  try {
    prompt = JSON.parse(await readBody(req)).prompt
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' })
    return
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    sendJson(res, 400, { error: 'prompt is required' })
    return
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    sendJson(res, 413, { error: `prompt is longer than ${MAX_PROMPT_CHARS} characters` })
    return
  }

  const selection = ctx.agentDefaultModel?.currentSelection?.()
  if (selection?.provider === undefined || selection?.model === undefined) {
    sendJson(res, 503, { error: 'no default model is configured' })
    return
  }

  try {
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      })],
      system: SYSTEM_PROMPT,
      reasoningEffort: ReasoningEffortId(reasoningEffortOf(selection)),
      temperature: TEMPERATURE,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const optimized = await collectText(stream)
    if (optimized === '') {
      sendJson(res, 502, { error: 'the model returned an empty prompt' })
      return
    }
    sendJson(res, 200, { optimized })
  } catch (error) {
    if (isAbort(error)) {
      sendJson(res, 504, { error: 'the model call timed out' })
      return
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Which reasoning effort the optimization runs at. Optimization is a rewrite,
 * not a reasoning problem, so it stays off unless the configured default
 * names something else explicitly.
 * @param selection - the default model selection.
 * @returns the effort id to request.
 */
function reasoningEffortOf(selection) {
  return typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
    ? selection.reasoningEffort
    : 'off'
}

/**
 * Mount the route for the lifetime of the plugin.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: (req, res) => handleOptimize(ctx, req, res),
    }),
    'dsh-prompt-tune: optimize route',
  )
}

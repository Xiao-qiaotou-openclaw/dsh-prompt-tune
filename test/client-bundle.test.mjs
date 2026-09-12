/**
 * Browser-half tests: load the shipped `client/client.js` through a fake
 * `window.__ModuleLoader__`, then exercise the module contract, the slot
 * registration, the pure control logic, the optimize flow, and the rendered
 * element tree.
 *
 * The harness supplies a minimal React-shaped runtime (createElement plus the
 * three hooks the control uses) instead of the real react/react-dom pair: the
 * control only needs element objects, and a self-contained runtime keeps these
 * tests runnable without a renderer — and without depending on whatever react
 * version a particular profile happens to resolve.
 *
 * Run: node test/client-bundle.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = 'dsh-prompt-tune'
const API_PATH = '/dsh-prompt-tune/api/optimize'
const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')

const ELEMENT_TYPE = Symbol.for('react.element')

/**
 * Compare two hook dependency arrays.
 * @param previous - the previous dependencies, if the hook ran before.
 * @param next - the current dependencies.
 * @returns whether an effect must re-run.
 */
function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return true
  return previous.length !== next.length || previous.some((value, index) => !Object.is(value, next[index]))
}

/**
 * A minimal React-shaped runtime: the element factory and the hooks the
 * control uses, with the same call-order model React relies on.
 * @returns the api object plus render-lifecycle helpers.
 */
function createReactLike() {
  const cells = []
  let cursor = 0

  const createElement = (type, props, ...children) => {
    const content = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
    return {
      $$typeof: ELEMENT_TYPE,
      type,
      key: null,
      ref: null,
      props: {
        ...props === null || props === undefined ? {} : props,
        ...content === undefined ? {} : { children: content },
      },
    }
  }
  const useState = (initial) => {
    const index = cursor++
    if (cells[index] === undefined) {
      cells[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const cell = cells[index]
    return [cell.value, (next) => {
      cell.value = typeof next === 'function' ? next(cell.value) : next
    }]
  }
  const useRef = (initial) => {
    const index = cursor++
    if (cells[index] === undefined) cells[index] = { current: initial }
    return cells[index]
  }
  const useEffect = (effect, deps) => {
    const index = cursor++
    const previous = cells[index]
    if (!depsChanged(previous?.deps, deps)) return
    if (typeof previous?.cleanup === 'function') previous.cleanup()
    const cleanup = effect()
    cells[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }
  }

  return {
    api: { createElement, useState, useRef, useEffect },
    /** Run one render pass: hooks are addressed by call order within it. */
    render(component, props) {
      cursor = 0
      return component(props)
    },
    /** Run every stored effect cleanup (unmount). */
    unmount() {
      for (const cell of cells) {
        if (typeof cell?.cleanup === 'function') cell.cleanup()
      }
      cells.length = 0
    },
  }
}

/** Collect the text of one element subtree. */
function textOf(element) {
  if (typeof element === 'string') return element
  if (element === null || element === undefined || typeof element !== 'object') return ''
  const children = element.props?.children
  if (Array.isArray(children)) return children.map(textOf).join('')
  return textOf(children)
}

/** Find the first descendant (inclusive) produced by one element type. */
function findElement(element, predicate) {
  if (element === null || typeof element !== 'object') return undefined
  // Function components are resolved the way a renderer would, so a predicate
  // can look inside an icon component's output.
  if (typeof element.type === 'function') return findElement(element.type(element.props), predicate)
  if (predicate(element)) return element
  const children = element.props?.children
  const list = Array.isArray(children) ? children : [children]
  for (const child of list) {
    const found = findElement(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

/** The icon name the control currently renders, via the primitives stub. */
function iconOf(button) {
  return findElement(button, (element) => typeof element.props?.['data-icon'] === 'string')?.props['data-icon']
}

// --- bundle loading -------------------------------------------------------

const appendedStyles = []
const previousGlobals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }

globalThis.document = {
  createElement: () => ({ textContent: '', remove() {} }),
  head: {
    appendChild(element) {
      appendedStyles.push(element)
    },
  },
}

test.after(() => {
  globalThis.window = previousGlobals.window
  globalThis.document = previousGlobals.document
  globalThis.fetch = previousGlobals.fetch
})

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
// The bundle is a classic script that only touches `window`, so evaluating the
// shipped bytes is the whole loader contract.
new Function(readFileSync(BUNDLE_PATH, 'utf8')).call(globalThis)

const registration = registrations[0]

/** Icon components standing in for the primitives package. */
function stubPrimitives(h) {
  const make = (name) => (props) => h('svg', { 'data-icon': name, width: props.size, height: props.size })
  return {
    IconSparkle16: make('sparkle'),
    IconRefreshOutline16: make('refresh'),
    IconLoadingOutline16: make('loading'),
  }
}

/**
 * Build the factory's `require`.
 * @param react - the React-shaped runtime handed to the bundle.
 * @returns the require function plus the recorded specifier list.
 */
function makeFactoryRequire(react) {
  const requested = []
  const factoryRequire = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives(react.createElement)
    throw new Error(`client bundle required an unexpected module: ${specifier}`)
  }
  return { factoryRequire, requested }
}

/**
 * Materialize the plugin exports over a fresh runtime.
 * @returns the exports, the runtime, and the requested specifiers.
 */
function materialize() {
  const runtime = createReactLike()
  const { factoryRequire, requested } = makeFactoryRequire(runtime.api)
  return { plugin: registration.factory(factoryRequire), runtime, requested }
}

/** A client context capturing effects and slot registrations. */
function createClientContext() {
  const state = { effects: [], injected: [], registered: [] }
  const ctx = {
    effect(callback, label) {
      const dispose = callback()
      state.effects.push({ label, dispose })
      return dispose
    },
    slots: {
      inject(slot, callback) {
        state.injected.push(slot)
        callback()
      },
      register(options, component) {
        state.registered.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, state }
}

/** Install a fetch stub and return its call log. */
function stubFetch(response) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return response
  }
  return calls
}

/** One successful host response. */
function okResponse(optimized) {
  return { ok: true, status: 200, json: async () => ({ optimized }) }
}

// --- module contract ------------------------------------------------------

test('registers under the package name and requires only platform seed modules', () => {
  assert.equal(registration.id, PACKAGE_NAME, 'the module id must be the package name')
  assert.equal(typeof registration.factory, 'function')
  const { plugin, requested } = materialize()
  assert.equal(plugin.name, PACKAGE_NAME)
  assert.deepEqual(plugin.inject, ['slots'])
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(requested, ['react', '@deepseek-ai/dsh-client-ui-primitives'])
  assert.equal(plugin.__internals.API_PATH, API_PATH)
})

test('seats the control in the composer tool row and owns its keyframes', () => {
  const { plugin } = materialize()
  const { ctx, state } = createClientContext()
  const stylesBefore = appendedStyles.length
  plugin.apply(ctx)

  assert.deepEqual(state.injected, ['conversation.input.left'])
  assert.equal(state.registered.length, 1)
  assert.equal(state.registered[0].options.name, 'conversation.input.left')
  assert.equal(state.registered[0].options.id, PACKAGE_NAME)
  assert.equal(typeof state.registered[0].options.order, 'number')
  assert.equal(state.registered[0].component, plugin.__internals.PromptTuneButton)

  assert.equal(appendedStyles.length, stylesBefore + 1)
  assert.match(appendedStyles.at(-1).textContent, /@keyframes dsh-prompt-tune-spin/)
  for (const effect of state.effects) effect.dispose()
})

// --- control logic --------------------------------------------------------

test('buttonMode covers loading, undo, optimize, and disabled', () => {
  const { buttonMode } = materialize().plugin.__internals
  assert.equal(buttonMode('loading', 'anything', 'plain'), 'loading')
  assert.equal(buttonMode('optimized', 'anything', 'plain'), 'undo')
  assert.equal(buttonMode('idle', 'a draft', 'plain'), 'optimize')
  assert.equal(buttonMode('idle', '   ', 'plain'), 'disabled')
  assert.equal(buttonMode('idle', '', 'plain'), 'disabled')
  assert.equal(buttonMode('idle', 'a draft', 'submitting'), 'disabled')
  assert.equal(buttonMode('idle', 'a draft', 'claimed'), 'disabled')
})

test('optimizeDraft writes the result back only while the draft is unchanged', async () => {
  const { optimizeDraft } = materialize().plugin.__internals
  let draft = 'original'
  const written = []
  const result = await optimizeDraft({
    prompt: 'original',
    readDraft: () => draft,
    applyDraft: (text) => written.push(text),
    request: async () => 'optimized',
    timeoutMs: 1000,
  })
  assert.deepEqual(result, { status: 'applied', optimized: 'optimized' })
  assert.deepEqual(written, ['optimized'])

  draft = 'typed while waiting'
  const superseded = await optimizeDraft({
    prompt: 'original',
    readDraft: () => draft,
    applyDraft: (text) => written.push(text),
    request: async () => 'optimized',
    timeoutMs: 1000,
  })
  assert.deepEqual(superseded, { status: 'superseded' })
  assert.equal(written.length, 1, 'a stale result never overwrites the newer draft')
})

test('optimizeDraft reports a failed request without touching the draft', async () => {
  const { optimizeDraft } = materialize().plugin.__internals
  const written = []
  const result = await optimizeDraft({
    prompt: 'original',
    readDraft: () => 'original',
    applyDraft: (text) => written.push(text),
    request: async () => {
      throw new Error('no default model is configured')
    },
    timeoutMs: 1000,
  })
  assert.deepEqual(result, { status: 'failed', message: 'no default model is configured' })
  assert.deepEqual(written, [])
})

test('optimizeDraft aborts a hanging request at its own timeout', async () => {
  const { optimizeDraft } = materialize().plugin.__internals
  let aborted = false
  const result = await optimizeDraft({
    prompt: 'original',
    readDraft: () => 'original',
    applyDraft: () => assert.fail('a timed-out attempt must not write'),
    request: (prompt, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true
        reject(new Error('aborted'))
      })
    }),
    timeoutMs: 10,
  })
  assert.equal(aborted, true, 'the client controller aborted the request')
  assert.deepEqual(result, { status: 'failed', message: '优化请求超时' })
})

// --- rendered control -----------------------------------------------------

/**
 * Render the control through the registered seat, the way the shell renders it:
 * the seat selects the draft from the session's `useInput` snapshot, writes
 * through `inputActions.setDraft`, and the element it returns is then rendered
 * (a real renderer performs that same step).
 * @param runtime - the hook runtime.
 * @param plugin - the materialized plugin exports.
 * @param live - returns the current input snapshot.
 * @param inputActions - the composer actions.
 * @returns the rendered control element.
 */
function renderControl(runtime, plugin, live, inputActions) {
  const seat = runtime.render(plugin.__internals.PromptTuneButton, {
    useInput: (selector) => selector(live()),
    inputActions,
  })
  assert.equal(
    seat.type,
    plugin.__internals.PromptTuneControl,
    'the seat hands the control the values the session provide gave it',
  )
  return runtime.render(seat.type, seat.props)
}

test('the seat selects the draft from the standard session useInput hook', () => {
  const { plugin, runtime } = materialize()
  const state = { draft: '写个二分', phase: 'plain' }
  const selected = []
  const seat = runtime.render(plugin.__internals.PromptTuneButton, {
    useInput: (selector) => {
      const value = selector(state)
      selected.push(value)
      return value
    },
    inputActions: { setDraft() {} },
  })
  assert.equal(selected.length, 1, 'the seat reads the input snapshot through useInput')
  assert.equal(selected[0], state)
  assert.equal(seat.type, plugin.__internals.PromptTuneControl)
  assert.equal(seat.props.draft, '写个二分')
  assert.equal(seat.props.phase, 'plain')
  assert.equal(typeof seat.props.setDraft, 'function')
})

test('the seat renders nothing without a session input binding', () => {
  const { plugin, runtime } = materialize()
  const Button = plugin.__internals.PromptTuneButton
  assert.equal(runtime.render(Button, {}), null)
  assert.equal(runtime.render(Button, { useInput: (selector) => selector({ draft: 'x' }) }), null)
})

test('renders an idle control: disabled while empty, enabled with a draft', () => {
  const { plugin, runtime } = materialize()
  const inputActions = { setDraft() {} }

  const empty = renderControl(runtime, plugin, () => ({ draft: '', phase: 'plain' }), inputActions)
  assert.equal(empty.type, 'button')
  assert.equal(empty.props.disabled, true)
  assert.equal(empty.props['data-dsh-prompt-tune'], 'disabled')
  assert.equal(empty.props['aria-label'], '优化提示词')

  const ready = renderControl(runtime, plugin, () => ({ draft: '写一个二分查找', phase: 'plain' }), inputActions)
  assert.equal(ready.props.disabled, false)
  assert.equal(ready.props['data-dsh-prompt-tune'], 'optimize')
  assert.equal(ready.props['aria-label'], '优化提示词')
  assert.equal(iconOf(ready), 'sparkle')

  const busy = renderControl(runtime, plugin, () => ({ draft: '写一个二分查找', phase: 'submitting' }), inputActions)
  assert.equal(busy.props.disabled, true)
  assert.equal(busy.props['data-dsh-prompt-tune'], 'disabled')
})

test('a click optimizes the draft, then a second click restores it', async () => {
  const { plugin, runtime } = materialize()
  const written = []
  const state = { draft: '写个二分查找', phase: 'plain' }
  const inputActions = {
    setDraft(text) {
      written.push(text)
      state.draft = text
    },
  }
  const live = () => state
  const calls = stubFetch(okResponse('请写一个二分查找函数，并说明边界条件。'))
  try {
    let control = renderControl(runtime, plugin, live, inputActions)
    assert.equal(control.props['data-dsh-prompt-tune'], 'optimize')

    const optimizing = control.props.onClick()
    assert.equal(calls.length, 1, 'the request is issued without waiting for a render')
    assert.equal(calls[0].url, API_PATH)
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(calls[0].init.body), { prompt: '写个二分查找' })

    control = renderControl(runtime, plugin, live, inputActions)
    assert.equal(control.props['data-dsh-prompt-tune'], 'loading')
    assert.equal(control.props.disabled, true)
    assert.equal(iconOf(control), 'loading')

    await optimizing
    assert.deepEqual(written, ['请写一个二分查找函数，并说明边界条件。'])
    control = renderControl(runtime, plugin, live, inputActions)
    assert.equal(control.props['data-dsh-prompt-tune'], 'undo')
    assert.equal(control.props['aria-label'], '撤回优化')
    assert.equal(iconOf(control), 'refresh')

    control.props.onClick()
    assert.deepEqual(written, ['请写一个二分查找函数，并说明边界条件。', '写个二分查找'])
    control = renderControl(runtime, plugin, live, inputActions)
    assert.equal(control.props['data-dsh-prompt-tune'], 'optimize')
  } finally {
    globalThis.fetch = previousGlobals.fetch
  }
})

test('a draft edited while optimizing is never overwritten', async () => {
  const { plugin, runtime } = materialize()
  const written = []
  const state = { draft: 'original', phase: 'plain' }
  const inputActions = { setDraft: (text) => written.push(text) }
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  globalThis.fetch = async () => {
    await gate
    return okResponse('optimized')
  }
  try {
    const control = renderControl(runtime, plugin, () => state, inputActions)
    const optimizing = control.props.onClick()
    state.draft = 'typed while waiting'
    // React would re-render on the keystroke that changed the draft; the harness
    // models that pass explicitly.
    renderControl(runtime, plugin, () => state, inputActions)
    release()
    await optimizing
    assert.deepEqual(written, [], 'the stale result is dropped')
    const after = renderControl(runtime, plugin, () => state, inputActions)
    assert.equal(after.props['data-dsh-prompt-tune'], 'optimize', 'the control returns to idle')
  } finally {
    globalThis.fetch = previousGlobals.fetch
  }
})

test('a failed request keeps the draft and surfaces the reason on the control', async () => {
  const { plugin, runtime } = materialize()
  const written = []
  const state = { draft: '写个二分查找', phase: 'plain' }
  const inputActions = { setDraft: (text) => written.push(text) }
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({ error: 'no default model is configured' }),
  })
  try {
    const control = renderControl(runtime, plugin, () => state, inputActions)
    await control.props.onClick()
    assert.deepEqual(written, [], 'a failure never writes to the composer')
    const after = renderControl(runtime, plugin, () => state, inputActions)
    assert.equal(after.props['data-dsh-prompt-tune'], 'optimize')
    assert.equal(after.props.title, '优化提示词失败：no default model is configured')
    assert.match(String(after.props.style.color), /label-error/)
    runtime.unmount() // clears the failure-notice timer this render armed
  } finally {
    globalThis.fetch = previousGlobals.fetch
  }
})

test('a click on the disabled control performs no request', async () => {
  const { plugin, runtime } = materialize()
  const calls = stubFetch(okResponse('never used'))
  try {
    const control = renderControl(
      runtime,
      plugin,
      () => ({ draft: '   ', phase: 'plain' }),
      { setDraft() {} },
    )
    assert.equal(control.props.disabled, true)
    await control.props.onClick()
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = previousGlobals.fetch
  }
})

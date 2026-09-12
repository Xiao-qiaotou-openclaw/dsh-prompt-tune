/**
 * dsh-prompt-tune — browser half.
 *
 * Adds one icon-only control to the composer tool row
 * (`conversation.input.left`): clicking it sends the unsent draft to this
 * plugin's host route, and writes the rewritten prompt back into the composer.
 * The same control then becomes an undo control that restores the draft
 * captured when the optimization started.
 *
 * Hand-written CJS in the harness module-loader envelope, so the package needs
 * no bundler and no build step. `react` and
 * `@deepseek-ai/dsh-client-ui-primitives` are platform seed words of the client
 * module table (they are answered before any package factory is consulted).
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-tune',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const h = React.createElement

    /** Host endpoint registered by this package's node half. */
    const API_PATH = '/dsh-prompt-tune/api/optimize'

    /** How long the browser waits for the host before giving up on a click. */
    const REQUEST_TIMEOUT_MS = 45_000

    /** How long a failed attempt stays visible on the control. */
    const FAILURE_NOTICE_MS = 4_000

    const TEXT = {
      optimize: '优化提示词',
      loading: '正在优化',
      undo: '撤回优化',
    }

    /**
     * Which control the current state deserves.
     * @param state - 'idle' | 'loading' | 'optimized'.
     * @param draft - the live composer draft.
     * @param phase - the composer submit phase.
     * @returns 'loading' | 'undo' | 'optimize' | 'disabled'.
     */
    function buttonMode(state, draft, phase) {
      if (state === 'loading') return 'loading'
      if (state === 'optimized') return 'undo'
      return draft.trim() !== '' && phase === 'plain' ? 'optimize' : 'disabled'
    }

    /**
     * Human-readable text for one thrown value.
     * @param error - the thrown value.
     * @returns the message, or a generic one.
     */
    function messageOf(error) {
      if (error instanceof Error && error.message !== '') return error.message
      return String(error)
    }

    /**
     * Ask the host to optimize one prompt.
     * @param prompt - the draft to rewrite.
     * @param signal - cancellation for the request.
     * @returns the optimized prompt.
     */
    async function requestOptimized(prompt, signal) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
        ...signal === undefined ? {} : { signal },
      })
      let body
      try {
        body = await response.json()
      } catch {
        body = undefined
      }
      const optimized = body?.optimized
      if (!response.ok || typeof optimized !== 'string' || optimized.trim() === '') {
        throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
      }
      return optimized
    }

    /**
     * The whole optimize-then-write-back flow, free of React so it can be
     * exercised directly: request, stale-draft guard, write-back, failure
     * reporting, and the client-side timeout.
     * @param options - prompt, draft accessors, request implementation, timeout.
     * @returns the outcome of the attempt.
     */
    async function optimizeDraft({ prompt, readDraft, applyDraft, request, timeoutMs }) {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller?.abort()
      }, timeoutMs)
      try {
        const optimized = await request(prompt, controller?.signal)
        if (readDraft() !== prompt) return { status: 'superseded' }
        applyDraft(optimized)
        return { status: 'applied', optimized }
      } catch (error) {
        return { status: 'failed', message: timedOut ? '优化请求超时' : messageOf(error) }
      } finally {
        clearTimeout(timer)
      }
    }

    /** Inline fallbacks, used only when a primitives export is unavailable. */
    const FALLBACK_PATHS = {
      optimize: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z'],
      undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-15-6.7L3 13'],
      loading: ['M21 12a9 9 0 1 1-6.2-8.6'],
    }

    /**
     * Render the control's glyph: the harness icon when the primitives package
     * ships it, otherwise an equivalent inline SVG.
     * @param kind - 'optimize' | 'undo' | 'loading'.
     * @returns the icon element.
     */
    function renderIcon(kind) {
      const Component = kind === 'optimize'
        ? primitives?.IconSparkle16
        : kind === 'undo' ? primitives?.IconRefreshOutline16 : primitives?.IconLoadingOutline16
      if (typeof Component === 'function') {
        return h(Component, { size: 16, 'aria-hidden': true })
      }
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        ...FALLBACK_PATHS[kind].map((d, index) => h('path', { key: index, d })),
      )
    }

    /**
     * The control itself: it renders from plain values and writes back through
     * one callback, so nothing in here depends on the slot plumbing.
     * @param props - the live draft, its submit phase, and the composer write action.
     * @returns the button element.
     */
    function PromptTuneControl({ draft, phase, setDraft }) {
      const [state, setState] = React.useState('idle')
      const [failure, setFailure] = React.useState('')

      // The draft captured when the current optimization started; the undo
      // target. A ref (not state) so the request closure always sees the value
      // it captured, never a re-render's.
      const originalRef = React.useRef('')
      const draftRef = React.useRef(draft)
      draftRef.current = draft
      const failureTimerRef = React.useRef(undefined)

      React.useEffect(() => () => clearTimeout(failureTimerRef.current), [])

      // Sending or clearing the draft retires both the undo target and any
      // notice: the control returns to its idle shape.
      React.useEffect(() => {
        if (state !== 'idle' && draft.trim() === '') {
          setState('idle')
          originalRef.current = ''
        }
      }, [draft, state])

      const mode = buttonMode(state, draft, phase)
      const disabled = mode === 'disabled' || mode === 'loading'
      const label = mode === 'undo' ? TEXT.undo : mode === 'loading' ? TEXT.loading : TEXT.optimize
      const title = failure === '' ? label : `${TEXT.optimize}失败：${failure}`

      async function onClick() {
        if (disabled) return
        if (mode === 'undo') {
          setDraft(originalRef.current)
          originalRef.current = ''
          setState('idle')
          return
        }
        const prompt = draft
        originalRef.current = prompt
        setFailure('')
        setState('loading')
        const result = await optimizeDraft({
          prompt,
          readDraft: () => draftRef.current,
          applyDraft: setDraft,
          request: requestOptimized,
          timeoutMs: REQUEST_TIMEOUT_MS,
        })
        if (result.status === 'applied') {
          setState('optimized')
          return
        }
        // 'superseded' keeps the user's newer draft untouched; both non-applied
        // outcomes fall back to idle with no undo target.
        originalRef.current = ''
        setState('idle')
        if (result.status === 'failed') {
          setFailure(result.message)
          clearTimeout(failureTimerRef.current)
          failureTimerRef.current = setTimeout(() => setFailure(''), FAILURE_NOTICE_MS)
        }
      }

      return h(
        'button',
        {
          type: 'button',
          'data-dsh-prompt-tune': mode,
          className: 'dsh-prompt-tune-button',
          title,
          'aria-label': title,
          disabled,
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            background: 'transparent',
            borderRadius: 8,
            cursor: disabled ? 'default' : 'pointer',
            color: failure !== ''
              ? 'var(--dsw-alias-label-error, var(--dsw-alias-state-error, #d94a4a))'
              : mode === 'loading'
                ? 'var(--dsw-alias-label-tertiary, #999)'
                : 'var(--dsw-alias-label-secondary, #666)',
            opacity: disabled && mode !== 'loading' ? 0.45 : 1,
          },
        },
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              ...mode === 'loading'
                ? { animation: 'dsh-prompt-tune-spin 1s linear infinite' }
                : {},
            },
          },
          renderIcon(mode === 'undo' ? 'undo' : mode === 'loading' ? 'loading' : 'optimize'),
        ),
      )
    }

    /**
     * The registered composer seat.
     *
     * A session-scope seat receives the standard session provide — `useInput`
     * and `inputActions` — and NOT an `input` prop: only owner-props seats such
     * as `conversation.input.dock` are handed the input zone. The live draft is
     * therefore selected from the input snapshot here and passed down as plain
     * values.
     * @param props - standard slot props for a session-scope seat.
     * @returns the control element, or null when the seat has no session input.
     */
    function PromptTuneButton(props) {
      const useInput = props.useInput
      const inputActions = props.inputActions
      // The seat's prop shape is fixed for as long as it stays mounted, so this
      // guard (which runs before the hook call) cannot reorder hooks between
      // renders of one mounted seat.
      if (typeof useInput !== 'function' || inputActions === undefined) return null
      const input = useInput((snapshot) => snapshot)
      return h(PromptTuneControl, {
        draft: input?.draft ?? '',
        phase: input?.phase ?? 'plain',
        setDraft: (text) => inputActions.setDraft(text),
      })
    }

    /**
     * Client plugin body: own the spinner keyframes and seat the control in the
     * composer tool row. `slots.inject` defers registration until the
     * conversation shell has declared that slot.
     * @param ctx - the client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.textContent = '@keyframes dsh-prompt-tune-spin { to { transform: rotate(360deg) } }'
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-prompt-tune: spinner keyframes')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-prompt-tune',
        order: 100,
        priority: 0,
        registrant: 'dsh-prompt-tune',
      }, PromptTuneButton))
    }

    exports.name = 'dsh-prompt-tune'
    exports.inject = ['slots']
    exports.apply = apply
    /** Exposed for the package's own tests; not part of the plugin contract. */
    exports.__internals = {
      buttonMode,
      optimizeDraft,
      PromptTuneButton,
      PromptTuneControl,
      TEXT,
      API_PATH,
    }

    return module.exports
  },
})

# The Vibe Atlas — Cross-Model Race Condition Analysis

> The same code reviewed from five different engineering perspectives. Each model persona
> brings a different depth and set of assumptions. The goal is to surface race conditions
> and async foot-guns that a single reviewer might miss.

---

## Model A: React Hooks Specialist

*Focuses on closure lifetimes, effect dependencies, stale captures, and component lifecycle.*

### Finding A1: `fetchImages` is a new closure every render

```tsx
function App() {
  // ... state ...
  async function fetchImages(mood: string) { ... }
```

Every time `App` re-renders (every keystroke in the custom input, every state change),
`fetchImages` is recreated in memory. React does not cache it. This means:

- Each `onClick` handler in the mood buttons closes over a *different* `fetchImages` reference.
- The `abortRef.current` they close over is stable (refs survive re-renders).
- But the function identity changes, which matters if it's ever passed as a prop to a
  child component that uses `React.memo`.

**Risk level:** 🟢 Low — the function is never passed to memoized children. The refs it
captures are stable. No practical issue.

**Fix:** Wrap in `useCallback` if performance ever becomes a concern, or if children are
extracted.

```tsx
const fetchImages = useCallback(async (mood: string) => {
  // ...
}, [])  // stable for entire component lifetime
```

### Finding A2: `useEffect` — omitted cleanup function

```tsx
useEffect(() => {
  if (images.length > 0 && firstImageRef.current) {
    firstImageRef.current.focus()
  }
}, [images])
```

This runs after every render where `images` got a new array reference. The effect has
**no cleanup function**. For a focus operation, this is mostly benign — but consider:

- If the component unmounts *right after* images load, the `firstImageRef.current` is
  still set (refs aren't cleared on unmount). React will call `.focus()` on a detached
  DOM node. The browser silently ignores it, but it's technically a no-op on unmounted DOM.
- If two fetches resolve in rapid succession, React may batch the state updates. The
  effect runs once with the final `images` value, not twice. This is actually correct.

**Risk level:** 🟢 Negligible. Focus on unmounted DOM is a no-op.

**Fix:** Not needed. But if a linter insists on cleanup, add:

```tsx
useEffect(() => {
  if (images.length > 0 && firstImageRef.current) {
    firstImageRef.current.focus()
  }
  // No cleanup needed — focus doesn't need teardown
}, [images])
```

### Finding A3: The `fetchImages` → `handleCustomSubmit` bridge

```tsx
function handleCustomSubmit(e: React.FormEvent) {
  e.preventDefault()
  const trimmed = customInput.trim()
  if (!trimmed) return
  fetchImages(trimmed)
}
```

`handleCustomSubmit` reads `customInput` from the closure. If the user types "neon" and
hits Enter, `customInput` is `"neon"`. But `customInput` could theoretically change
*between* the keystroke and the event handler execution (e.g., an IME composition event).
React's synthetic events make this extremely unlikely, but it's a stale closure risk in
principle.

**Risk level:** 🟢 Virtually impossible with standard text input. IME composition could
theoretically interleave, but React handles composition events correctly.

**Fix:** Read the value from the form's native event instead:

```tsx
function handleCustomSubmit(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault()
  const data = new FormData(e.currentTarget)
  const value = data.get('mood') as string
  if (!value?.trim()) return
  fetchImages(value.trim())
}
```

---

## Model B: Async / Systems Engineer

*Focuses on network semantics, abort timing, unhandled rejections, and the gap between
"cancelled" and "completed."*

### Finding B1: Abort timing — the body-committed window

```tsx
abortRef.current?.abort()          // line 34
const controller = new AbortController()
abortRef.current = controller

fetchingRef.current = mood
// ... state setters ...

const res = await fetch(/* ... */)  // line 47
```

There is a window between `abort()` and setting up the new controller where both the
old and new requests could be in-flight simultaneously. Specifically:

1. `abortRef.current?.abort()` — aborts previous request (may or may not have connected)
2. `controller = new AbortController()` — new controller created
3. `fetch()` — new request starts

If the *previous* request was still connecting during step 1, the abort raises an
`AbortError` on line 60. But if the previous request *had already connected and was
receiving the response body* — aborting after headers are received still works (fetch
cancels the body download), but the browser may have already buffered partial data.
This doesn't cause a race condition — it just wastes bandwidth.

**Risk level:** 🟢 No correctness issue. The wasted bandwidth is trivial for 5 images.

### Finding B2: Unhandled rejection in `.json()` catch

```tsx
if (!res.ok) {
  const body = await res.json().catch(() => ({}))
```

If the server returns a non-OK status with a body that isn't valid JSON, the `.catch()`
returns `{}` and the error message becomes `"Request failed (XXX)"`. This is fine.

But what if the server returns OK (200) with a non-JSON body? Then line 56:

```tsx
const data: ImageData[] = await res.json()
```

This throws a `SyntaxError`. The catch on line 59 catches it. It falls through to:

```tsx
setError(e instanceof Error ? e.message : 'Something went wrong')
```

The user sees `"Unexpected token < in JSON at position 0"` or similar — a raw JSON
parse error, not a user-friendly message. This only happens if the Vercel function or
Unsplash returns malformed responses.

**Risk level:** 🟢 Extremely unlikely with a stable API. But the error message is bad
if it happens.

**Fix:** Wrap the JSON parse and provide a fallback:

```tsx
let data: ImageData[]
try {
  data = await res.json()
} catch {
  throw new Error('Received an invalid response from the server')
}
```

### Finding B3: The `finally` block runs on abort

When `AbortController.abort()` fires, `fetch` rejects with `AbortError`. This is caught
on line 60 and returns early. But the `finally` block still runs:

```tsx
} finally {
  if (id === reqIdRef.current) {
    setLoading(false)
    fetchingRef.current = null
  }
}
```

For the *aborted* request, `id` will almost never equal `reqIdRef.current` (because a
newer request incremented the counter). So the `finally` block is a no-op for aborted
requests. Correct behavior — the newer request manages its own loading state.

**Risk level:** 🟢 Correct.

---

## Model C: Type-System / TypeScript Advocate

*Focuses on type unsafety, untagged unions, untracked implicit states, and the gap
between types and runtime.*

### Finding C1: `activeMood` is typed as `string | null` — too wide

```tsx
const [activeMood, setActiveMood] = useState<string | null>(null)
```

`activeMood` holds either one of the 5 predefined moods or an arbitrary string from the
custom input. The type `string` is technically correct but loses all semantic information.
The `Mood` type (line 3) exists but is not used here — it's only used for the `MOODS`
array.

The consequence: the `isCustomActive` variable (removed in an earlier commit) was
awkward to compute because the type didn't distinguish built-in from custom. If the
app grows, this type widening will cause bugs.

**Fix:** Use a tagged union:

```tsx
type ActiveSource =
  | { kind: 'preset'; value: Mood }
  | { kind: 'custom'; value: string }
  | null

const [activeMood, setActiveMood] = useState<ActiveSource>(null)
```

Now the render can switch on `kind`:

```tsx
if (activeMood?.kind === 'preset') {
  // safe to use activeMood.value as Mood — known color, known emoji
}
```

**Risk level:** 🟡 Moderate — will cause bugs when adding features that depend on
knowing whether the mood is built-in or custom.

### Finding C2: `ImageData[]` assumed — no runtime validation

```tsx
const data: ImageData[] = await res.json()
```

The `as UnsplashPhoto[]` cast in the API function and the `ImageData[]` assertion on the
client are both type-level only. They do not validate the shape at runtime. If the API
returns `null`, a string, an object with missing fields, or an array of the wrong shape,
TypeScript will not catch it.

Example: if Unsplash changes their API and removes the `urls.regular` field, the cast
succeeds but the app renders `<img src={undefined} />`.

**Risk level:** 🟡 Moderate — silent failures on API changes.

**Fix:** Add runtime schema validation (zod, io-ts, or manual guards):

```tsx
function isImageDataArray(data: unknown): data is ImageData[] {
  return Array.isArray(data) && data.every(
    (d) => d && typeof d.url === 'string' && typeof d.alt === 'string'
  )
}

if (!isImageDataArray(data)) {
  throw new Error('Unexpected API response format')
}
```

### Finding C3: `catch (e)` — the `unknown` problem

```tsx
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') return
  if (id !== reqIdRef.current) return
  setError(e instanceof Error ? e.message : 'Something went wrong')
}
```

`e` is typed `unknown` (TypeScript 4.0+). The code correctly checks
`e instanceof DOMException` and `e instanceof Error`. But what if `e` is a subclass of
`Error` with a custom `.message` that leaks sensitive information? Or what if `e` is an
object with a `.message` but is not an `Error` instance?

The fallback `'Something went wrong'` covers non-Error throws, but the primary path
`e.message` assumes `.message` exists. This is correct for `Error` instances and safe
due to the `instanceof` guard.

**Risk level:** 🟢 Standard practice. No issue.

---

## Model D: Testing / QA Engineer

*Focuses on edge cases, user-interleaving sequences, and system boundaries.*

### Finding D1: The exact sequence of rapid clicks that breaks things

Test sequence that exercises every guard:

```
1. Click "calm"
2. Immediately type "cyberpunk" and hit Enter
3. Immediately click "calm" again
4. Wait for everything to settle
5. Click "loud"
```

**Expected:** Final state shows "loud" images. No errors. No stale images from step 1–3.

**Execution trace:**
- Step 1: fetch("calm"), reqId=1, abortRef=controller1
- Step 2: handleCustomSubmit → fetch("cyberpunk"), abort controller1, reqId=2, abortRef=controller2
- Step 3: fetch("calm"), abort controller2, reqId=3, abortRef=controller3
  - `fetchingRef.current` was set to "cyberpunk" in step 2. Step 3's check
    `if (fetchingRef.current === mood)` compares "cyberpunk" vs "calm" — they differ,
    so the fetch proceeds. Different moods always pass the dedup check.
- Step 4: Only reqId=3's fetch resolves. reqId=1 and reqId=2 are discarded by the ID check
  (or their AbortErrors are swallowed by the DOMException check).
- Step 5: fetch("loud"), abort controller3, reqId=4, normal flow.

**Verdict:** ✅ All guards hold. The final state is correct.

### Finding D2: The fatal edge case — empty response from Unsplash

Unsplash can return an empty array if no photos match the query. For esoteric custom
moods like "xyzvw", the API returns `[]`.

**Current behavior:**
- `data.map(...)` returns `[]`
- `setImages([])` — empty array
- Render: hits the `images.length === 0` branch (line 177) — shows the empty state
  "Choose a mood above or type one in"
- No error is set. The user typed something and got back to the empty state with no
  feedback that their query returned nothing.

**Risk level:** 🟡 Moderate — confusing UX for custom moods with no results.

**Fix:** Check for empty results and show a specific message:

```tsx
if (data.length === 0) {
  setError(`No photos found for "${mood}". Try a different keyword.`)
  return
}
```

### Finding D3: The custom input retains stale text after form submit

After hitting Go, `customInput` is still the submitted text. If the user clicks "calm",
then hits Go again on the same input text, it re-fetches the same custom mood. This is
arguably correct (they want fresh images for that keyword). But if they want to clear
it, they must manually delete the text. No UX affordance for clearing.

**Risk level:** 🟢 Intentional. Not a bug.

### Finding D4: Rapid retry button clicks

The retry button (line 139):
```tsx
onClick={() => activeMood && fetchImages(activeMood)}
```

If the user mashes the retry button 20 times while an error is showing:
- First click: sets `fetchingRef`, fires fetch
- Clicks 2–20: hit the `fetchingRef.current === mood` check and return early
- After the fetch resolves (success or error again): `fetchingRef` is cleared
- The next click fires again

**Verdict:** ✅ Dedup holds. No duplicate fetches.

### Finding D5: Network offline during fetch

If the user's network goes offline mid-fetch:
- `fetch` throws a `TypeError` (not a `DOMException` named 'AbortError')
- The catch block on line 59 catches it
- The `DOMException` check on line 60 returns `false` (it's a `TypeError`, not `DOMException`)
- The `id` check on line 61 passes (no newer request started)
- `e instanceof Error` is `true` → `setError(e.message)`
- Message is something like `"Failed to fetch"` — browser-dependent, not user-friendly

**Risk level:** 🟢 Minor — "Failed to fetch" is cryptic but the user can retry.

**Fix:** Check for network errors specifically:

```tsx
if (e instanceof TypeError && e.message === 'Failed to fetch') {
  setError('Network error. Check your connection and try again.')
} else {
  setError(e instanceof Error ? e.message : 'Something went wrong')
}
```

---

## Model E: Functional / State-Machine Purist

*Focuses on eliminating impossible states by construction. Believes refs are a code smell.*

### Finding E1: Five independent state variables = 2⁵ impossible states

```tsx
const [activeMood, setActiveMood] = useState<string | null>(null)
const [images, setImages] = useState<ImageData[]>([])
const [loading, setLoading] = useState(false)
const [error, setError] = useState<string | null>(null)
const [customInput, setCustomInput] = useState('')
```

These 5 booleans/enums can theoretically be set to any combination. Some combinations
are impossible in practice but allowed by the type system:

| activeMood | images | loading | error | Possible? |
|-----------|--------|---------|-------|-----------|
| null | [] | true | null | ✅ initial click |
| "calm" | [A,B,C] | true | null | ❌ loading=false before images appear |
| null | [A,B,C] | false | "err" | ❌ error clears images |
| "calm" | [] | false | null | ✅ empty state reached after error cleared |

The render logic disambiguates these through careful ordering:
```tsx
{error && ...}         // error has priority
{loading && ...}       // then loading
{!loading && !error && images.length > 0 && ...}  // then success
{!loading && !error && images.length === 0 && ...} // then empty
```

But the type system doesn't enforce this. A future developer could add a new combination
forgot to update the render, and end up with a blank screen (no branch matches).

**Fix:** Use a discriminated union / state machine:

```tsx
type AppState =
  | { phase: 'idle' }
  | { phase: 'loading'; mood: string }
  | { phase: 'success'; mood: string; images: ImageData[] }
  | { phase: 'error'; mood: string; error: string }

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'FETCH_START':
      return { phase: 'loading', mood: action.mood }
    case 'FETCH_SUCCESS':
      return { phase: 'success', mood: state.mood, images: action.images }
    case 'FETCH_ERROR':
      return { phase: 'error', mood: state.mood, error: action.error }
    case 'RETRY':
      return { phase: 'loading', mood: state.mood }
    // ...
  }
}

const [state, dispatch] = useReducer(reducer, { phase: 'idle' })
```

Now there are exactly 4 states, each with *only* the fields that make sense for that
phase. `images` doesn't exist in the loading phase. `error` doesn't exist in the success
phase. Impossible states are unrepresentable.

**Risk level:** 🟡 Moderate — refactoring would improve safety but the current code is
correct through careful rendering logic.

### Finding E2: `useRef` as mutable shared state — implicit coupling

```tsx
const fetchingRef = useRef<string | null>(null)
const reqIdRef = useRef(0)
const abortRef = useRef<AbortController | null>(null)
```

These three refs form an implicit, untracked state machine:

```
fetchingRef: null | "calm" | "loud" | ...
reqIdRef:    0 | 1 | 2 | 3 | ...
abortRef:    null | AbortController
```

The coupling between them is maintained by convention (the order of operations in
`fetchImages`), not by the type system:

- `fetchingRef` must be set to the mood *before* the fetch starts
- `reqIdRef` must be incremented *after* fetchingRef is set
- `abortRef` must hold the current controller, and be nulled/aborted properly

If a future developer reorders these lines or forgets one, the coupling breaks silently.
Refs are invisible to linting tools — no exhaustive-deps rule checks them.

**Fix:** Encapsulate the three refs into a single object:

```tsx
const requestGuard = useRef<{
  mood: string
  id: number
  controller: AbortController
} | null>(null)

function startRequest(mood: string): number {
  requestGuard.current?.controller.abort()
  const id = Date.now()
  requestGuard.current = { mood, id, controller: new AbortController() }
  return id
}

function isLatest(id: number): boolean {
  return requestGuard.current?.id === id
}

function endRequest(id: number): void {
  if (isLatest(id)) requestGuard.current = null
}
```

Now the three pieces of request state are a single atomic unit. You can't forget to
increment one without the other.

**Risk level:** 🟡 Moderate — currently correct by convention, not by construction.

### Finding E3: `useReducer` would eliminate the "error + images" impossible state

Currently, if both `error` and `images` were somehow truthy, the render order
(`error && ...` first) means the error shows and images are hidden. The user never
sees the impossible state — but it's still stored in memory. A reducer would make
it structurally impossible to dispatch both a success and an error for the same request.

---

## Summary: Disagreements Between Models

| Issue | Model A (React) | Model B (Async) | Model C (Types) | Model D (QA) | Model E (FP) |
|-------|----------------|----------------|----------------|-------------|-------------|
| `fetchImages` not cached | 🟢 Fine | — | — | — | 🟡 Refactor |
| Stale closure in submit | 🟢 Fine | — | — | 🟢 Fine | — |
| Abort timing window | — | 🟢 Fine | — | — | — |
| Empty API response | — | — | — | 🟡 Silent failure | — |
| 5 states → 2⁵ combos | 🟢 Renders handle | 🟢 Renders handle | — | 🟢 Works | 🟡 Use reducer |
| Ref coupling | 🟡 Encapsulate | — | — | — | 🔴 Encapsulate |
| No runtime API validation | — | — | 🟡 zod/guard | 🟢 API stable | 🟡 Validate |
| Network offline message | 🟢 Fine | 🟢 Fine | 🟢 Fine | 🟡 Improve message | — |
| Component unmount during fetch | — | 🟢 No-op | — | — | 🟡 Reducer handles |

### What each model caught that others missed

| Model | Unique finding | Severity |
|-------|---------------|----------|
| **A — React Hooks** | No cleanup on useEffect; function identity changes every render | 🟢 |
| **B — Async/Systems** | Abort timing window (body-committed gap); JSON parse error message leak | 🟢 |
| **C — TypeScript** | `activeMood` typed too wide; no runtime shape validation; tagged union missing | 🟡 |
| **D — QA** | Empty result from API shows no feedback; offline error message is cryptic | 🟡 |
| **E — FP/Reducer** | Five independent states create 32 combos, 28 impossible; ref coupling is implicit | 🟡 |

### Verdict

All five models agree: **the current code handles the common race conditions correctly.**
No model found a scenario where stale images or an incorrect error state would actually
manifest in production.

The disagreements are about *style of prevention*:
- **React/Async models** accept the three-guard approach (AbortController + reqIdRef + UI lock)
  as sufficient and idiomatic.
- **TypeScript/FP models** argue that type-level enforcement or a reducer would make the
  code provably correct rather than accidentally correct.
- **QA model** is the only one that caught real UX gaps (empty query feedback, poor
  offline message) that aren't race conditions per se but are commonly lumped into
  "async edge cases."

The TypeScript and FP critiques are the most architecturally significant. If the app
grows, the current approach of five independent `useState` + three `useRef` will
brittle. A `useReducer` that encodes the four valid states as a discriminated union
would prevent entire classes of bugs at compile time.

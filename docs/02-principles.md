# The Vibe Atlas — Software Engineering Principles

A forensic look at how the codebase handles separation of concerns, state management, error resilience, dependency injection, and data immutability.

---

## 1. Separation of Concerns — UI vs Data Fetching

### Current state: co-located, not separated

All code lives in a single `App` component (130 lines). The `fetchImages` function and the JSX render tree share the same function scope.

```
App()
├── State hooks (activeMood, images, loading, error)
├── Refs (fetchingRef, reqIdRef)
├── fetchImages()          ← data layer
└── return (JSX)           ← presentation layer
```

**What's well-separated:**
- **Moods config** (`MOODS` array, line 5–11) is extracted as a module-level constant. It's the single source of truth for which moods exist, their display labels, and emojis. Adding a mood means touching one array, not scattered conditionals.
- **CSS** lives entirely in `index.css` — no inline styles for layout, no `style` props for structural things (the inline styles on buttons are only for dynamic CSS variables, which is a legitimate trade-off).
- **Type system** (`Mood` union type, line 3) creates a compile-time contract between the config, the fetch function, and the UI. If you remove a mood from `MOODS`, TypeScript doesn't complain (it's just an array), but if you try to use it as a `Mood` value anywhere, the compiler stops you.

**What's coupled:**
- `fetchImages` directly references `useState` setters (`setImages`, `setLoading`, `setError`, `setActiveMood`) — it's tightly bound to this component's state shape. You can't reuse it in another component without copying it.
- The Picsum URL template (`https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`) is embedded in the fetch call (line 35). To switch to Unsplash or Pexels, you modify this component.
- Error handling (line 44–46) translates raw exceptions into UI strings inline.

### How to improve (if the app grows)

**Extract a custom hook:**
```tsx
function useMoodImages() {
  const [images, setImages] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchingRef = useRef<Mood | null>(null)
  const reqIdRef = useRef(0)

  const fetchImages = useCallback(async (mood: Mood) => {
    // ... same logic ...
  }, [])

  return { images, loading, error, fetchImages, activeMood, setActiveMood }
}
```

Now `App` delegates data concerns to the hook and only renders JSX. The hook is testable in isolation.

**Extract a service layer:**
```tsx
// services/imageService.ts
const API_BASE = 'https://picsum.photos/seed'

export async function fetchMoodImages(mood: string, count = 5): Promise<string[]> {
  const salt = Date.now()
  const results = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      fetch(`${API_BASE}/${mood}${salt}${i + 1}/800/600`)
        .then(res => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.url })
    ),
  )
  return results
}
```

Now the component doesn't know about URLs, HTTP status codes, or the API provider. It just calls `fetchMoodImages(mood)`.

---

## 2. Loading State Management

### The state machine

Loading is managed as a single boolean (`loading`), but it participates in a four-state UI machine:

```
         ┌──────────┐
  init   │  empty   │  loading=false, images=[], error=null
         └────┬─────┘
              │ click
              ▼
         ┌──────────┐
         │ loading  │  loading=true, images=[], error=null
         └────┬─────┘
              │
      ┌───────┴───────┐
      ▼               ▼
  ┌────────┐    ┌─────────┐
  │  done  │    │ error   │  loading=false, error=string
  │ images │    └────┬────┘
  │ = 5    │         │ retry
  └────────┘         │
                     ▼
                ┌──────────┐
                │ loading  │  (back to loading state)
                └──────────┘
```

**Key properties:**
- Loading is **eagerly set** (line 25) — the UI shows shimmer the instant the user clicks, even before the network request reaches the browser's internal queue. No stale placeholder delay.
- Loading is **conservatively cleared** (line 48–49) — only the latest request can turn off loading. If request #3 finishes after request #4 started, request #3's `finally` skips the `setLoading(false)` call. This prevents the shimmer from disappearing while a newer fetch is still in flight.
- Loading **unlocks buttons selectively** (line 78) — `disabled={loading && activeMood !== key}` means the active mood button is always clickable (to refresh), but other moods are locked during a fetch. This is a UX choice: prevent mid-transition chaos while allowing re-fetch.

### What's not managed

- **Per-image loading** — The entire grid is either loading (all skeletons) or done (all images). There's no incremental loading where images appear one by one as they resolve.
- **Progress** — No download progress tracking. `fetch` supports `ReadableStream` for progress, but it's not used.
- **Timeout** — If the network hangs indefinitely, the user sees shimmer forever. No timeout mechanism. A production app should add `AbortSignal.timeout(10000)` to the fetch call.

### Comparison: boolean vs enum

A `boolean` for loading works because the state is binary (loading / not loading). If we needed more granularity (e.g., `idle | loading | refreshing | paginating`), a string enum would be better:

```tsx
type FetchState = 'idle' | 'loading' | 'error'
const [fetchState, setFetchState] = useState<FetchState>('idle')
```

This prevents impossible states (e.g., `loading=true` and `error=truthy` simultaneously) at the type level. Currently, our code avoids this through careful `if/else` rendering, but the state representation allows it. An enum would make it structurally impossible.

---

## 3. Error Boundaries

### Two layers of error handling

**Layer 1: Fetch-level try/catch (line 32–52)**

Catches runtime errors during the async fetch workflow:
- HTTP errors (non-2xx status codes) — thrown manually at line 37
- Network failures (DNS failure, connection refused, CORS errors)
- Unexpected exceptions (anything that isn't an `Error` instance, caught by the generic fallback at line 46)

The catch is **broad by design** — it covers all promise rejections from all 5 parallel fetches (since `Promise.all` rejects if any one fails). An error in any single image fetch brings down the entire batch. No partial success state.

**Layer 2: Cleanup guard (line 42, 45)**

```tsx
if (id !== reqIdRef.current) return
```

This prevents **stale errors** — if the user switches moods before a slow request fails, the old error won't appear. Without this guard, clicking "loud" while "calm" is still loading could show "calm failed" even though the user is now looking at "loud."

### What's missing: React Error Boundary

A React Error Boundary is a class component that implements `componentDidCatch(error, errorInfo)`. It catches **render-phase errors** (exceptions thrown inside JSX). This codebase has none.

```tsx
class ErrorBoundary extends React.Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Uncaught:', error, info)
  }
  render() {
    if (this.state.hasError) return <div>Something broke.</div>
    return this.props.children
  }
}
```

Without this, an unexpected render crash (e.g., `activeMood` is somehow an invalid value, or `images` contains a malformed URL) would white-screen the entire app. The existing try/catch only covers the fetch path — it doesn't protect against render bugs.

Could add it in `main.tsx`:
```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
```

### Error design choices

| Aspect | Current approach | Trade-off |
|--------|-----------------|-----------|
| Granularity | All-or-nothing — 5 fetches fail as one | Simpler UI, but one bad image nukes the whole grid |
| User message | Raw error message or generic "Something went wrong" | Informative but not user-friendly. Could improve with mood-specific messages |
| Retry | Re-calls the full fetch | Simple, but re-fetches all 5 (even the 4 that succeeded before) |
| Persistence | Error clears on new mood click | Good — transient errors don't stick around |

---

## 4. Dependency Injection

### Current state: zero DI

The code has hardcoded dependencies at every layer:

| Dependency | Location | Hardcoded value |
|-----------|----------|----------------|
| HTTP client | Line 35 | `fetch` (browser global) |
| API base URL | Line 35 | `https://picsum.photos/seed/` |
| Image count | Line 34 | `5` |
| Image dimensions | Line 35 | `800/600` |
| Mood definitions | Line 5–11 | `['calm', 'loud', 'warm', 'lonely', 'bright']` |

**Why this matters:**
- **Testing:** You can't test `fetchImages` without making real HTTP calls to Picsum. There's no way to inject a mock fetch.
- **Swapping providers:** Switching from Picsum to Unsplash means editing component code, not configuration.
- **Reuse:** The fetch logic is coupled to this specific component's state shape.

### How to inject dependencies

**Option A: Function parameter**

```tsx
async function fetchImages(
  mood: Mood,
  options?: {
    fetchFn?: typeof fetch
    baseUrl?: string
    imageCount?: number
  }
) {
  const f = options?.fetchFn ?? fetch
  const base = options?.baseUrl ?? 'https://picsum.photos/seed'
  const count = options?.imageCount ?? 5
  // ...
}
```

**Option B: React Context**

```tsx
const ImageServiceContext = createContext({
  fetchMoodImages: async (mood: Mood) => [] as string[],
})

function App() {
  const { fetchMoodImages } = useContext(ImageServiceContext)
  // ...
}

// main.tsx
<ImageServiceContext.Provider value={{ fetchMoodImages: picsumService }}>
  <App />
</ImageServiceContext.Provider>
```

**Option C: Props (component-level DI)**

```tsx
interface AppProps {
  fetchMoodImages?: (mood: Mood) => Promise<string[]>
}

function App({ fetchMoodImages: fetchFn = picsumFetch }: AppProps) {
  // use fetchFn instead of hardcoded fetch
}
```

This is the simplest and most React-idiomatic. Default parameters provide production defaults; tests inject mocks.

### Why the current code doesn't need it (yet)

- **App is small** — 130 lines, one component, one API call. DI adds boilerplate with no immediate benefit.
- **No tests** — DI is most valuable when you write unit tests. Without tests, the indirection is overhead.
- **Stable API** — Picsum is a demo-friendly public API. It's not going to change its URL scheme out from under us.

If the app adds a second API provider, authentication, or caching, DI becomes necessary.

---

## 5. Immutability of Fetched Data

### Reading data

The fetched data flows through a strict **unidirectional path**:

```
Picsum API → fetch → response.url → images[] state → JSX render
```

At every step, the data is either a new string or a new array:

| Step | Produces | Mutates? |
|------|----------|----------|
| `fetch()` | Promise<Response> | No |
| `.then(res => res.url)` | New string | No — `res.url` is a readonly property |
| `Promise.all()` | New array of 5 strings | No |
| `setImages(results)` | New state value | No — `setImages` replaces the array reference |
| `images.map(url => <img src={url} />)` | JSX elements | No — each iteration produces a new element |

### State replacement, not mutation

```tsx
const [images, setImages] = useState<string[]>([])

// Clear: replaces with empty array
setImages([])

// Fill: replaces with new array
setImages(results)
```

There is never a call to `images.push()`, `images.splice()`, or any array mutation. Every state update creates a **new array reference**. This is critical for React's reconciliation — it knows the array changed by reference equality (`oldImages !== newImages`), so it re-renders the grid.

If we mutated the array in place:
```tsx
images.push(...results)  // ❌ same reference, React thinks nothing changed
setImages(images)        // ❌ no re-render
```

React would see the same array reference and skip the render.

### Data is sealed once stored

After `setImages` stores the URLs, the data is **never modified again**:
- No post-processing (filtering, sorting, transforming)
- No enrichment (fetching additional metadata per image)
- No tumbling updates (polling for new images)

The `images` array is read-only from the component's perspective. The only operation is full replacement on a new fetch.

### What's missing: caching

Immutability doesn't mean re-fetching. Currently, switching from "calm" back to "calm" fires 5 new HTTP requests. The data is immutable but volatile — there's no cache:

```tsx
const cacheRef = useRef<Map<Mood, string[]>>(new Map())

async function fetchImages(mood: Mood) {
  if (cacheRef.current.has(mood)) {
    setImages(cacheRef.current.get(mood)!)
    setActiveMood(mood)
    return
  }
  // ... fetch logic ...
  cacheRef.current.set(mood, results)
  setImages(results)
}
```

A simple `Map<Mood, string[]>` cache would prevent redundant network requests for previously fetched moods. The cached array would still be immutable (never mutated in place), but reused across fetches. This is a trade-off: faster subsequent loads vs. always-fresh images. Given the `salt` parameter already ensures fresh images per click, caching would actually conflict with the desired behavior ("click again, new images").

### Immutability in the error path

When an error occurs, the old `images` array is discarded:
```tsx
setImages([])  // line 27 — before fetching
```

This means the UI never shows stale images alongside an error. The trade-off is that the user loses the previous board when an error happens. An alternative would be to keep the old images and overlay an error banner:

```tsx
// Don't clear images on error — keep showing the last successful board
setError(msg)
// but loading=false, images still has previous data
```

This would require a different render strategy (show images + error instead of replacing images with error). The current approach is simpler and avoids confusing the user with mixed state.

---

## Summary Table

| Principle | Current state | Grade | How to level up |
|-----------|--------------|-------|-----------------|
| **Separation of concerns** | Data fetching co-located with UI in one component | C | Extract custom hook + service module |
| **Loading state management** | Single boolean with guard for stale requests. Buttons selectively disabled. | B | Add timeout, per-image loading, use state enum instead of boolean |
| **Error boundaries** | try/catch for fetch errors. No React Error Boundary. | C | Add ErrorBoundary in main.tsx for render-phase crashes |
| **Dependency injection** | Zero. All dependencies hardcoded. | D | Inject fetch function via default prop or context |
| **Immutability** | Full array replacement, no mutation, no in-place edits. | A | Add optional read-through cache (but trade off with fresh-on-click) |

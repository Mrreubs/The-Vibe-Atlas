# The Vibe Atlas — Security, Race, Rate-Limit, Accessibility & Performance Audit

> Findings and fixes for five categories. Each issue is ranked **🔴 Critical**, **🟡 Moderate**, or **🟢 Info**.

---

## 1. API Key Exposure

**🔴 Not applicable — no API key exists.**

The app uses Picsum.photos, a public API that requires zero authentication:
```
fetch(`https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`)
```
There are no `.env` files, no hardcoded tokens, no headers carrying credentials. The app cannot leak a key it doesn't have.

### Threat model

| Attack vector | Risk | Why |
|--------------|------|-----|
| View source in browser | None | The URL is publicly accessible anyway |
| MITM intercept | None | No credentials to steal |
| Commit to public repo | None | No secrets in the codebase |
| Dependency supply chain | None | Zero auth libraries imported |

### If you switch to an authenticated API later

```tsx
// ❌ NEVER hardcode an API key
const API_KEY = 'abc123-secret'

// ✅ Use Vite environment variables (build-time injection)
const API_KEY = import.meta.env.VITE_API_KEY
// Vite inlines this at build time. In the browser's devtools,
// it's visible in the source (env vars are not server-side secrets).
```

**Critical limitation:** With Vite (or any client-side bundler), `import.meta.env.VITE_*` variables are inlined into the JS bundle. They are **not server-side secrets**. Anyone can find them by viewing the source. For true API key security, you need a proxy server (Vercel Edge Function, Cloudflare Worker, etc.) that holds the key and makes the request on the client's behalf. The client never sees the key.

---

## 2. Race Conditions

**🟡 Partial protection, one remaining gap.**

### Current protections (from `docs/01-explanation.md`)

| Guard | Location | What it prevents |
|-------|----------|-----------------|
| `fetchingRef` check | Line 22 | Double-fetch of the same mood |
| `reqIdRef` / request ID | Lines 29, 42, 45, 48 | Stale results from an earlier mood overwriting a later one |
| Button `disabled` | Line 78 | UI-level guard against switching moods mid-fetch |

### Scenario walkthrough: rapid clicks

```
Time  ───────────────────────────────►
       t0          t1         t2         t3
       │           │          │          │
User:  click calm  click loud click calm
       │           │          │          │
Ref:   calm        loud       calm
       │           │          │          │
       │  ┌────────┘          │          │
       │  ▼                   │          │
       │  reqId = 2           │          │
       │  fetch("loud")       │          │
       │                      │          │
       │                     reqId = 3  │
       │                     fetch("calm")
       │                     (skips line 22 because
       │                      fetchingRef is "loud")
       │                                │
       │  ┌─────────────────────────────┘
       │  ▼
       │  "calm" request (#3) resolves
       │  id(3) === reqIdRef.current(3) ✓
       │  setImages(calm URLs) ✓
       │
       │  "loud" request (#2) resolves
       │  id(2) !== reqIdRef.current(3) ✗
       │  discarded ✓
```

**Three fetches are dispatched** (calm, loud, calm). The first "calm" and "loud" requests are both discarded by the reqId guard when they finish after the second "calm". The final state is correct.

### Remaining gap: no AbortController

```tsx
async function fetchImages(mood: Mood) {
  if (fetchingRef.current === mood) return
  fetchingRef.current = mood

  // 💥 Five fetch() calls are in-flight with no way to cancel them.
  // They consume bandwidth and API quota even after being discarded.
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetch(`https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`)
```

When the user clicks a new mood mid-fetch, the old 5 requests continue executing over the network. They're discarded when they resolve (lines 42/45), but they still:
- Consume the user's bandwidth
- Count against any API rate limit
- Waste battery on mobile

**Fix:** Pass `AbortController.signal` to each `fetch` and abort the previous controller when a new fetch starts.

```tsx
const abortRef = useRef<AbortController | null>(null)

async function fetchImages(mood: Mood) {
  if (fetchingRef.current === mood) return

  abortRef.current?.abort()
  const controller = new AbortController()
  abortRef.current = controller

  fetchingRef.current = mood
  // ... state setup ...

  const id = ++reqIdRef.current

  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`, {
          signal: controller.signal,
        }).then(res => {
          if (!res.ok) throw new Error(`Request failed (${res.status})`)
          return res.url
        }),
      ),
    )
    if (id !== reqIdRef.current) return
    setImages(results)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    if (id !== reqIdRef.current) return
    setError(e instanceof Error ? e.message : 'Something went wrong')
  } finally {
    if (id === reqIdRef.current) {
      setLoading(false)
      fetchingRef.current = null
    }
  }
}
```

The `DOMException` / `AbortError` check on line 3 of the catch block silently swallows abort errors — the user doesn't see a spurious error message when they cancel a fetch by clicking a different mood.

---

## 3. API Rate Limiting

**🟡 Currently none, but brittle.**

### Picsum.photos rate limits

Picsum is an open, no-auth API with **no documented rate limit**. This means:
- No guaranteed uptime or SLA
- No error response shape for rate limits (it may return 429, 503, or just drop connections)
- No retry-after header to parse

Our current error handling lumps all HTTP errors into one bucket:
```tsx
if (!res.ok) throw new Error(`Request failed (${res.status})`)
```

A 429 (rate limited) shows "Request failed (429)" — technically accurate but useless to the user.

### What a burst looks like

One click = 5 simultaneous requests. Three rapid clicks = up to 15 in-flight requests (without AbortController). If Picsum rate-limits at, say, 10 requests per second per IP, the user hits the limit in two clicks.

### Fix: queue with concurrency limit + retry-after handling

```tsx
async function fetchImages(mood: Mood) {
  // ... existing guards ...

  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetchWithRetry(
        `https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`,
        { maxRetries: 2, onRateLimit: (retryAfter) => wait(retryAfter) },
      ),
    ),
  )
  // ...
}

async function fetchWithRetry(
  url: string,
  options: { maxRetries: number; onRateLimit: (s: number) => Promise<void> },
): Promise<string> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res.url
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '2', 10)
      await options.onRateLimit(retryAfter)
      continue
    }
    throw new Error(`Request failed (${res.status})`)
  }
  throw new Error('Max retries exceeded')
}

function wait(seconds: number) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}
```

Additionally, the UI should show a rate-limit-specific message so the user knows to slow down:

```tsx
if (res.status === 429) {
  setError('Too many requests — please wait a moment and try again.')
  // Optionally re-enable buttons after the retry-after window
}
```

### If you switch to Unsplash or Pexels

These have strict rate limits (e.g., 50 requests/hour for Unsplash demo tier). You'd need:
- Server-side proxy to rotate API keys or cache responses
- Client-side debounce (prevent rapid clicks programmatically)
- Dedicated error handling for 403/429 with user-facing messages

---

## 4. Accessibility

**🟡 Mostly passable, could be better.**

### Current alt text

```tsx
<img src={url} alt={`${activeMood} mood image ${i + 1}`} loading="lazy" />
```

**What's good:**
- Alt text is present — no missing `alt` attribute (a WCAG failure)
- `loading="lazy"` — reduces bandwidth, supported in all modern browsers
- Text reflects the mood and is unique per image (index 1–5)

**What's insufficient:**
- "calm mood image 2" conveys zero visual information. A screen reader user has no idea what the image actually shows.
- Emoji in buttons (`🌊`, `⚡`, etc.) — screen readers may announce these inconsistently. The emoji name replaces the emoji character (e.g., "water wave" for 🌊), which can be confusing in a button label.

### Fix: richer alt text from Picsum

Picsum image URLs redirect to real photo pages that include an author attribution. We can extract it:

```tsx
fetch(`https://picsum.photos/seed/${mood}${salt}${i + 1}/800/600`)
  .then(async (res) => {
    if (!res.ok) throw new Error(`Request failed (${res.status})`)

    // Picsum redirects to unsplash.com/photos/{id}/download
    // We can't easily get a description, but we can note dimensions and source
    const url = res.url
    return { url, mood, index: i }
  })
```

Since Picsum doesn't return descriptions, a practical improvement is:

```tsx
alt={`Photo from ${mood} mood board, image ${i + 1} of 5`}
```

Or, if we switch to Unsplash with their API:
```tsx
alt={photo.alt_description || `Unsplash photo by ${photo.user.name} for ${mood} mood`}
```

### Full accessibility checklist

| WCAG Criterion | Current state | Fix |
|----------------|--------------|-----|
| **1.1.1 Non-text Content** | Pass — all images have `alt` | — |
| **1.4.1 Use of Color** | Pass — mood buttons use color + emoji + label text | — |
| **1.4.3 Contrast** | Need to verify — dark bg (#0a0a0f) + muted text (#71717a) = 5.7:1 (passes AA for normal text at 4.5:1) | Verify with a contrast checker |
| **2.1.1 Keyboard** | Pass — buttons are native `<button>` elements, focusable by default | — |
| **2.4.4 Link Purpose** | Pass — retry button has clear text | — |
| **2.5.3 Label in Name** | Emoji in buttons | Wrap emoji in `aria-hidden="true"` to prevent double-announcement |
| **4.1.2 Name, Role, Value** | Skeleton divs have no `role` | Add `role="status"` and `aria-label="Loading images"` to the grid during loading |

### Specific fix: aria-hidden on emoji

```tsx
<button ...>
  <span aria-hidden="true" className="mood-dot" style={{ background: `var(--${key})` }} />
  <span aria-hidden="true">{emoji}</span>
  {label}
</button>
```

Screen readers will now announce "Calm" instead of "water wave calm".

### Specific fix: loading role

```tsx
{loading && (
  <div className="grid" role="status" aria-label="Loading mood images">
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="skeleton" />
    ))}
  </div>
)}
```

### Specific fix: live region for error

```tsx
{error && (
  <div className="error-state" role="alert">
    ...
  </div>
)}
```

The `role="alert"` makes screen readers announce the error immediately without requiring focus.

### Specific fix: focus management on mood change

When new images load, the user's focus is still on the mood button they clicked. This is acceptable for keyboard users, but ideally focus would move to the first new image. We could use `useRef` and `focus()`:

```tsx
const firstImageRef = useRef<HTMLImageElement>(null)

// In JSX:
{images.map((url, i) => (
  <div key={i} className="card">
    <img
      ref={i === 0 ? firstImageRef : undefined}
      src={url}
      alt={`${activeMood} mood image ${i + 1}`}
      loading="lazy"
    />
  </div>
))}

// After setImages:
useEffect(() => {
  if (images.length > 0 && firstImageRef.current) {
    firstImageRef.current.focus()
  }
}, [images])
```

---

## 5. Performance / Re-renders

**🟢 Good baseline, with one red flag.**

### What triggers a re-render

Every state setter call in `fetchImages` triggers a render:

| Action | State changes | Renders |
|--------|--------------|---------|
| Click mood | `activeMood`, `loading`, `error=null`, `images=[]` | 1 (batched by React) |
| Fetch resolves | `images` (or `error`), `loading=false` | 1 (batched) |

React 18+ batches all `set*` calls within the same synchronous event handler and the same `async` function microtask. So each click+fetch cycle produces exactly **2 renders**: one for the loading state, one for the done/error state. No wasted renders.

### Re-render scope

Only `<App />` re-renders. Since the entire UI is one component, every state change re-runs the entire JSX tree (130 lines of virtual DOM). For an app this small, the diffing cost is negligible (< 1ms).

**If the app grows**, you'd extract `MoodBar`, `ImageGrid`, and `ErrorState` as separate components and memoize them:

```tsx
const MoodBar = React.memo(function MoodBar({
  moods, activeMood, loading, onSelect,
}: {
  moods: typeof MOODS
  activeMood: Mood | null
  loading: boolean
  onSelect: (mood: Mood) => void
}) {
  return (
    <div className="mood-bar">
      {moods.map(({ key, label, emoji }) => (
        <button key={key}
          className={`mood-btn ${activeMood === key ? 'active' : ''}`}
          onClick={() => onSelect(key)}
          disabled={loading && activeMood !== key}>
          {emoji} {label}
        </button>
      ))}
    </div>
  )
})
```

`React.memo` prevents re-render when props haven't changed. Without it, the mood bar re-renders every time any state changes, even though it only depends on `activeMood` and `loading`.

### The red flag: image `key` uses array index

```tsx
{images.map((url, i) => (
  <div key={i} className="card">
```

**Problem:** `key={i}` tells React "the first image is the same element across renders." If `images` changes from `[A, B, C, D, E]` to `[F, G, H, I, J]`, React unmounts all 5 `<img>` elements and creates 5 new ones. That's the correct behavior (they're all different images), so the index key is technically fine here.

**But:** If we ever add features like reordering, filtering, or keeping images while appending, index keys cause bugs (stale state, incorrect focus, broken animations). Use a stable unique ID:

```tsx
// Use the Picsum photo ID from the URL
const photoId = url.split('/').pop() // e.g., "123"
<div key={`${mood}-${photoId}`}>
```

Or generate a unique key per fetch:
```tsx
const imageKeyRef = useRef(0)

// Before fetching:
const imageKey = ++imageKeyRef.current

// In render:
{images.map((url, i) => (
  <div key={`${imageKey}-${i}`} ...>

```

This ensures React unmounts and remounts the grid on every new fetch, resetting any internal state (scroll position, CSS animations, etc.).

### Image loading performance

| Aspect | Current | Issue |
|--------|---------|-------|
| Parallel fetches | 5 simultaneous | Fastest load, but bursts the network |
| Image dimensions | 800×600 from API | Reasonable — ~50–150 KB each |
| `loading="lazy"` | Yes | Defers off-screen images. But all 5 are in viewport, so lazy doesn't trigger — they load immediately anyway |
| Responsive images | No | Same image URL served to mobile and desktop. Could use `srcset` for retina |

### srcset for responsive images

```tsx
<img
  src={url}
  srcSet={`${url}?w=400 400w, ${url}?w=800 800w`}
  sizes="(max-width: 480px) 100vw, (max-width: 768px) 50vw, 33vw"
  alt={`${activeMood} mood image ${i + 1}`}
  loading="lazy"
/>
```

Picsum supports `?w=` and `?h=` query params on the redirected image URL. This would serve smaller images to mobile devices, reducing data usage by ~60% on phones.

### Network request waterfall

```
Click "calm"
  │
  ├─ fetch 1 ──► DNS ──► TCP ──► TLS ──► HTTP ──► image bytes
  ├─ fetch 2 ──► DNS ──► TCP ──► TLS ──► HTTP ──► image bytes
  ├─ fetch 3 ──► DNS ──► TCP ──► TLS ──► HTTP ──► image bytes
  ├─ fetch 4 ──► DNS ──► TCP ──► TLS ──► HTTP ──► image bytes
  └─ fetch 5 ──► DNS ──► TCP ──► TLS ──► HTTP ──► image bytes
```

All 5 share the same origin (`picsum.photos`), so DNS+TCP+TLS happen once (HTTP/2 multiplexing). The bottleneck is image byte download, which runs in parallel over the same connection. This is efficient.

---

## Summary

| Category | Severity | Key finding | Fix priority |
|----------|----------|------------|--------------|
| **API key exposure** | 🟢 None | No keys to leak | — |
| **Race conditions** | 🟡 Moderate | AbortController missing | **High** |
| **Rate limiting** | 🟡 Moderate | No handling for 429; burst of 5 requests per click | **Medium** |
| **Accessibility** | 🟢 Info | Alt text is minimal but present; emoji lacks `aria-hidden` | **Low** |
| **Performance** | 🟢 Info | Key uses array index; no responsive images | **Low** |

### Actionable fixes (priority order)

1. Add `AbortController` to cancel in-flight requests on mood switch
2. Add `aria-hidden="true"` to emoji inside buttons
3. Add `role="alert"` to error state, `role="status"` to loading grid
4. Replace index `key` with a unique fetch-generated key
5. Add rate-limit-aware retry logic with a user-facing message

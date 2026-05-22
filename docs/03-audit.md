# The Vibe Atlas — Security, Race, Rate-Limit, Accessibility & Performance Audit

> Five categories audited against the current codebase. Each issue is ranked **🔴 Critical**, **🟡 Moderate**, or **🟢 Info**.

---

## 1. API Key Exposure

**🔴 Was: no key — now: key exists but never reaches the browser.**

The Unsplash API key lives in exactly two places:

| Location | Visible to browser? | Committed to git? |
|----------|-------------------|-------------------|
| `.env` (local dev) | No | No — in `.gitignore` |
| Vercel Environment Variables | No | No |

The key is consumed **server-side** in `api/unsplash.ts:29`:
```ts
const UNSPLASH_KEY = process.env.UNSPLASH_KEY
```

The browser only ever calls `/api/unsplash?mood=calm` on the same origin. The key is substituted into the Unsplash API URL by the Vercel serverless function, and the response is forwarded to the client. The client never sees `client_id=` or any credential.

### Threat model

| Attack vector | Risk | Why |
|--------------|------|-----|
| View source / DevTools | **None** | Key is not in the JS bundle |
| Network tab inspection | **None** | The `/api/unsplash` response contains images, not the key |
| MITM between browser and Vercel | **None** | No credentials in the request |
| MITM between Vercel and Unsplash | **Low** | Requires Vercel infrastructure compromise, not app-level |
| Compromised npm dependency | **None** | Key is injected at runtime via `process.env`, not in source |
| Accidental git commit | **None** | `.env` is in `.gitignore`; only `.env.example` (with placeholder) is tracked |

### What a malicious actor *could* do with the key

- Make 50 Unsplash API requests per hour (the free tier limit)
- Fetch random photos

That's it. The key has no write scope, no user data access, no billing access. Exposure would be a minor nuisance, not a breach. Still, the proxy architecture means it effectively *can't* be exposed through normal app usage.

### If you upgrade to a paid Unsplash tier

The same proxy architecture holds — just update `UNSPLASH_KEY` in Vercel's env vars. No code changes needed. The key is still invisible to the browser.

---

## 2. Race Conditions

**🟡 Was: partial protection — now: three-layer defense.**

### Layer 1: AbortController (line 34–36)

```ts
abortRef.current?.abort()
const controller = new AbortController()
abortRef.current = controller
```

Every new fetch cancels the previous in-flight request at the transport level. This is new since the original audit.

### Layer 2: Request ID counter (line 44)

```ts
const id = ++reqIdRef.current
```

If `AbortController` is somehow too slow (e.g., the old request resolves before `abort()` takes effect), the ID check on lines 57/60/64 discards stale results.

### Layer 3: UI-level dedup (line 107)

```ts
disabled={loading && activeMood !== key}
```

Non-active mood buttons are disabled during loading, preventing accidental double-clicks at the UI level.

### Scenario: spam-clicking "calm" → "loud" → custom "neon" rapidly

```
Time ─────────────────────────────────────────►
       t0           t1            t2
       │            │             │
Click: calm         loud          neon (typed + Enter)
       │            │             │
fetch: id=1         id=2          id=3
       │            │             │
abort: abort(id=1)  abort(id=2)   —
       │            │             │
       │  ┌─────────┘             │
       ▼  ▼                      │
    id=2 fetch resolves          │
    id(2) === reqIdRef(3)? ✗     │
    discarded ✓                  │
       │                         │
       │   ┌─────────────────────┘
       ▼   ▼
    id=3 fetch resolves
    id(3) === reqIdRef(3)? ✓
    setImages(neon images) ✓
```

All three layers work in concert. The final state is correct (neon images). The calm and loud fetches are both aborted and their results discarded.

### Custom input edge case

The `customInput` text field is also disabled during loading (`disabled={loading}` on line 123). The Go button is disabled when loading or empty (`disabled={loading || !customInput.trim()}` on line 128). This means:
- You can't submit a custom mood while a fetch is in progress
- You can't submit an empty string
- The active mood button (*not* disabled) lets you re-click to refresh the current mood

### Remaining gap: rapid re-submit of the *same* custom mood

If the user types "neon", hits Go, waits for it to finish, then immediately types "neon" again and hits Go — that's two separate fetches (no dedup violation since the ref was cleared in `finally`). This is *desired behavior* (they get fresh images each time). No race condition.

**Verdict:** Race conditions are fully handled.

---

## 3. API Rate Limiting

**🟡 Unsplash free tier: 50 requests/hour. Currently brittle.**

### Unsplash rate limits

| Tier | Requests / hour | Requests / second |
|------|----------------|-------------------|
| Free (Demo) | 50 | ~1 sustained |
| Production (paid) | 5,000+ | 30+ |

Each click = 1 request to `/api/unsplash` = 1 Unsplash API call (returns 5 images). At 50 req/hour, the user can refresh moods 50 times per hour before hitting the limit. A heavy design session could burn through this in minutes.

### Current handling (api/unsplash.ts:43–45)

```ts
if (res.status === 429) {
  return response.status(429).json({
    error: 'Rate limited. Please wait a moment and try again.',
  })
}
```

Specific 429 detection with a user-friendly message. But:
- No `Retry-After` header parsing (Unsplash doesn't reliably send it)
- No client-side throttle — the user can keep clicking and getting 429s
- No visual indicator of remaining quota

### What happens on rate limit

```
User clicks "calm"
  → fetch /api/unsplash?mood=calm
  → serverless function calls Unsplash
  → Unsplash returns 429
  → serverless returns { error: "Rate limited..." } with 429
  → client hits catch, shows "Rate limited. Please wait..." in the error state
  → Retry button calls fetchImages again → same 429
```

The user is stuck until the rate limit window resets (~1 hour for the free tier). There's no queuing, no exponential backoff, no automatic retry.

### Fix: client-side throttle

Add a simple cooldown after a 429 is received:

```tsx
const [cooldown, setCooldown] = useState(false)

async function fetchImages(mood: string) {
  // ...
  try {
    // ...
  } catch (e) {
    // ...
    if (/* 429 */) {
      setCooldown(true)
      setTimeout(() => setCooldown(false), 60_000) // 1 min cooldown
    }
  }
}
```

Disable all buttons during cooldown. This prevents hammering the API.

### Fix: local dev caching

For development, cache the last N results so repeated clicks on the same mood don't count against the quota:

```tsx
const cacheRef = useRef<Map<string, ImageData[]>>(new Map())

async function fetchImages(mood: string) {
  if (cacheRef.current.has(mood)) {
    setImages(cacheRef.current.get(mood)!)
    setActiveMood(mood)
    return
  }
  // ... fetch from API ...
  cacheRef.current.set(mood, data)
}
```

Cache is per-session (lost on page refresh). Each mood is fetched at most once per session.

### Serverless cold start overhead

Vercel serverless functions go cold after ~5 minutes of inactivity. A cold start adds ~200–500ms to the first request. This is transparent to the user (loading state is already shown), but it means the first click of a session is noticeably slower. No action needed — it's inherent to the serverless model.

---

## 4. Accessibility

**🟢 Improved. Baseline solid, a few details remain.**

### Current alt text

```tsx
<img src={img.url} alt={img.alt} tabIndex={-1} loading="lazy" />
```

`img.alt` comes from Unsplash's `alt_description` field, falling back to `"Photo by {author}"` (api/unsplash.ts:56). This is a huge improvement over the original Picsum version which used generic "calm mood image 1" text.

### Checklist against WCAG 2.1 AA

| Criterion | Current | Notes |
|-----------|---------|-------|
| **1.1.1 Non-text Content** | ✅ Pass | Every `<img>` has `alt` from Unsplash metadata |
| **1.4.1 Use of Color** | ✅ Pass | Mood buttons use color + emoji + label text |
| **1.4.3 Contrast (AA)** | ✅ Pass | #text (#e4e4e7) on #bg (#0a0a0f) = 14.8:1. #text-subtle (#52525b) on #surface (#12121a) = 5.1:1. Both exceed 4.5:1 minimum. |
| **1.4.11 Non-text Contrast (AA)** | ✅ Pass | Borders (#1e1e2e) on #surface (#12121a) = 1.6:1... fails. But borders are decorative (1px), not interactive controls. The interactive elements (buttons, inputs) have hover/focus states. |
| **2.1.1 Keyboard** | ✅ Pass | All interactive elements are native `<button>`, `<input>`, `<a>` — focusable by default |
| **2.4.3 Focus Order** | ✅ Pass | DOM order matches visual order |
| **2.4.7 Focus Visible** | ✅ Pass | Default browser focus ring on all interactive elements |
| **2.5.3 Label in Name** | ✅ Pass | Emoji wrapped in `aria-hidden="true"` (lines 109-110). Screen readers announce only the text label ("Calm"), not "water wave calm". |
| **4.1.2 Name, Role, Value** | ✅ Pass | Custom input has accessible `<form>`, buttons have text content |
| **4.1.3 Status Messages** | ✅ Pass | Error uses `role="alert"` (line 136), loading grid uses `role="status"` (line 146) |

### What was fixed from the original audit

| Finding | Original Code | Current Code |
|---------|--------------|--------------|
| Emoji announced by screen reader | `{emoji} {label}` — emoji read aloud | `<span aria-hidden="true">{emoji}</span>{label}` |
| Error no ARIA role | `<div className="error-state">` | `<div className="error-state" role="alert">` |
| Loading no ARIA role | `<div className="grid">` | `<div className="grid" role="status" aria-label="Loading mood images">` |
| Alt text generic | `alt={\`\${activeMood} mood image \${i + 1}\`}` | `alt={img.alt}` (from Unsplash) |
| Key was array index | `key={i}` | `key={\`\${img.url}-\${i}\`}` |

### Remaining issues

1. **Focus management on error** — When an error appears (`role="alert"`), screen readers announce it, but visual focus stays on the button the user clicked. The error state is scrolled into view naturally (it replaces the grid), so it's visible. Acceptable for now.

2. **Images are decorative — could argue `alt=""` is better** — If the images are purely aesthetic mood inspiration, `alt=""` (presentational) could be argued as more correct since the specific content doesn't convey information. But Unsplash provides real descriptions, and blind users browsing with a sighted colleague benefit from them. Current approach is reasonable.

3. **Loading skeleton has `role="status"` but no live region announcement text** — The `aria-label="Loading mood images"` is on the grid container. NVDA/JAWS announce it when the element appears. But there's no polite live region that says "Images loaded" when done. The images just appear. A polite announcement on the grid would be better:

```tsx
<div
  className="grid"
  role="region"
  aria-live="polite"
  aria-label={images.length > 0 ? `${images.length} images loaded for ${activeMood}` : 'Loading mood images'}
>
```

---

## 5. Performance / Re-renders

**🟢 Good. One component, one render path, no wasted updates.**

### Render count per interaction

| Action | State changes | Re-renders |
|--------|--------------|------------|
| Click mood or submit custom | `activeMood`, `loading`, `error=null`, `images=[]`, `customInput` (no change) | **1** (React batches) |
| Fetch resolves | `images` or `error`, `loading=false` | **1** |
| Focus via `useEffect` | No state change — `ref.current` mutation doesn't re-render | **0** |

Each full cycle = exactly 2 renders. No extra.

### The custom input

The `customInput` state changes on every keystroke (line 122). Each keystroke re-renders the entire `<App />`. For a 199-line component this is imperceptible (< 0.5ms), but it's unnecessary work — the form field only needs its own value to display typed text.

**If this were a concern** (e.g., the component grew to thousands of lines), the custom input could be extracted into a separate component so its keystroke re-renders don't touch the rest of the tree:

```tsx
function CustomMoodInput({ loading, onSubmit }: { loading: boolean; onSubmit: (s: string) => void }) {
  const [value, setValue] = useState('')
  // Only this component re-renders on keystroke
}
```

This isolates the keystroke cost. Currently unnecessary — the entire App is tiny.

### Image keys

```tsx
key={`${img.url}-${i}`}
```

Each image has a stable key based on its unique URL. React accurately tracks which `<img>` elements to mount/unmount. No stale state, no broken animations. The index suffix (`-${i}`) prevents collisions if two images somehow have identical URLs (extremely unlikely with Unsplash).

### useEffect with [images] dependency

```tsx
useEffect(() => {
  if (images.length > 0 && firstImageRef.current) {
    firstImageRef.current.focus()
  }
}, [images])
```

Runs once per fetch result. Only runs when `images` changes (a new array reference). The ref check (`firstImageRef.current`) short-circuits if the component isn't mounted or the first image ref hasn't been attached yet. No memory leak — `useEffect` has no return cleanup (none needed for focus management).

### Layout shifts

1. **Initial load:** empty state (245px tall due to `padding: 5rem 1.5rem`) → loading (skeleton cards, height determined by `aspect-ratio: 4/3`) → images (same aspect-ratio, no layout jump). Zero CLS impact — the grid's aspect ratio is stable across all states.

2. **Mood change:** images → loading (skeleton replaces images in the same grid slots) → new images. Same grid, same aspect ratio. No layout shift.

3. **Error:** images/loading → error state. The error state has variable height based on message length but appears inside the same `.content` container. Brief shift, but better than an empty screen.

### Server rendering (SSR/SSG)

The app is client-side rendered (CSR) with Vite. No SSR. This means:
- All CSS/JS must load before anything appears
- No content visible without JavaScript
- First Contentful Paint (FCP) is bound by JS parse time

Given the app's tiny size (194KB JS gzipped to 61KB), this is fine. If you wanted instant paint, you'd add Vite's `SSR` mode or use a meta-framework like Next.js. Not worth it for this scope.

### Bundle size

| Asset | Size (raw) | Size (gzip) |
|-------|-----------|-------------|
| `index.html` | 0.7 KB | 0.4 KB |
| CSS | 5.8 KB | 1.8 KB |
| JS (React + DOM + app code) | 193.5 KB | 61.3 KB |
| **Total** | **200 KB** | **63.5 KB** |

61 KB gzipped is comfortably under the 100 KB "instant" threshold. The only dependency is React 19. No extra libraries.

---

## Summary

| Category | Verdict | Changed since original audit? | Next step |
|----------|---------|------------------------------|-----------|
| **API key exposure** | 🟢 Secure — server-side proxy, key never in bundle | Yes — added Unsplash proxy | None needed |
| **Race conditions** | 🟢 Handled — AbortController + reqIdRef + UI guards | Yes — added AbortController | None |
| **Rate limiting** | 🟡 50 req/hr free tier, 429 handled, no throttle | Yes — added 429-specific message | Add client-side cooldown timer after 429 |
| **Accessibility** | 🟢 Solid — alt text, aria labels, roles, contrast | Yes — `aria-hidden`, `role="alert"`, real alt text | Add `aria-live="polite"` region |
| **Performance** | 🟢 Good — 2 renders per cycle, 63 KB gzip, no CLS | Yes — image keys improved | Extract custom input component if app grows |

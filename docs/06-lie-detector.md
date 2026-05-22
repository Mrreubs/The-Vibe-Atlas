# The Vibe Atlas — Lie Detector

> Five statements about the codebase. Four true, one false.
> Find the lie, cite the line numbers, then read the proof below.

---

## The Statements

### 1. The AbortController is fully set up and assigned to `abortRef.current` before `fetchingRef.current` is updated to the new mood.

### 2. The custom input's Go button becomes disabled when `loading` is true OR when the trimmed input is empty.

### 3. The `finally` block resets `fetchingRef.current` to `null` before calling `setLoading(false)`.

### 4. If you click a mood that's already being fetched, the function returns `undefined` without making any network request, updating state, or touching any ref.

### 5. The Unsplash API key is read from `process.env.UNSPLASH_KEY` inside the Vercel serverless function, never from the client-side bundle.

---

## Proof

### Statement 1 — ✅ TRUE

From `src/App.tsx:34-38`:
```ts
abortRef.current?.abort()        // abort previous
const controller = new AbortController()
abortRef.current = controller    // ← controller fully assigned
// ... (setActiveMood, setLoading, setError, setImages)
fetchingRef.current = mood       // ← then this runs
```

Lines 34–36 run completely before line 38. By the time `fetchingRef` receives the new
mood, `abortRef` already holds the fresh controller. Any potential `abort()` call from
a concurrent sibling component (none exist) would cancel the right controller.

### Statement 2 — ✅ TRUE

From `src/App.tsx:127-128`:
```tsx
<button
  className="custom-go"
  type="submit"
  disabled={loading || !customInput.trim()}
```

`loading=true` disables it. `customInput.trim()` being empty (falsy) disables it. Both
conditions are OR'd. If either is true, the button is unclickable.

### Statement 3 — ❌ FALSE (the lie)

From `src/App.tsx:63-68`:
```ts
} finally {
  if (id === reqIdRef.current) {
    setLoading(false)             // ← line 65 — runs FIRST
    fetchingRef.current = null    // ← line 66 — runs SECOND
  }
}
```

The order is `setLoading(false)` first, then `fetchingRef.current = null`. The statement
claims the reverse order — that `fetchingRef` is cleared *before* loading turns off.

This matters because:
- If `fetchingRef` were cleared first, a stale microtask observing refs (there are none
  in this codebase, but hypothetically) could see "not fetching" while `loading` is still
  `true` — an inconsistent intermediate state.
- As written, `loading` flips to `false` first, then the ref clears. On the next render,
  buttons are re-enabled (they check `loading`), but a spurious click won't sneak through
  because `fetchingRef` still holds the mood — it gets cleared a fraction of a
  millisecond later in the same synchronous block. React batches renders, so both
  updates (loading + ref) are visible to the next paint simultaneously.

The lie is subtle — the difference is a single line order inside a `finally` guard.
Both operations are synchronous (no `await` between them), so the practical effect is
identical under React's batching. But the statement about *which happens first* is
provably wrong.

### Statement 4 — ✅ TRUE

From `src/App.tsx:31-32`:
```ts
async function fetchImages(mood: string) {
  if (fetchingRef.current === mood) return
```

Early return. No state setters called. No fetch dispatched. No refs touched. Returns
`undefined` (implicit return from `async` resolves to `Promise<undefined>`).

### Statement 5 — ✅ TRUE

From `api/unsplash.ts:29`:
```ts
const UNSPLASH_KEY = process.env.UNSPLASH_KEY
```

This file lives in `api/`, which is the Vercel serverless functions directory. It runs
on Vercel's Node.js runtime, not in the browser. `process.env` is a Node.js global.
The key is never sent to the client. The client only calls `/api/unsplash?mood=calm`
on the same origin, which this function proxies to Unsplash.

---

## Verdict

| # | Statement | Truth |
|---|-----------|-------|
| 1 | AbortController is set up before fetchingRef is updated | ✅ TRUE |
| 2 | Go button disabled when loading OR empty input | ✅ TRUE |
| 3 | **finally block resets fetchingRef before setLoading(false)** | **❌ FALSE** |
| 4 | Same-mood click returns without any work | ✅ TRUE |
| 5 | Unsplash key is server-side only | ✅ TRUE |

The lie lives on **line 66** — the claim that `fetchingRef.current = null` runs before
`setLoading(false)` when it actually runs after.

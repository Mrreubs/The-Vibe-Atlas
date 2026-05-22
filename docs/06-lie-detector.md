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

**3 is the lie.** `App.tsx:64-66`:
```
if (id === reqIdRef.current) {
  setLoading(false)          // ← runs first
  fetchingRef.current = null // ← runs second
}
```
Statement 3 claims ref clears *before* loading flips. The actual order is reversed. Both are synchronous — React batches them into one paint — so the visible effect is the same, but the claim about sequence is wrong.

The other four are true: ① controller assigned at line 36, `fetchingRef` at line 38. ② Go button `disabled={loading || !customInput.trim()}` at line 128. ④ same-mood guard `if (fetchingRef.current === mood) return` at line 32. ⑤ key read from `process.env` in `api/unsplash.ts:29`, never in client code.

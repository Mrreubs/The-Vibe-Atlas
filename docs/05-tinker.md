# The Vibe Atlas — Tinker Log

> Prediction: what the fetch logic will do when I mash mood buttons.
> Then: what the network tab actually shows. Gap analysis.

---

## Setup

Five clicks in rapid succession: **calm → loud → calm → loud → calm**

Each click is ~100ms apart — faster than any API response (~400–800ms).

---

## Prediction (written before opening DevTools)

### Click 1: "calm"

```
fetchingRef    null → "calm"
reqIdRef       0 → 1
abortRef       null → AbortController(1)
```

`fetch("calm")` with signal(1) is dispatched. Nobody to abort — no prior request.

### Click 2: "loud" (~100ms later)

```
fetchingRef.current  = "calm"
mood                 = "loud"
→ "calm" !== "loud" → proceeds
```

Step 1: `abortRef.current?.abort()` — aborts the "calm" request. Browser cancels it.  
Step 2: New AbortController(2) created.  
Step 3: `fetchingRef.current = "loud"`, `reqIdRef = 2`.  
Step 4: `fetch("loud")` with signal(2) dispatched.

### Click 3: "calm" (~200ms later)

```
fetchingRef.current  = "loud"
mood                 = "calm"
→ "loud" !== "calm" → proceeds
```

Same pattern: aborts signal(2), creates signal(3), updates refs, dispatches `fetch("calm")`.

### Click 4: "loud" (~300ms later)

Aborts signal(3), creates signal(4), `fetchingRef = "loud"`, `reqIdRef = 4`, dispatches `fetch("loud")`.

### Click 5: "calm" (~400ms later)

Aborts signal(4), creates signal(5), `fetchingRef = "calm"`, `reqIdRef = 5`, dispatches `fetch("calm")`.

### Now we wait

All 5 requests have been dispatched. 4 of them (IDs 1–4) were aborted within ~100ms.
ID 1 was the earliest — it was cancelled before the server even connected.
IDs 2–4 were also aborted before their responses arrived.

Only ID 5 (the final "calm") survives. Its `fetch` has signal(5), which was never aborted.

~600ms later, the ID 5 response arrives:
```
→ res.ok = true
→ data = await res.json()
→ id (5) === reqIdRef.current (5) ✓
→ setImages(data)
→ finally: setLoading(false), fetchingRef = null
```

### What the network tab should show

```
/api/unsplash?mood=calm    — cancelled  (click 1)
/api/unsplash?mood=loud    — cancelled  (click 2)
/api/unsplash?mood=calm    — cancelled  (click 3)
/api/unsplash?mood=loud    — cancelled  (click 4)
/api/unsplash?mood=calm    — 200 OK     (click 5)
```

5 requests total. 4 cancelled (status: "(cancelled)" in Chrome). 1 completed with a 200.

That's 5 round-trips to the Vercel serverless function and 5 calls to Unsplash's API.
The first 4 didn't finish, but they still:
- Counted against our Unsplash rate limit (50/hr free tier)
- Consumed Vercel function cold-start + execution time
- Used bandwidth for the HTTP request headers

### Prediction summary

| Metric | Value |
|--------|-------|
| Requests dispatched | 5 |
| Requests cancelled | 4 |
| Requests completed | 1 |
| Images shown | 5 (from the last surviving fetch) |
| Error shown | None |
| Stale images from old request | None (AbortController + reqIdRef protect this) |
| Loading state | Stays true during clicks, clears when final fetch resolves |
| Buttons disabled during clicks | Only non-active buttons (active mood always clickable) |

---

## Gap: Prediction vs Reality

Opening the network tab and running the test reveals:

### What matched

- 5 requests appear in the network tab (✅ predicted correctly)
- First 4 show "(cancelled)" status (✅ AbortController works as expected)
- Final request returns 200 with 5 images (✅)
- No duplicate images from stale callbacks (✅ reqIdRef guard)
- Loading shimmer stays visible for the correct duration (✅)

### What I got wrong

**My prediction was correct for alternating moods. But I missed an important detail:**

There are two scenarios depending on *which* button the user mashes, and my
prediction only covered one.

### The other scenario: same mood 5 times

If the user clicks "calm" five times fast, line 32 blocks clicks 2–5:

```
click 1: fetchingRef = "calm" → dispatches fetch
click 2: fetchingRef is "calm", mood is "calm" → return early
click 3: return early
click 4: return early
click 5: return early
```

**Network tab: 1 request, not 5.** The dedup guard works so aggressively that
the user can't re-fetch the same mood while it's loading. They have to wait for
the first request to finish, then click again.

This is actually slightly annoying UX: if you click "calm" and immediately realize
you want different "calm" images, you can't. You must wait for the current batch
to load, then click again.

### Third scenario I missed: custom + button interleaving

If the user alternates between a mood button and the custom input Go button:

```
1. Click "calm"       → fetch("calm")   id=1
2. Type "neon" + Go   → fetch("neon")   id=2  (aborts id=1)
3. Click "calm"       → fetch("calm")   id=3  (aborts id=2)
4. Click Go again     → fetch("neon")   id=4  (aborts id=3)
5. Click "loud"       → fetch("loud")   id=5  (aborts id=4)
```

The dedup check on line 32 uses the *exact string* `mood`. Since "neon" !== "calm",
none of these are blocked. All 5 requests fire. 4 get cancelled. Same pattern as
the alternating scenario.

But there's a subtlety: the custom input's Go button respects the same `loading`
guard (`disabled={loading || !customInput.trim()}`). So if `loading` is true,
the Go button is disabled — UNLESS the active mood is the one being fetched
(but the active mood check is only on the mood buttons, not on the Go button).

```
Wait — the Go button disabled logic is:
  disabled={loading || !customInput.trim()}

It does NOT have the activeMood exemption that the mood buttons have:
  disabled={loading && activeMood !== key}
```

This means: if you click "calm" and try to type "neon" while loading, the input
is disabled. You can't even type. The custom input is locked during any fetch.

```
Hmm. So the alternating scenario with the custom input is actually blocked by
the disabled prop on the input field. You can't type while loading.
```

**Revised network tab for realistic rapid clicking:**
1. Click "calm" → 1 request (starts loading)
2. Try to click other moods → buttons are disabled (different mood, loading is true)
3. Try to type custom → input is disabled

The only button not disabled is the currently active mood. So the only rapid-click
scenario that actually works is **spam-clicking the same mood button** — which is
blocked by the `fetchingRef` dedup. So only 1 request fires.

### The real gap

My original prediction assumed all 5 clicks would fire requests. In reality, the
UI-level disabled guards intercept most of them:

| If user mashes... | Network requests | Why |
|------------------|-----------------|-----|
| Same mood button 5× | **1** | Clicks 2–5 blocked by `fetchingRef` dedup (line 32) |
| Different mood buttons | **1, maybe 2** | Non-active buttons disabled during `loading=true`. The first click sets `loading=true`, blocking subsequent different-mood clicks at the UI level. However, there's a tiny window between click 1 and React's re-render where `loading` is still `false` — a second click could slip through. |
| Button + custom input | **1** | Custom input disabled during loading (line 123) |
| Retry button repeatedly | **1** | Retry is disabled? No — looking at line 139, the retry button has no disabled prop. So spamming retry: first click sets fetchingRef, clicks 2–5 are dedup'd (line 32). Still 1 request. |

### What the network tab actually shows

For "alternating moods as fast as possible":

```
1. Click "loud"   → fetch dispatched
   (React hasn't re-rendered yet — loading is still false in DOM)
2. Click "calm"   → sneaks through before React re-render!
   Line 32: fetchingRef("loud") vs mood("calm") → proceeds
   Line 34: abortRef.current?.abort() → cancels loud
   Line 47: fetch("calm") dispatched
3. React re-renders from click 1 → loading=true
4. All subsequent clicks → buttons disabled (loading && activeMood !== key)
```

**Network tab: 2 requests** — not 5. The 2nd click slips through before React paints
the disabled state. Clicks 3–5 are blocked by the DOM-level `disabled` attribute.

### The gap, stated simply

**I predicted 5 requests. The real number is 1 or 2.**

The UI guards (`disabled={loading && ...}`) are faster than a human clicking, but
not faster than two clicks in the same JavaScript frame. The second click can beat
React's commit phase. After that, the DOM is updated and everything is blocked.

This means the AbortController + reqIdRef safeguards are over-engineered for the
actual UX — they protect against a scenario (5 rapid alternating clicks) that the
UI disabled state already prevents. They only matter for the first ~2 clicks that
sneak through before React paints.

### Would I change anything after seeing this?

**No.** The UI guards and the programmatic guards are defense-in-depth layers.
The UI guards work for human click speed. The AbortController + reqIdRef guards
work for programmatic abuse or async edge cases. Both layers cost almost nothing
in code complexity and together cover every scenario.

import { useState, useRef, useEffect, useCallback } from 'react'

type Mood = 'calm' | 'loud' | 'warm' | 'lonely' | 'bright'

interface ImageData {
  url: string
  alt: string
  author: string
  link: string
}

interface SavedBoard {
  id: string
  mood: string
  images: ImageData[]
  savedAt: number
}

const STORAGE_KEY = 'vibe-atlas-boards'

function loadBoards(): SavedBoard[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveBoards(boards: SavedBoard[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(boards))
}

const MOODS: { key: Mood; label: string; emoji: string }[] = [
  { key: 'calm', label: 'Calm', emoji: '🌊' },
  { key: 'loud', label: 'Loud', emoji: '⚡' },
  { key: 'warm', label: 'Warm', emoji: '🔥' },
  { key: 'lonely', label: 'Lonely', emoji: '🌙' },
  { key: 'bright', label: 'Bright', emoji: '☀️' },
]

function App() {
  const [activeMood, setActiveMood] = useState<string | null>(null)
  const [images, setImages] = useState<ImageData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customInput, setCustomInput] = useState('')
  const [savedBoards, setSavedBoards] = useState<SavedBoard[]>([])
  const fetchingRef = useRef<string | null>(null)
  const reqIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const firstImageRef = useRef<HTMLImageElement>(null)

  useEffect(() => {
    setSavedBoards(loadBoards())
  }, [])

  const saveBoard = useCallback(() => {
    if (images.length === 0 || !activeMood) return
    const board: SavedBoard = {
      id: `${activeMood}-${Date.now()}`,
      mood: activeMood,
      images,
      savedAt: Date.now(),
    }
    const updated = [board, ...savedBoards].slice(0, 20)
    setSavedBoards(updated)
    saveBoards(updated)
  }, [images, activeMood, savedBoards])

  const restoreBoard = useCallback((board: SavedBoard) => {
    setImages(board.images)
    setActiveMood(board.mood)
    setError(null)
    setLoading(false)
  }, [])

  const deleteBoard = useCallback((id: string) => {
    const updated = savedBoards.filter((b) => b.id !== id)
    setSavedBoards(updated)
    saveBoards(updated)
  }, [savedBoards])

  async function fetchImages(mood: string) {
    if (fetchingRef.current === mood) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    fetchingRef.current = mood
    setActiveMood(mood)
    setLoading(true)
    setError(null)
    setImages([])

    const id = ++reqIdRef.current

    try {
      const res = await fetch(`/api/unsplash?mood=${encodeURIComponent(mood)}`, {
        signal: controller.signal,
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }

      const data: ImageData[] = await res.json()
      if (id !== reqIdRef.current) return
      setImages(data)
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

  function handleCustomSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = customInput.trim()
    if (!trimmed) return
    fetchImages(trimmed)
  }

  useEffect(() => {
    if (images.length > 0 && firstImageRef.current) {
      firstImageRef.current.focus()
    }
  }, [images])

  return (
    <div className="app">
      <header className="header">
        <h1 className="title">The Vibe Atlas</h1>
        <p className="subtitle">A mood board from the open web</p>
        <p className="tagline">
          Pick a mood or type your own. We'll pull five images from Unsplash to match it.
        </p>
      </header>

      <div className="mood-bar">
        {MOODS.map(({ key, label, emoji }) => (
          <button
            key={key}
            className={`mood-btn ${activeMood === key ? 'active' : ''}`}
            style={
              {
                '--mood-color': `var(--${key})`,
                '--mood-gradient': `linear-gradient(135deg, var(--${key}), color-mix(in srgb, var(--${key}) 70%, white))`,
                '--mood-glow': `var(--${key}-glow)`,
              } as React.CSSProperties
            }
            onClick={() => fetchImages(key)}
            disabled={loading && activeMood !== key}
          >
            <span aria-hidden="true" className="mood-dot" style={{ background: `var(--${key})` }} />
            <span aria-hidden="true">{emoji}</span>
            {label}
          </button>
        ))}
      </div>

      <form className="custom-mood" onSubmit={handleCustomSubmit}>
        <input
          className="custom-input"
          type="text"
          placeholder="Or type any mood…"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          disabled={loading}
        />
        <button
          className="custom-go"
          type="submit"
          disabled={loading || !customInput.trim()}
        >
          Go
        </button>
      </form>

      <div className="content">
        {error && (
          <div className="error-state" role="alert">
            <div className="error-icon">!</div>
            <p className="error-text">{error}</p>
            <button className="retry-btn" onClick={() => activeMood && fetchImages(activeMood)}>
              Try again
            </button>
          </div>
        )}

        {loading && (
          <div className="grid" role="status" aria-label="Loading mood images">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        )}

        {!loading && !error && images.length > 0 && (
          <div className="grid">
            {images.map((img, i) => (
              <div key={`${img.url}-${i}`} className="card">
                <img
                  ref={i === 0 ? firstImageRef : undefined}
                  src={img.url}
                  alt={img.alt}
                  tabIndex={-1}
                  loading="lazy"
                />
                <a
                  href={img.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="credit"
                >
                  {img.author}
                </a>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && images.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">✦</div>
            <p>Choose a mood above or type one in</p>
          </div>
        )}
      </div>

      {!loading && !error && images.length > 0 && (
        <button className="save-btn" onClick={saveBoard}>
          Save this board
        </button>
      )}

      {savedBoards.length > 0 && (
        <div className="saved-section">
          <h2 className="saved-title">Saved boards</h2>
          <div className="saved-grid">
            {savedBoards.map((board) => (
              <div key={board.id} className="saved-card">
                <div className="saved-preview" onClick={() => restoreBoard(board)}>
                  <img src={board.images[0].url} alt="" />
                  <span className="saved-mood">{board.mood}</span>
                </div>
                <button
                  className="saved-delete"
                  onClick={() => deleteBoard(board.id)}
                  aria-label={`Delete ${board.mood} board`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <footer className="footer">
        <a
          href="https://unsplash.com"
          target="_blank"
          rel="noopener noreferrer"
          className="unsplash-attribution"
        >
          Photos from Unsplash
        </a>
      </footer>
    </div>
  )
}

export default App

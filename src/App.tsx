import { useState, useRef } from 'react'

type Mood = 'calm' | 'loud' | 'warm' | 'lonely' | 'bright'

const MOODS: { key: Mood; label: string; emoji: string }[] = [
  { key: 'calm', label: 'Calm', emoji: '🌊' },
  { key: 'loud', label: 'Loud', emoji: '⚡' },
  { key: 'warm', label: 'Warm', emoji: '🔥' },
  { key: 'lonely', label: 'Lonely', emoji: '🌙' },
  { key: 'bright', label: 'Bright', emoji: '☀️' },
]

function App() {
  const [activeMood, setActiveMood] = useState<Mood | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchingRef = useRef<Mood | null>(null)
  const reqIdRef = useRef(0)

  async function fetchImages(mood: Mood) {
    if (fetchingRef.current === mood) return
    fetchingRef.current = mood
    setActiveMood(mood)
    setLoading(true)
    setError(null)
    setImages([])

    const id = ++reqIdRef.current

    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          fetch(`https://picsum.photos/seed/${mood}${i + 1}/800/600`)
            .then((res) => {
              if (!res.ok) throw new Error(`Request failed (${res.status})`)
              return res.url
            }),
        ),
      )
      if (id !== reqIdRef.current) return
      setImages(results)
    } catch (e) {
      if (id !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      if (id === reqIdRef.current) {
        setLoading(false)
        fetchingRef.current = null
      }
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1 className="title">The Vibe Atlas</h1>
        <p className="subtitle">A mood board from the open web</p>
        <p className="tagline">
          Pick a mood. We'll pull five images from the web to match it.
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
            disabled={loading}
          >
            <span className="mood-dot" style={{ background: `var(--${key})` }} />
            {emoji} {label}
          </button>
        ))}
      </div>

      <div className="content">
        {error && (
          <div className="error-state">
            <div className="error-icon">!</div>
            <p className="error-text">{error}</p>
            <button className="retry-btn" onClick={() => activeMood && fetchImages(activeMood)}>
              Try again
            </button>
          </div>
        )}

        {loading && (
          <div className="grid">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" />
            ))}
          </div>
        )}

        {!loading && !error && images.length > 0 && (
          <div className="grid">
            {images.map((url, i) => (
              <div key={i} className="card">
                <img
                  src={url}
                  alt={`${activeMood} mood image ${i + 1}`}
                  loading="lazy"
                />
              </div>
            ))}
          </div>
        )}

        {!loading && !error && images.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">✦</div>
            <p>Choose a mood above to curate your board</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default App

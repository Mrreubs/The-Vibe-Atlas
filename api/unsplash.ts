import type { VercelRequest, VercelResponse } from '@vercel/node'

interface UnsplashPhoto {
  urls: { regular: string }
  alt_description: string | null
  user: { name: string; links: { html: string } }
  links: { html: string }
}

interface ImageResult {
  url: string
  alt: string
  author: string
  link: string
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  response.setHeader('Access-Control-Allow-Origin', '*')

  const { mood } = request.query

  if (!mood || typeof mood !== 'string' || mood.length === 0) {
    return response.status(400).json({ error: 'Missing or invalid mood parameter' })
  }

  const UNSPLASH_KEY = process.env.UNSPLASH_KEY

  if (!UNSPLASH_KEY) {
    return response.status(500).json({ error: 'Server misconfigured' })
  }

  try {
    const res = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(mood)}&count=5&client_id=${UNSPLASH_KEY}`,
      {
        headers: { 'Accept-Version': 'v1' },
      },
    )

    if (res.status === 429) {
      return response.status(429).json({ error: 'Rate limited. Please wait a moment and try again.' })
    }

    if (!res.ok) {
      const body = await res.text()
      return response.status(res.status).json({ error: `Unsplash API error (${res.status}): ${body}` })
    }

    const data = await res.json() as UnsplashPhoto[]

    const images: ImageResult[] = data.map((p) => ({
      url: p.urls.regular,
      alt: p.alt_description || `Photo by ${p.user.name}`,
      author: p.user.name,
      link: p.links.html,
    }))

    return response.status(200).json(images)
  } catch (e) {
    return response.status(500).json({ error: 'Failed to fetch from Unsplash' })
  }
}

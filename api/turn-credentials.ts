import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = process.env.TURN_SECRET
  const turnUrl = process.env.TURN_URL

  if (!secret || !turnUrl) {
    return res.status(503).json({ error: 'TURN not configured' })
  }

  // Ephemeral credentials valid for 24 hours
  const ttl = 24 * 3600
  const expiry = Math.floor(Date.now() / 1000) + ttl
  const username = `${expiry}:manifest`
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64')

  res.setHeader('Cache-Control', 'public, max-age=43200')
  return res.json({
    username,
    credential,
    urls: [
      `turn:${turnUrl}:3478`,
      `turn:${turnUrl}:3478?transport=tcp`,
    ],
    ttl,
  })
}

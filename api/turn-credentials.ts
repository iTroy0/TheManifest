import type { VercelRequest, VercelResponse } from '@vercel/node'
import crypto from 'crypto'

// Simple per-IP in-memory rate limiter (resets on cold start)
const ipBuckets = new Map<string, { count: number; windowStart: number }>()
const RATE_LIMIT_WINDOW_MS = 60 * 1000 // 1 minute
const RATE_LIMIT_MAX = 10 // 10 requests per minute per IP

function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim()
  if (Array.isArray(forwarded)) return forwarded[0]
  return req.socket?.remoteAddress || 'unknown'
}

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const bucket = ipBuckets.get(ip)
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    ipBuckets.set(ip, { count: 1, windowStart: now })
    // Periodic cleanup to prevent unbounded growth
    if (ipBuckets.size > 1000) {
      for (const [k, v] of ipBuckets) {
        if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) ipBuckets.delete(k)
      }
    }
    return false
  }
  bucket.count++
  return bucket.count > RATE_LIMIT_MAX
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ip = getClientIp(req)
  if (isRateLimited(ip)) {
    res.setHeader('Retry-After', '60')
    return res.status(429).json({ error: 'Rate limit exceeded' })
  }

  const secret = process.env.TURN_SECRET
  const turnUrl = process.env.TURN_URL

  if (!secret || !turnUrl) {
    return res.status(503).json({ error: 'TURN not configured' })
  }

  // Ephemeral credentials valid for 2 hours (enough for any realistic transfer)
  const ttl = 2 * 3600
  const expiry = Math.floor(Date.now() / 1000) + ttl
  const username = `${expiry}:manifest`
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64')

  // Private cache: never shared by CDNs/proxies
  res.setHeader('Cache-Control', 'private, no-store')
  return res.json({
    username,
    credential,
    urls: [
      `turn:${turnUrl}:3478`,
      `turn:${turnUrl}:3478?transport=tcp`,
      `turns:${turnUrl}:5349?transport=tcp`,
      `turns:${turnUrl}:443?transport=tcp`,
    ],
    ttl,
  })
}

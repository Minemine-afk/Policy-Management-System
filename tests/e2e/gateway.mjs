// Test-only stand-in for the Supabase API gateway (Kong) + Storage API.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

const SECRET = 'super-secret-jwt-token-with-at-least-32-characters-long'
const pool = new pg.Pool({ connectionString: 'postgres://postgres:pw@127.0.0.1:5432/e2e' })
const FILES = new URL('./files', import.meta.url).pathname
fs.mkdirSync(FILES, { recursive: true })

const b64 = (s) => Buffer.from(s, 'base64url')
function verify(token) {
  if (!token) return null
  const [h, p, s] = token.split('.')
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')
  if (sig !== s) return null
  const claims = JSON.parse(b64(p).toString())
  if (claims.exp && claims.exp < Date.now() / 1000) return null
  return claims
}
function sign(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`
}
async function asUser(claims, fn) {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)`, [claims.role, JSON.stringify(claims)])
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) { await c.query('rollback'); throw e } finally { c.release() }
}
const cors = {
  'access-control-allow-origin': '*', 'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*',
}
function json(res, code, body) { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const readBody = (req) => new Promise((r) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => r(Buffer.concat(ch))) })

function proxy(req, res, port, prefix) {
  const p = http.request({ host: '127.0.0.1', port, path: req.url.slice(prefix.length) || '/', method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (up) => {
    res.writeHead(up.statusCode, { ...up.headers, ...cors }); up.pipe(res)
  })
  p.on('error', (e) => json(res, 502, { message: e.message }))
  req.pipe(p)
}

async function storage(req, res) {
  const url = new URL(req.url, 'http://x')
  const parts = url.pathname.replace('/storage/v1/', '').split('/').map(decodeURIComponent)
  const token = (req.headers.authorization || '').replace(/^Bearer /, '')
  const claims = verify(token)
  try {
    if (parts[0] === 'object' && parts[1] === 'sign' && req.method === 'GET') {
      const t = verify(url.searchParams.get('token'))
      const key = parts.slice(2).join('/')
      if (!t || t.url !== key) return json(res, 400, { message: 'Invalid signature' })
      res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' })
      return res.end(fs.readFileSync(path.join(FILES, key)))
    }
    if (!claims) return json(res, 401, { message: 'Invalid JWT' })
    if (parts[0] === 'object' && parts[1] === 'sign' && req.method === 'POST') {
      const [bucket, ...rest] = parts.slice(2); const name = rest.join('/')
      const { rows } = await asUser(claims, (c) => c.query('select 1 from storage.objects where bucket_id=$1 and name=$2', [bucket, name]))
      if (!rows.length) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' })
      const body = JSON.parse((await readBody(req)).toString() || '{}')
      const tok = sign({ url: `${bucket}/${name}`, exp: Math.floor(Date.now() / 1000) + (body.expiresIn || 60) })
      return json(res, 200, { signedURL: `/object/sign/${bucket}/${rest.map(encodeURIComponent).join('/')}?token=${tok}` })
    }
    if (parts[0] === 'object' && req.method === 'GET') {
      const [bucket, ...rest] = parts.slice(parts[1] === 'authenticated' ? 2 : 1); const name = rest.join('/')
      const { rows } = await asUser(claims, (c) => c.query('select 1 from storage.objects where bucket_id=$1 and name=$2', [bucket, name]))
      if (!rows.length) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' })
      res.writeHead(200, { ...cors, 'content-type': 'application/octet-stream' })
      return res.end(fs.readFileSync(path.join(FILES, bucket, name)))
    }
    if (parts[0] === 'object' && req.method === 'POST') {
      const [bucket, ...rest] = parts.slice(1); const name = rest.join('/')
      const buf = await readBody(req)
      let data = buf
      if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: buf }).formData()
        for (const [, v] of form) if (typeof v !== 'string') data = Buffer.from(await v.arrayBuffer())
      }
      await asUser(claims, (c) => c.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, name]))
      fs.mkdirSync(path.dirname(path.join(FILES, bucket, name)), { recursive: true })
      fs.writeFileSync(path.join(FILES, bucket, name), data)
      return json(res, 200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() })
    }
    if (parts[0] === 'object' && req.method === 'DELETE') {
      const bucket = parts[1]
      const { prefixes } = JSON.parse((await readBody(req)).toString())
      const { rows } = await asUser(claims, (c) => c.query('delete from storage.objects where bucket_id=$1 and name = any($2) returning name', [bucket, prefixes]))
      return json(res, 200, rows)
    }
    json(res, 404, { message: 'not implemented in test gateway' })
  } catch (e) {
    json(res, 400, { statusCode: '403', error: 'Unauthorized', message: e.message })
  }
}

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end() }
  if (req.url.startsWith('/rest/v1')) return proxy(req, res, 3000, '/rest/v1')
  if (req.url.startsWith('/auth/v1')) return proxy(req, res, 9999, '/auth/v1')
  if (req.url.startsWith('/storage/v1')) return storage(req, res)
  json(res, 404, { message: 'unknown route' })
}).listen(54321, '127.0.0.1', () => console.log('gateway on 54321'))
console.log('anon key', sign({ role: 'anon', iss: 'supabase-demo', exp: 1983812996 }))

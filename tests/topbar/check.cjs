// Top bar layout check: every role and module mix, every page, at phone / small laptop / 1366 / 1920 widths.
// No database needed: Supabase is faked in the browser (route interception), so this only checks layout.
// Run from the repo root:  node tests/topbar/check.cjs [outDir]   (needs `npm ci` in web/ and Playwright)
// Screenshots go to outDir (default tests/topbar/shots). Exits 1 on any failure.
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const { chromium } = require('playwright')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'shots'))
const PORT = 5199
const BASE = `http://127.0.0.1:${PORT}`
const SB = 'http://127.0.0.1:54321'
const WIDTHS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'laptop-1280', width: 1280, height: 720 },   // a 1920 screen at 150% scaling
  { name: 'laptop-1366', width: 1366, height: 768 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
]
const ALL = ['pi_requests', 'product_matrix', 'knowledge_hub']
const USERS = [
  { key: 'introducer-all', role: 'introducer', name: '[Sample] Aisha Introducer', modules: ALL,
    links: ['Modules', 'New request', 'Board', 'My requests', 'Compare products', 'Knowledge Hub'] },
  { key: 'introducer-no-kb', role: 'introducer', name: '[Sample] Aisha Introducer', modules: ['pi_requests', 'product_matrix'],
    links: ['Modules', 'New request', 'Board', 'My requests', 'Compare products'] },
  { key: 'introducer-pi-only', role: 'introducer', name: 'Sam Introducer', modules: ['pi_requests'],
    links: ['Modules', 'New request', 'Board', 'My requests'] },
  { key: 'introducer-long-name', role: 'introducer', name: '[Sample] Nurul Aisyah binte Mohamed Abdul Rahman', modules: ALL,
    links: ['Modules', 'New request', 'Board', 'My requests', 'Compare products', 'Knowledge Hub'] },
  { key: 'ops', role: 'ops', name: '[Sample] Farah Ops', modules: ALL,
    links: ['Modules', 'Board', 'Backlog', 'Compare products', 'Knowledge Hub'] },
  { key: 'bsd', role: 'bsd', name: '[Sample] Pat BSD', modules: ALL,
    links: ['Modules', 'Board', 'Backlog', 'PI reader', 'Compare products', 'Knowledge Hub'] },
  { key: 'admin', role: 'admin', name: '[Sample] Alex Admin', modules: [], links: ['Modules', 'Admin'] },
]
const ROUTES = { 'Modules': '/home', 'New request': '/requests/new', 'Board': '/board', 'My requests': '/backlog', 'Backlog': '/backlog',
  'PI reader': '/reader', 'Compare products': '/matrix', 'Knowledge Hub': '/kb', 'Admin': '/admin' }

let failed = 0, passed = 0
const fail = (m) => { failed++; console.log('FAIL', m) }
const check = (c, m) => (c ? passed++ : fail(m))

function fakeSupabase(user) {
  const id = '00000000-0000-0000-0000-0000000000aa'
  const email = user.key + '@example.com'
  const profile = { id, full_name: user.name, email, company: 'Sample Co', role: user.role, active: true, email_alerts: false, created_at: '2026-01-01T00:00:00Z' }
  const authUser = { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  const session = { access_token: 'x.y.z', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user: authUser }
  return { profile, authUser, session }
}

async function route(page, user) {
  const { profile, authUser } = fakeSupabase(user)
  await page.route(`${SB}/**`, (r) => {
    const req = r.request(), url = new URL(req.url()), p = url.pathname
    const json = (body, headers = {}) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0', ...headers }, body: JSON.stringify(body) })
    if (p.startsWith('/auth/v1/user')) return json(authUser)
    if (p.startsWith('/auth/v1/')) return json({})
    if (p === '/rest/v1/rpc/my_modules') return json(user.modules)
    if (p.startsWith('/rest/v1/rpc/')) return json(null)
    if (p === '/rest/v1/profiles' && url.searchParams.get('id') === `eq.${profile.id}`) {
      const single = (req.headers()['accept'] || '').includes('vnd.pgrst.object')
      return json(single ? profile : [profile])
    }
    if (req.method() === 'HEAD') return r.fulfill({ status: 200, headers: { 'content-range': '*/0' }, body: '' })
    if (p.startsWith('/storage/')) return json([])
    return json([])
  })
}

async function topbarFacts(page) {
  return page.evaluate(() => {
    const h = document.querySelector('header.topbar')
    if (!h) return null
    const hb = h.getBoundingClientRect()
    const box = (sel) => { const e = h.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); const cs = getComputedStyle(e); return { l: b.left, r: b.right, t: b.top, b: b.bottom, visible: cs.display !== 'none' && cs.visibility !== 'hidden' && b.width > 0 } }
    const links = [...h.querySelectorAll('nav.main-nav a')].map((a) => { const b = a.getBoundingClientRect(); return { text: a.textContent.trim(), t: b.top, b: b.bottom, r: b.right, w: b.width } })
    return {
      height: hb.height, headerOverflow: h.scrollWidth - h.clientWidth, pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
      brand: box('.brand'), nav: box('nav.main-nav'), user: box('.user-btn'), bell: box('.bell'), menu: box('.menu-btn'), links,
    }
  })
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const vite = spawn(path.join(ROOT, 'web/node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: path.join(ROOT, 'web'), env: { ...process.env, VITE_SUPABASE_URL: SB, VITE_SUPABASE_ANON_KEY: 'anon' }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((res, rej) => { vite.stdout.on('data', (d) => { if (String(d).includes('Local')) res() }); vite.on('exit', () => rej(new Error('vite exited'))) })
  const browser = await chromium.launch()
  const errors = []
  try {
    // The login page: centred card, brand, no top bar.
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1 })
      const page = await ctx.newPage()
      await route(page, USERS[0])
      await page.goto(BASE)
      await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor()
      const f = await page.evaluate(() => {
        const c = document.querySelector('.login .card').getBoundingClientRect()
        return { topbar: !!document.querySelector('header.topbar'), left: c.left, right: window.innerWidth - c.right, top: c.top, bottom: window.innerHeight - c.bottom, overflow: document.documentElement.scrollWidth - window.innerWidth }
      })
      check(!f.topbar, `login ${w.name}: no top bar on the sign-in page`)
      check(Math.abs(f.left - f.right) <= 2, `login ${w.name}: card centred left/right (${f.left} vs ${f.right})`)
      check(f.overflow <= 0, `login ${w.name}: no sideways scroll`)
      check(await page.locator('.login .brand-mark').isVisible(), `login ${w.name}: brand shown`)
      await page.screenshot({ path: path.join(OUT, `login-${w.name}.png`) })
      await ctx.close()
    }

    for (const user of USERS) {
      for (const w of WIDTHS) {
        const ctx = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1 })
        const { session } = fakeSupabase(user)
        await ctx.addInitScript((s) => { localStorage.setItem('sb-127-auth-token', s) }, JSON.stringify(session))
        const page = await ctx.newPage()
        page.on('pageerror', (e) => errors.push(`${user.key} ${w.name}: ${e.message}`))
        await route(page, user)
        const tag = `${user.key} ${w.name}`
        const pages = [...new Set([...user.links.map((l) => ROUTES[l]), '/notifications', '/account'])]
        for (const to of pages) {
          await page.goto(BASE + to)
          await page.locator('header.topbar .who').waitFor()
          await page.waitForTimeout(150)
          const f = await topbarFacts(page)
          const at = `${tag} ${to}`
          check(f.height <= 61, `${at}: top bar is one row (height ${f.height})`)
          check(f.headerOverflow <= 0, `${at}: nothing in the top bar spills out (${f.headerOverflow}px)`)
          check(f.brand.visible && f.bell.visible, `${at}: brand and bell shown`)
          if (w.width >= 1100) {
            check(f.nav.visible && f.user.visible && !f.menu.visible, `${at}: full links + user menu, no Menu button`)
            check(JSON.stringify(f.links.map((l) => l.text)) === JSON.stringify(user.links), `${at}: links are ${user.links.join(', ')} (got ${f.links.map((l) => l.text).join(', ')})`)
            check(f.links.every((l) => l.t >= 0 && l.b <= f.height + 0.5 && l.w > 0), `${at}: every link sits inside the bar`)
            const lastLink = Math.max(0, ...f.links.map((l) => l.r))
            check(lastLink < f.bell.l, `${at}: links end before the bell/user menu`)
            check(w.width - f.user.r <= 40, `${at}: user menu is right-aligned (${w.width - f.user.r}px from the edge)`)
          } else {
            check(!f.nav.visible && !f.user.visible && f.menu.visible, `${at}: links folded into the Menu button`)
            check(w.width - f.menu.r <= 40, `${at}: Menu button on the right`)
          }
          if (to === '/home' || to === ROUTES[user.links[1]]) {
            await page.screenshot({ path: path.join(OUT, `${user.key}-${w.name}${to.replace(/\//g, '_')}.png`) })
          }
        }
        // The menus open, list everything, and close.
        await page.goto(BASE + '/home')
        await page.locator('header.topbar .who').waitFor()
        if (w.width >= 1100) {
          await page.locator('.topbar .user-btn').click()
          check(await page.getByRole('menuitem', { name: /Account/ }).isVisible(), `${tag}: user menu has Account`)
          check(await page.getByRole('menuitem', { name: 'Sign out' }).isVisible(), `${tag}: user menu has Sign out`)
          await page.screenshot({ path: path.join(OUT, `${user.key}-${w.name}_user-menu.png`) })
          await page.keyboard.press('Escape')
          check(await page.getByRole('menuitem', { name: 'Sign out' }).count() === 0, `${tag}: Escape closes the user menu`)
        } else {
          await page.getByRole('button', { name: 'Menu' }).click()
          const menu = page.locator('#mobile-menu')
          const texts = await menu.getByRole('navigation').getByRole('link').allTextContents()
          check(JSON.stringify(texts) === JSON.stringify(user.links), `${tag}: Menu lists ${user.links.join(', ')} (got ${texts.join(', ')})`)
          check(await menu.getByRole('button', { name: 'Sign out' }).isVisible(), `${tag}: Menu has Sign out`)
          check(await menu.getByRole('link', { name: /Account/ }).isVisible(), `${tag}: Menu has Account`)
          check(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: open Menu adds no sideways scroll`)
          await page.screenshot({ path: path.join(OUT, `${user.key}-${w.name}_menu-open.png`) })
          const last = user.links[user.links.length - 1]
          await menu.getByRole('link', { name: last, exact: true }).click()
          await page.waitForURL((u) => u.pathname.startsWith(ROUTES[last]))
          check(await page.locator('#mobile-menu').waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false), `${tag}: Menu closes after picking a link`)
        }
        await ctx.close()
      }
    }
  } finally {
    await browser.close()
    vite.kill()
  }
  for (const e of errors.slice(0, 10)) console.log('page error:', e)
  console.log(`${passed} passed, ${failed} failed. Screenshots in ${OUT}`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })

import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { ROLE_LABEL } from '../lib/options'
import { fmtNum } from '../lib/num'
import type { Profile } from '../lib/types'

export interface NavItem { to: string; label: string }

/**
 * The one top bar for every role: brand left, the user's links next, and on the right the bell and a
 * user menu (name and role; Account and Sign out inside it). Below 1100px wide the links and the user menu
 * fold into one "Menu" button, so the bar never wraps onto a second row.
 */
export default function TopBar({ items, profile, unread }: { items: NavItem[]; profile: Profile; unread: number }) {
  const ref = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  // A menu stays open only on the page it was opened on, so picking a link closes it.
  const [menu, setMenu] = useState<{ kind: '' | 'user' | 'nav'; at: string }>({ kind: '', at: '' })
  const open = menu.at === pathname ? menu.kind : ''
  const setOpen = (kind: '' | 'user' | 'nav') => setMenu({ kind, at: pathname })

  // Close the menus on a click outside the bar, or Escape.
  useEffect(() => {
    if (!open) return
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setMenu({ kind: '', at: '' }) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu({ kind: '', at: '' }) }
    document.addEventListener('mousedown', click)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key) }
  }, [open])

  const name = profile.full_name || profile.email
  const role = ROLE_LABEL[profile.role ?? ''] ?? profile.role ?? ''
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  const signOut = () => supabase.auth.signOut()

  return (
    <header className={`topbar${open === 'nav' ? ' menu-open' : ''}`} ref={ref}>
      <Link to="/home" className="brand">PWS Service Hub</Link>
      <nav aria-label="Main" className="main-nav">
        {items.map((i) => <NavLink key={i.to} to={i.to} className={cls}>{i.label}</NavLink>)}
      </nav>
      <div className="who">
        <NavLink to="/notifications" className={({ isActive }) => `bell${isActive ? ' active' : ''}`} aria-label={`Notifications${unread ? `, ${fmtNum(unread)} unread` : ''}`}>
          <span aria-hidden="true">🔔</span>{unread > 0 && <span className="badge">{fmtNum(unread)}</span>}
        </NavLink>
        <div className="user-menu">
          <button type="button" className="user-btn" aria-haspopup="menu" aria-expanded={open === 'user'}
            onClick={() => setOpen(open === 'user' ? '' : 'user')} title={`${name} · ${role}`}>
            <span className="avatar" aria-hidden="true">{initials(name)}</span>
            <span className="user-text"><span className="user-name">{name}</span><span className="user-role">{role}</span></span>
            <span className="caret" aria-hidden="true">▾</span>
          </button>
          {open === 'user' && (
            <div className="dropdown" role="menu">
              <div className="dropdown-head"><strong>{name}</strong><span className="muted small">{role}{profile.email && profile.full_name ? ` · ${profile.email}` : ''}</span></div>
              <Link role="menuitem" to="/account">Account (change password)</Link>
              <button role="menuitem" type="button" onClick={signOut}>Sign out</button>
            </div>
          )}
        </div>
        <button type="button" className="menu-btn" aria-expanded={open === 'nav'} aria-controls="mobile-menu"
          onClick={() => setOpen(open === 'nav' ? '' : 'nav')}>
          <span aria-hidden="true">{open === 'nav' ? '✕' : '☰'}</span> Menu
        </button>
      </div>
      {open === 'nav' && (
        <div className="mobile-menu" id="mobile-menu">
          <nav aria-label="Main (menu)">
            {items.map((i) => <NavLink key={i.to} to={i.to} className={cls}>{i.label}</NavLink>)}
          </nav>
          <div className="mobile-user">
            <div><strong>{name}</strong> <span className="muted-nav">· {role}</span></div>
            <NavLink to="/account" className={cls}>Account (change password)</NavLink>
            <button type="button" onClick={signOut}>Sign out</button>
          </div>
        </div>
      )}
    </header>
  )
}

function initials(name: string) {
  const words = name.replace(/\[[^\]]*\]/g, ' ').replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase() || '?'
}

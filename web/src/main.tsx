import './storageFallback'
import { StrictMode, useState, type FormEvent, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './App.css'
import { LanguageProvider, useT } from './i18n'
import { discardVault, hasVault, unlockVault } from './vault'
import {
  SYNC_CATEGORIES,
  accountInfo,
  formatAccountNumber,
  loginSyncAccount,
  normalizePassword,
  pullAtStartup,
  resolveConflict,
  startAutoSync,
  syncErrorKey,
  takeSyncLink,
} from './sync'

const root = createRoot(document.getElementById('root')!)

// App reads its stored identities/favorites while loading, so it's imported only after the vault is open
// and the sync account (Options -> Konto) had its chance to bring in newer data.
async function start() {
  const { default: App } = await import('./App.tsx')
  startAutoSync()
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

const dialog = (node: ReactNode) => root.render(<LanguageProvider>{node}</LanguageProvider>)

async function boot() {
  const link = takeSyncLink()
  if (link) return dialog(<SyncLinkDialog link={link} />)
  // Don't hold the client hostage to a slow sync server.
  const deadline = Date.now() + 5000
  const result = await Promise.race([
    pullAtStartup(deadline),
    new Promise<'ok'>((resolve) => setTimeout(() => resolve('ok'), 5000)),
  ])
  if (result === 'conflict') return dialog(<SyncConflictDialog />)
  void start()
}

/** Opened through the QR code / link from Options -> Konto on another device. */
function SyncLinkDialog({ link }: { link: { number: string; password?: string; server: string } }) {
  const t = useT()
  const [password, setPassword] = useState(link.password ?? '')
  const [askPassword, setAskPassword] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (!password) {
        const info = await accountInfo(link.number, link.server)
        if (!info.exists) throw new Error('not_found')
        if (info.hasPassword) {
          setAskPassword(true)
          setBusy(false)
          return
        }
      }
      await loginSyncAccount(link.number, password ? normalizePassword(password) : undefined, link.server, SYNC_CATEGORIES)
      void start()
    } catch (err) {
      setError(t(syncErrorKey(err)))
      setBusy(false)
    }
  }
  return (
    <div className="ts-dialog-backdrop">
      <form className="ts-dialog ts-vault-dialog" onSubmit={submit}>
        <h3>{t('sync.link.title')}</h3>
        <p>{t('sync.link.prompt', { number: formatAccountNumber(link.number) })}</p>
        {askPassword && (
          <label className="ts-dialog-field">
            {t('sync.password')}
            <input autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {error && <p className="ts-vault-wrong">{error}</p>}
        <div className="ts-dialog-buttons">
          <button type="button" onClick={() => void start()}>
            {t('dialog.cancel')}
          </button>
          <button type="submit" disabled={busy || (askPassword && !password)}>
            {t('sync.link.connect')}
          </button>
        </div>
      </form>
    </div>
  )
}

function SyncConflictDialog() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const take = async (side: 'server' | 'local') => {
    setBusy(true)
    try {
      await resolveConflict(side)
    } finally {
      void start()
    }
  }
  return (
    <div className="ts-dialog-backdrop">
      <div className="ts-dialog ts-vault-dialog">
        <h3>{t('sync.conflict.title')}</h3>
        <p>{t('sync.conflict.text')}</p>
        <div className="ts-dialog-buttons">
          <button disabled={busy} onClick={() => void take('local')}>
            {t('sync.conflict.local')}
          </button>
          <button disabled={busy} onClick={() => void take('server')}>
            {t('sync.conflict.server')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Unlock() {
  const t = useT()
  const [password, setPassword] = useState('')
  const [wrong, setWrong] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    if (await unlockVault(password)) return void boot()
    setBusy(false)
    setWrong(true)
  }
  return (
    <div className="ts-dialog-backdrop">
      <form className="ts-dialog ts-vault-dialog" onSubmit={submit}>
        <h3>{t('vault.title')}</h3>
        <p>{t('vault.prompt')}</p>
        <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        {wrong && <p className="ts-vault-wrong">{t('vault.wrong')}</p>}
        <div className="ts-dialog-buttons">
          <button
            type="button"
            onClick={() => {
              if (!window.confirm(t('vault.forgotConfirm'))) return
              discardVault()
              void boot()
            }}
          >
            {t('vault.forgot')}
          </button>
          <button type="submit" disabled={busy || !password}>
            {t('vault.unlock')}
          </button>
        </div>
      </form>
    </div>
  )
}

if (hasVault())
  root.render(
    <LanguageProvider>
      <Unlock />
    </LanguageProvider>,
  )
else void boot()

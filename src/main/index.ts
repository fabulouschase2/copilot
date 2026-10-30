/**
 * Application entry point: lifecycle, single instance, service wiring,
 * global shortcut (Ctrl+Alt+C toggles the copilot window).
 */
import { app, globalShortcut, session } from 'electron'
import { registerIpcHandlers } from './ipc'
import { ChatController } from './services/chat-controller'
import { ContextEngine } from './services/context-engine'
import { CredentialStore, SafeStorageLike } from './services/credential-store'
import { PermissionGate } from './services/audio/permission-gate'
import { ProviderRegistry } from './services/provider-registry'
import { SettingsStore } from './services/settings-store'
import { SttRegistry } from './services/stt/stt-registry'
import { TranscriptService } from './services/transcription-service'
import { ElectronScreenBackend } from './services/screen/screen-backend'
import { ScreenService } from './services/screen/screen-service'
import { ContextService } from './services/context/context-service'
import { SQLiteStore } from './services/context/sqlite-store'
import { migrateLegacyJson } from './services/context/migration'
import { MeetingSaveRequestSchema } from '../shared/protocol'
import { ModesService } from './services/modes/modes-service'
import { PracticeService } from './services/practice/practice-service'
import { createMainWindow, getMainWindow, toggleWindowVisible } from './window'
import { electronAccelerators } from '../shared/shortcuts'
import { dialog } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Consent TTL for screen analysis; captures never outlive an explicit arm. */
const SCREEN_CONSENT_TTL_MS = 5 * 60_000

const SINGLE_INSTANCE_LOCK = app.requestSingleInstanceLock()
if (!SINGLE_INSTANCE_LOCK) {
  app.quit()
} else {
  // Windows GPU-stack fix: on some hybrid-graphics machines the window
  // presents as solid black on screen while the compositor buffer still
  // holds the UI (verified live on the dev laptop during the Stage 10 GUI
  // smoke test). Software presentation is cheap for this UI.
  app.disableHardwareAcceleration()

  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    // Optional measurement harness: real capture, no provider, then exit.
    if (process.env['COPILOT_SELFTEST'] === 'screen') {
      void import('./selftest').then(async ({ runScreenSelfTest }) => {
        await runScreenSelfTest()
        app.exit(0)
      })
      return
    }
    if (process.env['COPILOT_SELFTEST'] === 'provider-setup') {
      void import('./selftest').then(async ({ runProviderSetup }) => {
        await runProviderSetup()
      })
      return
    }
    if (process.env['COPILOT_SELFTEST'] === 'provider-raw') {
      void import('./selftest').then(async ({ runProviderRaw }) => {
        await runProviderRaw()
      })
      return
    }
    if (process.env['COPILOT_SELFTEST'] === 'empty-probe') {
      void import('./selftest').then(async ({ runEmptyProbe }) => {
        await runEmptyProbe()
      })
      return
    }
    if (process.env['COPILOT_SELFTEST'] === 'provider-probe') {
      void import('./selftest').then(async ({ runProviderProbe }) => {
        await runProviderProbe()
      })
      return
    }
    if (process.env['COPILOT_SELFTEST'] === 'provider-verify') {
      void import('./selftest').then(async ({ runProviderVerify }) => {
        await runProviderVerify()
      })
      return
    }

    const userData = app.getPath('userData')
    const settings = SettingsStore.forUserData(userData)
    const creds = CredentialStore.forUserData(userData, getSafeStorage())
    const registry = new ProviderRegistry(settings, creds)
    const sttRegistry = new SttRegistry(settings, creds)
    const context = new ContextEngine()
    // Stage 9: SQLite-backed persistence with one-shot legacy JSON migration.
    let contextSqlite = new SQLiteStore(path.join(userData, 'context.db'))
    const migrationResult = migrateLegacyJson(contextSqlite, path.join(userData, 'context-store.json'))
    if (migrationResult.status === 'quarantined' || migrationResult.status === 'failed') {
      console.warn('[persistence]', migrationResult.status, migrationResult.message ?? '')
    }
    const contextService = new ContextService({
      store: contextSqlite,
      engine: context,
      settings: () => settings.get().context,
      activeProfileId: () => settings.get().activeProfileId,
      getWindow: getMainWindow
    })
    const responseLanguage = (): string => settings.get().responseLanguage
    const chat = new ChatController(registry, (question) =>
      contextService.retrieve(question, {
        includeDocuments: true,
        includeProfile: true,
        includeSession: true
      })
    )
    const modes = new ModesService({
      resolveProvider: () => {
        const r = registry.resolveActive()
        return r ? { provider: r.provider, model: r.model } : null
      },
      retrieve: (question, options) => contextService.retrieve(question, options),
      getSessionId: () => contextService.sessionId,
      getResponseLanguage: responseLanguage,
      getSavedMeetingTranscript: (meetingId) => {
        try {
          const m = contextSqlite.getMeeting(meetingId)
          return m ? m.transcript : null
        } catch {
          return null
        }
      },
      // User-initiated save dialog; content is what the user edited.
      saveText: async (defaultName, content) => {
        const win = getMainWindow()
        const picked = await dialog.showSaveDialog(win ?? (undefined as never), {
          title: 'Export notes',
          defaultPath: defaultName,
          filters: [
            { name: 'Notes', extensions: [defaultName.endsWith('.md') ? 'md' : 'txt'] }
          ]
        })
        if (picked.canceled || !picked.filePath) return { ok: false, canceled: true }
        try {
          await fs.promises.writeFile(picked.filePath, content, 'utf-8')
          return { ok: true }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : 'Could not write file' }
        }
      }
    })
    const practice = new PracticeService({
      store: contextSqlite,
      resolveProvider: () => {
        const r = registry.resolveActive()
        return r ? { provider: r.provider, model: r.model } : null
      },
      getProfileFacts: (profileId) => {
        try {
          return contextSqlite.listFacts(profileId).map((f) => f.text)
        } catch {
          return []
        }
      },
      getResponseLanguage: responseLanguage
    })
    const permissionGate = new PermissionGate()
    const screenGate = new PermissionGate(SCREEN_CONSENT_TTL_MS)
    const transcript = new TranscriptService(
      () => sttRegistry.resolveActive(),
      context,
      () => {
        const stt = settings.get().stt
        return { vadThresholdDb: stt.vadThresholdDb, maxSegmentMs: stt.maxSegmentMs }
      }
    )
    const screen = new ScreenService({
      backend: new ElectronScreenBackend(),
      resolveVision: () => registry.resolveVision(),
      getRecentTranscript: () => transcript.getRecentTranscript(),
      getSessionId: () => contextService.sessionId,
      context,
      armGate: screenGate
    })

    // ── Stage 9: backup / restore / persistence status ──────────────────
    const backupDir = path.join(userData, 'backups')
    const listBackups = (): string[] => {
      try {
        return fs
          .readdirSync(backupDir)
          .filter((f) => f.startsWith('context-backup-') && f.endsWith('.db'))
          .sort()
      } catch {
        return []
      }
    }
    let lastBackupAt: string | null = null
    const backupNow = (): { ok: boolean; message?: string } => {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const dest = path.join(backupDir, `context-backup-${stamp}.db`)
        contextSqlite.backup(dest)
        lastBackupAt = new Date().toISOString()
        // Bound retained backups to the 5 most recent.
        const backups = listBackups()
        for (const old of backups.slice(0, Math.max(0, backups.length - 5))) {
          try {
            fs.unlinkSync(path.join(backupDir, old))
          } catch {
            /* best-effort pruning */
          }
        }
        return { ok: true, message: `Backup saved (${backups.length + 1} retained).` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Backup failed' }
      }
    }
    const restoreLatest = (): { ok: boolean; message?: string } => {
      const backups = listBackups()
      if (backups.length === 0) return { ok: false, message: 'No backup available to restore.' }
      const latest = backups[backups.length - 1]
      try {
        contextSqlite.close()
        // Keep the current database under a .pre-restore name — never
        // overwrite the only copy.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        fs.copyFileSync(path.join(userData, 'context.db'), path.join(userData, `context.db.pre-restore-${stamp}`))
        fs.copyFileSync(path.join(backupDir, latest), path.join(userData, 'context.db'))
        contextSqlite = new SQLiteStore(path.join(userData, 'context.db'))
        contextService.replaceStore(contextSqlite)
        return { ok: true, message: `Restored from ${latest}.` }
      } catch (err) {
        // Reopen whatever is on disk so the app keeps a working store.
        try {
          contextSqlite = new SQLiteStore(path.join(userData, 'context.db'))
          contextService.replaceStore(contextSqlite)
        } catch {
          /* report the original failure */
        }
        return { ok: false, message: err instanceof Error ? err.message : 'Restore failed' }
      }
    }

    const listMeetings = (): import('../shared/protocol').MeetingSummary[] =>
      contextSqlite.listMeetings().map((m) => ({
        meetingId: m.meetingId,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        preview: m.notes.slice(0, 200),
        source: m.source ?? undefined,
        language: m.language ?? undefined,
        providerLabel: m.providerLabel ?? undefined,
        startedAt: m.startedAt ?? undefined,
        endedAt: m.endedAt ?? undefined,
        durationMs: m.durationMs ?? undefined,
        actionItemCount: m.actionItems.length
      }))
    const saveMeeting = (raw: unknown): { ok: boolean; message?: string } => {
      const parsed = MeetingSaveRequestSchema.safeParse(raw)
      if (!parsed.success) return { ok: false, message: 'Invalid meeting record' }
      const now = new Date().toISOString()
      try {
        const existing = contextSqlite.getMeeting(parsed.data.meetingId)
        contextSqlite.upsertMeeting({
          meetingId: parsed.data.meetingId,
          title: parsed.data.title,
          transcript: parsed.data.transcript,
          notes: parsed.data.notes,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          source: parsed.data.source ?? existing?.source ?? null,
          language: parsed.data.language ?? existing?.language ?? null,
          providerLabel: parsed.data.providerLabel ?? existing?.providerLabel ?? null,
          startedAt: parsed.data.startedAt ?? existing?.startedAt ?? null,
          endedAt: parsed.data.endedAt ?? existing?.endedAt ?? null,
          durationMs: parsed.data.durationMs ?? existing?.durationMs ?? null,
          actionItems: parsed.data.actionItems ?? existing?.actionItems ?? []
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Could not save meeting' }
      }
    }
    const deleteMeeting = (meetingId: string): { ok: boolean } => ({ ok: contextSqlite.deleteMeeting(meetingId) })

    const meetingDetail = (meetingId: string): import('../shared/protocol').MeetingDetail | undefined => {
      const m = contextSqlite.getMeeting(meetingId)
      if (!m) return undefined
      return {
        meetingId: m.meetingId,
        title: m.title,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        preview: m.notes.slice(0, 200),
        transcript: m.transcript,
        notes: m.notes,
        actionItems: m.actionItems,
        source: m.source ?? undefined,
        language: m.language ?? undefined,
        providerLabel: m.providerLabel ?? undefined,
        startedAt: m.startedAt ?? undefined,
        endedAt: m.endedAt ?? undefined,
        durationMs: m.durationMs ?? undefined,
        actionItemCount: m.actionItems.length
      }
    }

    registerIpcHandlers({
      settings,
      creds,
      registry,
      sttRegistry,
      chat,
      transcript,
      screen,
      context: contextService,
      modes,
      practice,
      permissionGate,
      getWindow: getMainWindow,
      listMeetings,
      saveMeeting,
      deleteMeeting,
      getMeeting: meetingDetail,
      searchMeetings: (query: string) =>
        contextSqlite.searchMeetings(query).map((m) => ({
          meetingId: m.meetingId,
          title: m.title,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
          preview: m.notes.slice(0, 200),
          source: m.source ?? undefined,
          language: m.language ?? undefined,
          providerLabel: m.providerLabel ?? undefined,
          startedAt: m.startedAt ?? undefined,
          endedAt: m.endedAt ?? undefined,
          durationMs: m.durationMs ?? undefined,
          actionItemCount: m.actionItems.length
        })),
      persistence: {
        status: () => ({
          kind: 'sqlite' as const,
          schemaVersion: 1,
          counts: contextSqlite.counts(),
          migration:
            migrationResult.status === 'no-legacy'
              ? null
              : {
                  status: migrationResult.status,
                  imported: migrationResult.imported,
                  skipped: migrationResult.skipped,
                  message: migrationResult.message
                },
          lastBackupAt,
          backupsAvailable: listBackups().length
        }),
        backupNow,
        restoreLatest
      }
    })

    // OS permission gates: the renderer can only obtain mic/display-capture
    // access when the user pressed Start and the gate was armed (Module J).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'media') callback(permissionGate.consume('media'))
      else if (permission === 'display-capture') callback(permissionGate.consume('display-capture'))
      else callback(false)
    })
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      if (!permissionGate.consume('display-capture')) {
        callback(null as unknown as Parameters<typeof callback>[0])
        return
      }
      void import('electron').then(async ({ desktopCapturer }) => {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (sources.length === 0) {
          callback(null as unknown as Parameters<typeof callback>[0])
          return
        }
        // audio: 'loopback' captures system output on Windows (WASAPI loopback).
        callback({ video: sources[0], audio: 'loopback' } as Parameters<typeof callback>[0])
      })
    })

    createMainWindow()

    // Registry-driven global shortcuts (single source: shared/shortcuts.ts).
    for (const { id, accelerator } of electronAccelerators()) {
      globalShortcut.register(accelerator, () => {
        const win = getMainWindow()
        switch (id) {
          case 'toggle-window':
            toggleWindowVisible()
            break
          case 'read-screen':
            win?.webContents.send('app:trigger', { action: 'read-screen' })
            if (win && !win.isVisible()) win.show()
            break
          case 'end-session':
            win?.webContents.send('app:trigger', { action: 'end-session' })
            break
        }
      })
    }

    app.on('activate', () => {
      if (!getMainWindow()) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Keep the app resident so the global shortcut can resummon the window.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}

/** Electron's safeStorage adapts to the store's narrow interface. */
function getSafeStorage(): SafeStorageLike {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { safeStorage } = require('electron') as { safeStorage: SafeStorageLike }
  return safeStorage
}

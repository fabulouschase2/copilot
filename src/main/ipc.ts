/**
 * IPC registration. Every inbound payload is validated against the shared
 * zod schemas; invoke handlers return typed results; secrets never travel
 * renderer-ward (Module J).
 */
import { ipcMain, BrowserWindow } from 'electron'
import { togglePinned } from './window'
import { PermissionGate } from './services/audio/permission-gate'
import { TranscriptService } from './services/transcription-service'
import { ScreenService } from './services/screen/screen-service'
import { ContextService } from './services/context/context-service'
import { ModesService } from './services/modes/modes-service'
import {
  AppSettingsSchema,
  ChatSendRequestSchema,
  ContextExclusionSchema,
  ContextPreviewRequestSchema,
  CredentialRemoveRequestSchema,
  CredentialResult,
  CredentialSetRequestSchema,
  IPC,
  InterviewAnswerRequestSchema,
  MeetingGetRequestSchema,
  MeetingIdRequestSchema,
  JobDescriptionRequestSchema,
  InterviewRefineRequestSchema,
  MeetingAskRequestSchema,
  MeetingGenerateRequestSchema,
  NotesExportRequestSchema,
  ProfileFactOpSchema,
  ProviderInfo,
  ProviderTestResult,
  ScreenArmRequestSchema,
  ScreenCaptureRequestSchema,
  ScreenSourcesRequestSchema,
  TranscriptAudioChunkSchema,
  TranscriptBeginRequestSchema,
  TranscriptMuteRequestSchema,
  TranscriptPrepareRequestSchema,
  TranscriptSessionRequestSchema
} from '../shared/protocol'
import { ChatController } from './services/chat-controller'
import { CredentialStore } from './services/credential-store'
import { ProviderRegistry } from './services/provider-registry'
import { SettingsStore } from './services/settings-store'
import { SttRegistry } from './services/stt/stt-registry'

export interface IpcDeps {
  settings: SettingsStore
  creds: CredentialStore
  registry: ProviderRegistry
  sttRegistry: SttRegistry
  chat: ChatController
  transcript: TranscriptService
  screen: ScreenService
  context: ContextService
  modes: ModesService
  permissionGate: PermissionGate
  getWindow: () => BrowserWindow | null
  persistence: {
    status: () => import('../shared/protocol').ContextPersistenceStatus
    backupNow: () => { ok: boolean; message?: string }
    restoreLatest: () => { ok: boolean; message?: string }
  }
  listMeetings: () => import('../shared/protocol').MeetingSummary[]
  saveMeeting: (raw: unknown) => { ok: boolean; message?: string }
  deleteMeeting: (meetingId: string) => { ok: boolean }
  getMeeting: (meetingId: string) => { ok: boolean; title: string; transcript: string; notes: string } | undefined
}

function send(window: BrowserWindow | null, channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

export function registerIpcHandlers(deps: IpcDeps): void {
  const { settings, creds, registry, sttRegistry, chat, transcript, screen, context, modes, permissionGate, getWindow } = deps

  ipcMain.handle(IPC.settingsGet, () => settings.get())

  ipcMain.handle(IPC.settingsSet, (_e, raw: unknown) => {
    const parsed = AppSettingsSchema.parse(raw)
    return settings.set(parsed)
  })

  ipcMain.handle(IPC.providersList, (): ProviderInfo[] => registry.list())

  ipcMain.handle(IPC.providersTest, async (_e, raw: unknown): Promise<ProviderTestResult> => {
    const parsed = CredentialSetRequestSchema.pick({ providerId: true }).safeParse(
      typeof raw === 'object' && raw !== null ? raw : {}
    )
    if (!parsed.success) return { ok: false, message: 'Invalid request', latencyMs: null }
    const provider = registry.resolveForTest(parsed.data.providerId)
    if (!provider) return { ok: false, message: 'Unknown provider id', latencyMs: null }
    return provider.testConnection()
  })

  ipcMain.handle(IPC.credentialsSet, (_e, raw: unknown): CredentialResult => {
    const parsed = CredentialSetRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid credential request' }
    try {
      creds.set(parsed.data.providerId, parsed.data.secret)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : 'Failed to store credential' }
    }
  })

  ipcMain.handle(IPC.credentialsRemove, (_e, raw: unknown): CredentialResult => {
    const parsed = CredentialRemoveRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid request' }
    creds.remove(parsed.data.providerId)
    return { ok: true }
  })

  ipcMain.on(IPC.chatSend, (_e, raw: unknown) => {
    const parsed = ChatSendRequestSchema.safeParse(raw)
    if (!parsed.success) {
      const requestId =
        typeof (raw as { requestId?: unknown })?.requestId === 'string'
          ? (raw as { requestId: string }).requestId.slice(0, 64)
          : 'unknown'
      send(getWindow(), IPC.chatError, { requestId, message: 'Invalid chat request' })
      return
    }
    chat.start(parsed.data)
  })

  ipcMain.on(IPC.chatCancel, (_e, requestId: unknown) => {
    if (typeof requestId === 'string') chat.cancel(requestId)
  })

  ipcMain.handle(IPC.windowTogglePin, () => togglePinned())

  /* ── Transcription (Stage 5) ─────────────────────────────────────────── */

  ipcMain.handle(IPC.transcriptPrepare, (_e, raw: unknown) => {
    const parsed = TranscriptPrepareRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid prepare request' }
    const result = transcript.prepare(parsed.data.source)
    if (!result.ok) return { ok: false, message: result.message }
    // Arm the matching OS permission exactly once, right before capture starts.
    permissionGate.arm(parsed.data.source === 'mic' ? 'media' : 'display-capture')
    // Stage 7: a new session hard-resets session-scoped context.
    context.beginSession(result.sessionId)
    // Stage 8: a new session also resets the interview question feed.
    modes.beginSession(result.sessionId)
    const resolved = sttRegistry.resolveActive()
    return {
      ok: true,
      sessionId: result.sessionId,
      sttProviderLabel: resolved?.label,
      sttProviderKind: resolved?.kind
    }
  })

  ipcMain.on(IPC.transcriptBegin, (_e, raw: unknown) => {
    const parsed = TranscriptBeginRequestSchema.safeParse(raw)
    if (parsed.success) transcript.begin(parsed.data.sessionId)
  })

  ipcMain.on(IPC.transcriptAudio, (_e, raw: unknown) => {
    const parsed = TranscriptAudioChunkSchema.safeParse(raw)
    if (!parsed.success) {
      // Oversized or malformed audio is dropped at the boundary; never crashed on.
      return
    }
    const { sessionId, seq, b64 } = parsed.data
    transcript.ingestChunk(sessionId, seq, b64)
  })

  ipcMain.on(IPC.transcriptPause, (_e, raw: unknown) => {
    const parsed = TranscriptSessionRequestSchema.safeParse(raw)
    if (parsed.success) transcript.pause(parsed.data.sessionId)
  })

  ipcMain.on(IPC.transcriptResume, (_e, raw: unknown) => {
    const parsed = TranscriptSessionRequestSchema.safeParse(raw)
    if (parsed.success) transcript.resume(parsed.data.sessionId)
  })

  ipcMain.on(IPC.transcriptMute, (_e, raw: unknown) => {
    const parsed = TranscriptMuteRequestSchema.safeParse(raw)
    if (parsed.success) transcript.mute(parsed.data.sessionId, parsed.data.muted)
  })

  ipcMain.on(IPC.transcriptStop, (_e, raw: unknown) => {
    const parsed = TranscriptSessionRequestSchema.safeParse(raw)
    if (parsed.success) {
      transcript.stop(parsed.data.sessionId)
      context.endSession()
      modes.endSession()
    }
  })

  /* ── Unified context (Stage 7) ──────────────────────────────────────── */

  ipcMain.handle(IPC.contextList, () => context.listSources())

  ipcMain.handle(IPC.contextImport, () => context.importDocuments())

  ipcMain.handle(IPC.contextProfileOp, (_e, raw: unknown) => {
    const parsed = ProfileFactOpSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid profile operation' }
    return context.applyProfileOp(parsed.data)
  })

  ipcMain.handle(IPC.contextExclusion, (_e, raw: unknown) => {
    const parsed = ContextExclusionSchema.safeParse(raw)
    if (!parsed.success) return { ok: false }
    context.setExclusion(parsed.data.sourceId, parsed.data.type, parsed.data.excluded)
    return { ok: true }
  })

  ipcMain.handle(IPC.contextPreview, (_e, raw: unknown) => {
    const parsed = ContextPreviewRequestSchema.safeParse(raw)
    if (!parsed.success) return { items: [], estimatedTokens: 0 }
    return context.preview(parsed.data)
  })

  ipcMain.on(IPC.contextClearSession, () => context.clearSessionContext())

  ipcMain.handle(IPC.contextPersistenceStatus, () => deps.persistence.status())
  ipcMain.handle(IPC.contextBackup, () => deps.persistence.backupNow())
  ipcMain.handle(IPC.contextRestore, () => deps.persistence.restoreLatest())

  ipcMain.handle(IPC.meetingsList, () => deps.listMeetings())
  ipcMain.handle(IPC.meetingsSave, (_e, raw: unknown) => deps.saveMeeting(raw))
  ipcMain.handle(IPC.meetingsDelete, (_e, raw: unknown) => {
    const parsed = MeetingIdRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false }
    return deps.deleteMeeting(parsed.data.meetingId)
  })

  ipcMain.handle(IPC.meetingsGet, (_e, raw: unknown) => {
    const parsed = MeetingGetRequestSchema.safeParse(raw)
    if (!parsed.success) return undefined
    return deps.getMeeting(parsed.data.meetingId)
  })

  ipcMain.handle(IPC.contextSetJobDescription, (_e, raw: unknown) => {
    const parsed = JobDescriptionRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid job description' }
    context.setJobDescription(parsed.data.text)
    return { ok: true }
  })

  ipcMain.handle(IPC.contextRemoveDocument, (_e, sourceId: unknown) => {
    if (typeof sourceId === 'string' && sourceId.length <= 64) {
      context.removeDocument(sourceId)
      return { ok: true }
    }
    return { ok: false }
  })

  /* ── Interview & Meeting modes (Stage 8) ────────────────────────────── */

  ipcMain.handle(IPC.interviewAnswer, (_e, raw: unknown) => {
    const parsed = InterviewAnswerRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid interview request' }
    return modes.interviewAnswer(parsed.data)
  })

  ipcMain.handle(IPC.interviewRefine, (_e, raw: unknown) => {
    const parsed = InterviewRefineRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid refine request' }
    return modes.interviewRefine(parsed.data)
  })

  ipcMain.handle(IPC.meetingGenerate, (_e, raw: unknown) => {
    const parsed = MeetingGenerateRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid meeting request' }
    return modes.meetingGenerate(parsed.data)
  })

  ipcMain.handle(IPC.meetingAsk, (_e, raw: unknown) => {
    const parsed = MeetingAskRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid meeting question' }
    return modes.meetingAsk(parsed.data)
  })

  ipcMain.on(IPC.interviewCancel, () => modes.cancel('interview'))
  ipcMain.on(IPC.meetingCancel, () => modes.cancel('meeting'))

  ipcMain.handle(IPC.notesExport, async (_e, raw: unknown) => {
    const parsed = NotesExportRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid export request' }
    return modes.exportNotes(parsed.data.content, parsed.data.format)
  })

  /* ── Screen understanding (Stage 6) ──────────────────────────────────── */

  ipcMain.handle(IPC.screenArm, (_e, raw: unknown) => {
    const parsed = ScreenArmRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid request' }
    screen.arm(parsed.data.enabled)
    return { ok: true }
  })

  ipcMain.handle(IPC.screenSources, async (_e, raw: unknown) => {
    const parsed = ScreenSourcesRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid request' }
    return screen.listSources(parsed.data.kind)
  })

  ipcMain.handle(IPC.screenCapture, (_e, raw: unknown) => {
    const parsed = ScreenCaptureRequestSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: 'Invalid screen analysis request' }
    return screen.analyze(parsed.data)
  })

  ipcMain.on(IPC.screenCancel, (_e, requestId: unknown) => {
    if (typeof requestId === 'string') screen.cancel(requestId)
  })

  ipcMain.on(IPC.screenClear, () => screen.clear())

  // Controller events are forwarded to whatever window is current at event
  // time; controller holds this object from construction.
  chat.bindEvents({
    onChunk: (requestId, delta) => send(getWindow(), IPC.chatChunk, { requestId, delta }),
    onDone: (requestId) => send(getWindow(), IPC.chatDone, { requestId }),
    onError: (requestId, message) => send(getWindow(), IPC.chatError, { requestId, message }),
    onContext: (requestId, items, estimatedTokens) =>
      send(getWindow(), IPC.chatContext, { requestId, items, estimatedTokens })
  })

  transcript.bindEvents({
    onStatus: (e) => send(getWindow(), IPC.transcriptStatus, e),
    onPartial: (e) => send(getWindow(), IPC.transcriptPartial, e),
    onSegment: (e) => {
      send(getWindow(), IPC.transcriptSegment, e)
      // Stage 8: feed finalized segments into interview question detection.
      modes.observeTranscriptSegment(e.sessionId, e.text)
    },
    onError: (e) => send(getWindow(), IPC.transcriptError, e),
    onMetrics: (e) => send(getWindow(), IPC.transcriptMetrics, e)
  })

  screen.bindEvents({
    onPreview: (e) => send(getWindow(), IPC.screenPreview, e),
    onDelta: (e) => send(getWindow(), IPC.screenDelta, e),
    onResult: (e) => send(getWindow(), IPC.screenResult, e),
    onError: (e) => send(getWindow(), IPC.screenError, e),
    onStatus: (e) => send(getWindow(), IPC.screenStatus, e),
    onMetrics: (e) => send(getWindow(), IPC.screenMetrics, e)
  })

  modes.bindEvents({
    onDelta: (channel, requestId, delta) => send(getWindow(), IPC.modeDelta, { channel, requestId, delta }),
    onResult: (e) => send(getWindow(), IPC.modeResult, e),
    onError: (channel, requestId, message) => send(getWindow(), IPC.modeError, { channel, requestId, message }),
    onQuestion: (q) => send(getWindow(), IPC.modeQuestion, q)
  })
}

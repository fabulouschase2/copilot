/**
 * Preload: the only bridge between the sandboxed renderer and the main
 * process. Exposes a typed, minimal API; no Node primitives leak through.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { z } from 'zod'
import {
  AppSettings,
  ChatChunkEvent,
  ChatSendRequest,
  ChatContextUsedEventSchema,
  ContextExclusionSchema,
  ContextPreviewRequestSchema,
  CopilotApi,
  CredentialResult,
  IPC,
  InterviewAnswerRequestSchema,
  JobDescriptionRequestSchema,
  MeetingAskRequestSchema,
  MeetingGenerateRequestSchema,
  ModeQuestion,
  NotesExportRequestSchema,
  ProfileFactOp,
  ProfileFactOpSchema,
  ProviderInfo,
  ProviderTestResult,
  ScreenAnalysisResult,
  ScreenArmRequestSchema,
  ScreenCaptureRequestSchema,
  ScreenDeltaEvent,
  ScreenErrorEvent,
  ScreenKind,
  ScreenMetricsEvent,
  ScreenPreviewEvent,
  InterviewRefineRequestSchema,
  MeetingSaveRequestSchema,
  ScreenSourcesRequestSchema,
  ScreenStatusEvent,
  TranscriptErrorEvent,
  TranscriptMetricsEvent,
  TranscriptPartialEvent,
  TranscriptPrepareRequestSchema,
  TranscriptSegmentEvent,
  TranscriptSource,
  TranscriptStatusEvent
} from '../shared/protocol'

const api: CopilotApi = {
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (settings: AppSettings): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSet, settings),
  listProviders: (): Promise<ProviderInfo[]> => ipcRenderer.invoke(IPC.providersList),
  testProvider: (providerId: string): Promise<ProviderTestResult> =>
    ipcRenderer.invoke(IPC.providersTest, { providerId }),
  setCredential: (providerId: string, secret: string): Promise<CredentialResult> =>
    ipcRenderer.invoke(IPC.credentialsSet, { providerId, secret }),
  removeCredential: (providerId: string): Promise<CredentialResult> =>
    ipcRenderer.invoke(IPC.credentialsRemove, { providerId }),
  sendChat: (req: ChatSendRequest): void => ipcRenderer.send(IPC.chatSend, req),
  cancelChat: (requestId: string): void => ipcRenderer.send(IPC.chatCancel, requestId),
  togglePin: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowTogglePin),
  prepareTranscript: (source: TranscriptSource) =>
    ipcRenderer.invoke(IPC.transcriptPrepare, TranscriptPrepareRequestSchema.parse({ source })),
  beginTranscript: (sessionId: string): void => ipcRenderer.send(IPC.transcriptBegin, { sessionId }),
  sendAudioChunk: (sessionId: string, seq: number, b64: string): void =>
    ipcRenderer.send(IPC.transcriptAudio, { sessionId, seq, b64 }),
  pauseTranscript: (sessionId: string): void => ipcRenderer.send(IPC.transcriptPause, { sessionId }),
  resumeTranscript: (sessionId: string): void => ipcRenderer.send(IPC.transcriptResume, { sessionId }),
  muteTranscript: (sessionId: string, muted: boolean): void =>
    ipcRenderer.send(IPC.transcriptMute, { sessionId, muted }),
  stopTranscript: (sessionId: string): void => ipcRenderer.send(IPC.transcriptStop, { sessionId }),
  onTranscriptStatus: (cb: (e: TranscriptStatusEvent) => void) =>
    on(IPC.transcriptStatus, cb),
  onTranscriptPartial: (cb: (e: TranscriptPartialEvent) => void) => on(IPC.transcriptPartial, cb),
  onTranscriptSegment: (cb: (e: TranscriptSegmentEvent) => void) => on(IPC.transcriptSegment, cb),
  onTranscriptError: (cb: (e: TranscriptErrorEvent) => void) => on(IPC.transcriptError, cb),
  onTranscriptMetrics: (cb: (e: TranscriptMetricsEvent) => void) => on(IPC.transcriptMetrics, cb),
  armScreen: (enabled: boolean) => ipcRenderer.invoke(IPC.screenArm, ScreenArmRequestSchema.parse({ enabled })),
  listScreenSources: (kind: ScreenKind) =>
    ipcRenderer.invoke(IPC.screenSources, ScreenSourcesRequestSchema.parse({ kind })),
  analyzeScreen: (req: z.infer<typeof ScreenCaptureRequestSchema>) =>
    ipcRenderer.invoke(IPC.screenCapture, ScreenCaptureRequestSchema.parse(req)),
  cancelScreen: (requestId: string): void => ipcRenderer.send(IPC.screenCancel, { requestId }),
  clearScreen: (): void => ipcRenderer.send(IPC.screenClear, {}),
  onScreenPreview: (cb: (e: ScreenPreviewEvent) => void) => on(IPC.screenPreview, cb),
  onScreenDelta: (cb: (e: ScreenDeltaEvent) => void) => on(IPC.screenDelta, cb),
  onScreenResult: (cb: (e: ScreenAnalysisResult) => void) => on(IPC.screenResult, cb),
  onScreenError: (cb: (e: ScreenErrorEvent) => void) => on(IPC.screenError, cb),
  onScreenStatus: (cb: (e: ScreenStatusEvent) => void) => on(IPC.screenStatus, cb),
  onScreenMetrics: (cb: (e: ScreenMetricsEvent) => void) => on(IPC.screenMetrics, cb),
  listContextSources: () => ipcRenderer.invoke(IPC.contextList),
  importDocuments: () => ipcRenderer.invoke(IPC.contextImport),
  applyProfileOp: (op: ProfileFactOp) =>
    ipcRenderer.invoke(IPC.contextProfileOp, ProfileFactOpSchema.parse(op)),
  setContextExclusion: (req: { sourceId?: string; type?: string; excluded: boolean }) =>
    ipcRenderer.invoke(IPC.contextExclusion, ContextExclusionSchema.parse(req)),
  removeDocument: (sourceId: string) => ipcRenderer.invoke(IPC.contextRemoveDocument, sourceId),
  setJobDescription: (text: string) =>
    ipcRenderer.invoke(IPC.contextSetJobDescription, JobDescriptionRequestSchema.parse({ text })),
  previewContext: (req: { question: string; options?: object }) =>
    ipcRenderer.invoke(IPC.contextPreview, ContextPreviewRequestSchema.parse(req)),
  clearSessionContext: (): void => ipcRenderer.send(IPC.contextClearSession, {}),
  persistenceStatus: () => ipcRenderer.invoke(IPC.contextPersistenceStatus),
  listMeetings: () => ipcRenderer.invoke(IPC.meetingsList),
  saveMeeting: (req: { meetingId: string; title: string; transcript: string; notes: string }) =>
    ipcRenderer.invoke(IPC.meetingsSave, MeetingSaveRequestSchema.parse(req)),
  deleteMeeting: (meetingId: string) => ipcRenderer.invoke(IPC.meetingsDelete, { meetingId }),
  getMeeting: (meetingId: string) => ipcRenderer.invoke(IPC.meetingsGet, { meetingId }),
  backupNow: () => ipcRenderer.invoke(IPC.contextBackup),
  restoreBackup: () => ipcRenderer.invoke(IPC.contextRestore),
  onChatContext: (cb: (e: z.infer<typeof ChatContextUsedEventSchema>) => void) => on(IPC.chatContext, cb),
  answerInterview: (req: { question: string; style: string; includeSession: boolean }) =>
    ipcRenderer.invoke(IPC.interviewAnswer, InterviewAnswerRequestSchema.parse(req)),
  refineInterview: (req: { kind: 'shorter' | 'rephrase'; question: string; previousAnswer: string }) =>
    ipcRenderer.invoke(IPC.interviewRefine, InterviewRefineRequestSchema.parse(req)),
  onAppTrigger: (cb: (e: { action: 'read-screen' | 'end-session' | 'clear' }) => void) => on(IPC.appTrigger, cb),
  cancelInterview: (): void => ipcRenderer.send(IPC.interviewCancel, {}),
  generateMeeting: (req: { kind: 'summary' | 'actions'; includeDocuments: boolean; includeProfile: boolean }) =>
    ipcRenderer.invoke(IPC.meetingGenerate, MeetingGenerateRequestSchema.parse(req)),
  askMeeting: (req: { question: string }) =>
    ipcRenderer.invoke(IPC.meetingAsk, MeetingAskRequestSchema.parse(req)),
  cancelMeeting: (): void => ipcRenderer.send(IPC.meetingCancel, {}),
  exportNotes: (req: { content: string; format: 'markdown' | 'txt' }) =>
    ipcRenderer.invoke(IPC.notesExport, NotesExportRequestSchema.parse(req)),
  onModeDelta: (cb: (e: { channel: string; requestId: string; delta: string }) => void) => on(IPC.modeDelta, cb),
  onModeResult: (cb: (e: import('../shared/protocol').ModeResultEvent) => void) => on(IPC.modeResult, cb),
  onModeError: (cb: (e: { channel: string; requestId: string; message: string }) => void) => on(IPC.modeError, cb),
  onModeQuestion: (cb: (e: ModeQuestion) => void) => on(IPC.modeQuestion, cb),

  onChatChunk: (cb: (e: ChatChunkEvent) => void) => {
    const listener = (_e: unknown, payload: ChatChunkEvent): void => cb(payload)
    ipcRenderer.on(IPC.chatChunk, listener)
    return () => ipcRenderer.removeListener(IPC.chatChunk, listener)
  },
  onChatDone: (cb: (e: { requestId: string }) => void) => {
    const listener = (_e: unknown, payload: { requestId: string }): void => cb(payload)
    ipcRenderer.on(IPC.chatDone, listener)
    return () => ipcRenderer.removeListener(IPC.chatDone, listener)
  },
  onChatError: (cb: (e: { requestId: string; message: string }) => void) => {
    const listener = (_e: unknown, payload: { requestId: string; message: string }): void =>
      cb(payload)
    ipcRenderer.on(IPC.chatError, listener)
    return () => ipcRenderer.removeListener(IPC.chatError, listener)
  }
}

contextBridge.exposeInMainWorld('copilot', api)

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

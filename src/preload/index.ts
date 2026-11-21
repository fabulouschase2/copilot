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
  DocumentIdRequestSchema,
  OverlayContentSchema,
  OverlaySetRequestSchema,
  ProviderRoutesRequestSchema,
  ScreenTranslateRequestSchema,
  ConversationSearchRequestSchema,
  ConversationCreateRequestSchema,
  ConversationIdRequestSchema,
  ConversationAppendRequestSchema,
  ConversationRenameRequestSchema,
  ConversationArchiveRequestSchema,
  ConversationPinRequestSchema,
  StoryDraftRequestSchema,
  StoryIdRequestSchema,
  StoryUpsertRequestSchema,
  WhisperConfigureRequestSchema,
  PracticeIdRequestSchema,
  PracticeStartRequestSchema,
  PracticeSubmitRequestSchema,
  ProfileCreateRequestSchema,
  ProfileIdRequestSchema,
  ProfileFactOp,
  ProfileFactOpSchema,
  ProfileRenameRequestSchema,
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
  SessionPurpose,
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
  listRoutes: (kind?: 'chat' | 'vision', sensitivity?: 'normal' | 'private') =>
    ipcRenderer.invoke(
      IPC.providersRoutes,
      ProviderRoutesRequestSchema.parse({ kind, sensitivity })
    ),
  testProvider: (providerId: string): Promise<ProviderTestResult> =>
    ipcRenderer.invoke(IPC.providersTest, { providerId }),
  setCredential: (providerId: string, secret: string): Promise<CredentialResult> =>
    ipcRenderer.invoke(IPC.credentialsSet, { providerId, secret }),
  removeCredential: (providerId: string): Promise<CredentialResult> =>
    ipcRenderer.invoke(IPC.credentialsRemove, { providerId }),
  sendChat: (req: ChatSendRequest): void => ipcRenderer.send(IPC.chatSend, req),
  cancelChat: (requestId: string): void => ipcRenderer.send(IPC.chatCancel, requestId),
  togglePin: (): Promise<boolean> => ipcRenderer.invoke(IPC.windowTogglePin),
  prepareTranscript: (source: TranscriptSource, purpose: SessionPurpose = 'interview') =>
    ipcRenderer.invoke(IPC.transcriptPrepare, TranscriptPrepareRequestSchema.parse({ source, purpose })),
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

  /* screen region translation (0.4.0) */
  translateScreen: (req: z.infer<typeof ScreenTranslateRequestSchema>) =>
    ipcRenderer.invoke(IPC.screenTranslate, ScreenTranslateRequestSchema.parse(req)),
  screenTranslationHistory: () => ipcRenderer.invoke(IPC.screenTranslateHistory),
  clearScreenTranslations: () => ipcRenderer.send(IPC.screenTranslateClear, {}),
  listContextSources: () => ipcRenderer.invoke(IPC.contextList),
  importDocuments: () => ipcRenderer.invoke(IPC.contextImport),
  applyProfileOp: (op: ProfileFactOp) =>
    ipcRenderer.invoke(IPC.contextProfileOp, ProfileFactOpSchema.parse(op)),
  listFactDetails: () => ipcRenderer.invoke(IPC.contextFactsDetail),
  extractFacts: (documentId: string) =>
    ipcRenderer.invoke(IPC.contextExtractFacts, DocumentIdRequestSchema.parse({ documentId })),
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

  /* audio diagnostics (transformation) */
  getAudioDiagnostics: () => ipcRenderer.invoke(IPC.audioDiagnostics),

  /* transcription provider key management */
  listSttProviders: () => ipcRenderer.invoke(IPC.sttProvidersList),
  testSttProvider: (providerId: string) =>
    ipcRenderer.invoke(IPC.sttTest, { providerId: String(providerId).slice(0, 64) }),

  /* profiles (transformation) */
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  createProfile: (req: z.infer<typeof ProfileCreateRequestSchema>) =>
    ipcRenderer.invoke(IPC.profilesCreate, ProfileCreateRequestSchema.parse(req)),
  renameProfile: (req: z.infer<typeof ProfileRenameRequestSchema>) =>
    ipcRenderer.invoke(IPC.profilesRename, ProfileRenameRequestSchema.parse(req)),
  deleteProfile: (req: z.infer<typeof ProfileIdRequestSchema>) =>
    ipcRenderer.invoke(IPC.profilesDelete, ProfileIdRequestSchema.parse(req)),

  /* meetings search (transformation) */
  searchMeetings: (query: string) => ipcRenderer.invoke(IPC.meetingsSearch, { query: String(query).slice(0, 200) }),

  /* practice (transformation) */
  practiceStart: (req: z.infer<typeof PracticeStartRequestSchema>) =>
    ipcRenderer.invoke(IPC.practiceStart, PracticeStartRequestSchema.parse(req)),
  practiceSubmit: (req: z.infer<typeof PracticeSubmitRequestSchema>) =>
    ipcRenderer.invoke(IPC.practiceSubmit, PracticeSubmitRequestSchema.parse(req)),
  practiceEnd: (req: z.infer<typeof PracticeIdRequestSchema>) =>
    ipcRenderer.invoke(IPC.practiceEnd, PracticeIdRequestSchema.parse(req)),
  practiceCancel: (req: z.infer<typeof PracticeIdRequestSchema>) =>
    ipcRenderer.invoke(IPC.practiceCancel, PracticeIdRequestSchema.parse(req)),
  listPractice: () => ipcRenderer.invoke(IPC.practiceList),
  getPractice: (practiceId: string) => ipcRenderer.invoke(IPC.practiceGet, PracticeIdRequestSchema.parse({ practiceId })),
  deletePractice: (practiceId: string) =>
    ipcRenderer.invoke(IPC.practiceDelete, PracticeIdRequestSchema.parse({ practiceId })),
  onPracticeQuestion: (cb: (e: import('../shared/protocol').PracticeQuestionEvent) => void) => on(IPC.practiceQuestion, cb),
  onPracticeEvaluated: (cb: (e: import('../shared/protocol').PracticeEvaluatedEvent) => void) => on(IPC.practiceEvaluated, cb),
  onPracticeFinished: (cb: (e: import('../shared/protocol').PracticeFinishedEvent) => void) => on(IPC.practiceFinished, cb),
  onPracticeDelta: (cb: (e: { practiceId: string; requestId: string; kind: 'question' | 'eval' | 'scorecard'; delta: string }) => void) =>
    on(IPC.practiceDelta, cb),
  onPracticeError: (cb: (e: { practiceId: string; requestId: string; message: string }) => void) => on(IPC.practiceError, cb),

  /* private desktop overlay (Phase 6) */
  getOverlayState: () => ipcRenderer.invoke(IPC.overlayGetState),
  setOverlay: (req: z.infer<typeof OverlaySetRequestSchema>) =>
    ipcRenderer.invoke(IPC.overlaySet, OverlaySetRequestSchema.parse(req)),
  hideOverlay: () => ipcRenderer.send(IPC.overlayHide, {}),
  pushOverlayContent: (content: z.infer<typeof OverlayContentSchema>) =>
    ipcRenderer.send(IPC.overlayPush, OverlayContentSchema.parse(content)),
  onOverlayState: (cb: (e: import('../shared/protocol').OverlayStateInfo) => void) =>
    on(IPC.overlayState, cb),
  onOverlayContent: (cb: (e: z.infer<typeof OverlayContentSchema>) => void) =>
    on(IPC.overlayContent, cb),

  /* managed local whisper.cpp (Phase 1) */
  detectWhisper: () => ipcRenderer.invoke(IPC.whisperDetect),
  whisperStatus: () => ipcRenderer.invoke(IPC.whisperStatus),
  startWhisper: () => ipcRenderer.invoke(IPC.whisperStart),
  stopWhisper: () => ipcRenderer.invoke(IPC.whisperStop),
  configureWhisper: (req: z.infer<typeof WhisperConfigureRequestSchema>) =>
    ipcRenderer.invoke(IPC.whisperConfigure, WhisperConfigureRequestSchema.parse(req)),

  /* live translation (Phase 4) */
  testTranslation: (text: string) =>
    ipcRenderer.invoke(IPC.translationTest, String(text).slice(0, 5_000)),
  onTranslationResult: (cb: (e: import('../shared/protocol').TranslationResultEvent) => void) =>
    on(IPC.translationResult, cb),
  onTranslationError: (cb: (e: import('../shared/protocol').TranslationErrorEvent) => void) =>
    on(IPC.translationError, cb),

  /* career story bank (Phase 2) */
  listStories: () => ipcRenderer.invoke(IPC.storiesList),
  upsertStory: (req: z.infer<typeof StoryUpsertRequestSchema>) =>
    ipcRenderer.invoke(IPC.storiesUpsert, StoryUpsertRequestSchema.parse(req)),
  deleteStory: (storyId: string) =>
    ipcRenderer.invoke(IPC.storiesDelete, StoryIdRequestSchema.parse({ storyId })),
  draftStory: (req: z.infer<typeof StoryDraftRequestSchema>) =>
    ipcRenderer.invoke(IPC.storiesDraft, StoryDraftRequestSchema.parse(req)),

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
  },

  /* persistent conversations (0.5.0) */
  listConversations: (req?: { query?: string; includeArchived?: boolean }) =>
    ipcRenderer.invoke(IPC.conversationsList, ConversationSearchRequestSchema.parse(req ?? {})),
  createConversation: (req?: { title?: string }) =>
    ipcRenderer.invoke(IPC.conversationsCreate, ConversationCreateRequestSchema.parse(req ?? {})),
  getConversation: (conversationId: string) =>
    ipcRenderer.invoke(IPC.conversationsGet, ConversationIdRequestSchema.parse({ conversationId })),
  appendConversationMessage: (req: z.infer<typeof ConversationAppendRequestSchema>) =>
    ipcRenderer.invoke(IPC.conversationsAppend, ConversationAppendRequestSchema.parse(req)),
  renameConversation: (req: z.infer<typeof ConversationRenameRequestSchema>) =>
    ipcRenderer.invoke(IPC.conversationsRename, ConversationRenameRequestSchema.parse(req)),
  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke(IPC.conversationsDelete, ConversationIdRequestSchema.parse({ conversationId })),
  archiveConversation: (req: z.infer<typeof ConversationArchiveRequestSchema>) =>
    ipcRenderer.invoke(IPC.conversationsArchive, ConversationArchiveRequestSchema.parse(req)),
  pinConversation: (req: z.infer<typeof ConversationPinRequestSchema>) =>
    ipcRenderer.invoke(IPC.conversationsPin, ConversationPinRequestSchema.parse(req))
}

contextBridge.exposeInMainWorld('copilot', api)

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

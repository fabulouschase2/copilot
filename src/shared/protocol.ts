/**
 * Shared IPC contract between renderer and main process.
 *
 * This module is the single source of truth for channel names and payload
 * schemas. The main process validates every inbound payload with these zod
 * schemas (module J: input validation); the renderer never imports main code
 * and never sees provider credentials.
 */
import { z } from 'zod'

export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  providersList: 'providers:list',
  providersTest: 'providers:test',
  credentialsSet: 'credentials:set',
  credentialsRemove: 'credentials:remove',
  chatSend: 'chat:send',
  chatCancel: 'chat:cancel',
  windowTogglePin: 'window:toggle-pin',
  chatChunk: 'chat:chunk',
  chatDone: 'chat:done',
  chatError: 'chat:error',
  appStatus: 'app:status',
  transcriptPrepare: 'transcript:prepare',
  transcriptBegin: 'transcript:begin',
  transcriptAudio: 'transcript:audio',
  transcriptPause: 'transcript:pause',
  transcriptResume: 'transcript:resume',
  transcriptMute: 'transcript:mute',
  transcriptStop: 'transcript:stop',
  transcriptStatus: 'transcript:status',
  transcriptPartial: 'transcript:partial',
  transcriptSegment: 'transcript:segment',
  transcriptError: 'transcript:error',
  transcriptMetrics: 'transcript:metrics',
  screenArm: 'screen:arm',
  screenSources: 'screen:sources',
  screenCapture: 'screen:capture',
  screenCancel: 'screen:cancel',
  screenClear: 'screen:clear',
  screenPreview: 'screen:preview',
  screenDelta: 'screen:delta',
  screenResult: 'screen:result',
  screenError: 'screen:error',
  screenStatus: 'screen:status',
  screenMetrics: 'screen:metrics',
  contextList: 'context:list',
  contextImport: 'context:import',
  contextProfileOp: 'context:profile-op',
  contextExclusion: 'context:exclusion',
  contextPreview: 'context:preview',
  contextClearSession: 'context:clear-session',
  contextRemoveDocument: 'context:remove-document',
  chatContext: 'chat:context',
  contextPersistenceStatus: 'context:persistence-status',
  contextBackup: 'context:backup',
  contextRestore: 'context:restore',
  interviewRefine: 'interview:refine',
  meetingsList: 'meetings:list',
  meetingsSave: 'meetings:save',
  meetingsDelete: 'meetings:delete',
  meetingsGet: 'meetings:get',
  meetingsSearch: 'meetings:search',
  contextSetJobDescription: 'context:set-job-description',
  appTrigger: 'app:trigger',
  interviewAnswer: 'interview:answer',
  interviewCancel: 'interview:cancel',
  meetingGenerate: 'meeting:generate',
  meetingAsk: 'meeting:ask',
  meetingCancel: 'meeting:cancel',
  notesExport: 'notes:export',
  modeDelta: 'mode:delta',
  modeResult: 'mode:result',
  modeError: 'mode:error',
  modeQuestion: 'mode:question',
  /* Transformation: session purpose, profiles, practice */
  profilesList: 'profiles:list',
  profilesCreate: 'profiles:create',
  profilesRename: 'profiles:rename',
  profilesDelete: 'profiles:delete',
  practiceStart: 'practice:start',
  practiceSubmit: 'practice:submit',
  practiceEnd: 'practice:end',
  practiceCancel: 'practice:cancel',
  practiceList: 'practice:list',
  practiceGet: 'practice:get',
  practiceDelete: 'practice:delete',
  practiceDelta: 'practice:delta',
  practiceQuestion: 'practice:question',
  practiceEvaluated: 'practice:evaluated',
  practiceFinished: 'practice:finished',
  practiceError: 'practice:error'
} as const

export const ChatRoleSchema = z.enum(['system', 'user', 'assistant'])
export const ChatMessageSchema = z.object({
  role: ChatRoleSchema,
  content: z.string().min(1).max(200_000)
})

export const ChatSendRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  mode: z.enum(['concise', 'detailed']).default('concise'),
  messages: z.array(ChatMessageSchema).min(1).max(100)
})
export type ChatSendRequest = z.infer<typeof ChatSendRequestSchema>

export const ChatChunkEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  delta: z.string().max(20_000)
})
export type ChatChunkEvent = z.infer<typeof ChatChunkEventSchema>

export const ChatDoneEventSchema = z.object({
  requestId: z.string().min(1).max(64)
})

export const ChatErrorEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  /** Human-readable, secret-free message. Never include stack traces or keys. */
  message: z.string().min(1).max(500)
})

export const ProvidersTestRequestSchema = z.object({
  providerId: z.string().min(1).max(64)
})

export const CredentialSetRequestSchema = z.object({
  providerId: z.string().min(1).max(64),
  secret: z.string().min(1).max(4096)
})

export const CredentialRemoveRequestSchema = z.object({
  providerId: z.string().min(1).max(64)
})

/* ─── Stage 5: streaming transcription ─────────────────────────────────── */

export const TranscriptSourceSchema = z.enum(['mic', 'system'])
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>

/**
 * What a transcription session is FOR. The purpose tags every published
 * segment so meeting data can never contain interview questions and practice
 * sessions stay fully separate from both.
 */
export const SessionPurposeSchema = z.enum(['interview', 'meeting', 'practice'])
export type SessionPurpose = z.infer<typeof SessionPurposeSchema>

export const TranscriptPrepareRequestSchema = z.object({
  source: TranscriptSourceSchema,
  purpose: SessionPurposeSchema.default('interview')
})
export const TranscriptPrepareResultSchema = z.object({
  ok: z.boolean(),
  sessionId: z.string().max(64).optional(),
  /** Human-readable name of the STT provider audio will be sent to. */
  sttProviderLabel: z.string().max(64).optional(),
  /** 'cloud' or 'local' — drives the consent copy. */
  sttProviderKind: z.enum(['cloud', 'local']).optional(),
  message: z.string().max(500).optional()
})

export const TranscriptBeginRequestSchema = z.object({
  sessionId: z.string().min(1).max(64)
})

export const TranscriptAudioChunkSchema = z.object({
  sessionId: z.string().min(1).max(64),
  /** Monotonic per-session chunk counter assigned by the renderer. */
  seq: z.number().int().min(0).max(2_147_483_647),
  /** Base64 PCM16 mono 16 kHz audio (~100 ms ≈ 4.3 kB). */
  b64: z
    .string()
    .min(4)
    .max(87_384) // 64 KiB decoded PCM + base64 expansion
    .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v), 'b64 must be base64')
})

export const TranscriptSessionRequestSchema = z.object({
  sessionId: z.string().min(1).max(64)
})

export const TranscriptMuteRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  muted: z.boolean()
})

export type TranscriptSessionState = 'armed' | 'listening' | 'paused' | 'stopped'

export interface TranscriptStatusEvent {
  sessionId: string
  state: TranscriptSessionState
  source: TranscriptSource | null
  purpose: SessionPurpose
  muted: boolean
  speechActive: boolean
  sttProviderLabel: string
  sttProviderKind: 'cloud' | 'local' | 'none'
}

export interface TranscriptPartialEvent {
  sessionId: string
  segmentId: string
  text: string
}

export interface TranscriptSegmentEvent {
  sessionId: string
  segmentId: string
  seq: number
  source: TranscriptSource
  purpose: SessionPurpose
  /** Milliseconds relative to the session's audio timeline. */
  startMs: number
  endMs: number
  wallTime: string
  text: string
}

export interface TranscriptErrorEvent {
  sessionId: string
  code: 'permission' | 'device' | 'stt' | 'invalid' | 'internal'
  message: string
}

export interface TranscriptMetrics {
  chunksIn: number
  chunksDropped: number
  audioMs: number
  vadCpuMs: number
  segmentsFinalized: number
  partialsSent: number
  sttRequests: number
  sttErrors: number
  lastSttRttMs: number | null
  avgSttRttMs: number | null
  rssStartBytes: number | null
  rssNowBytes: number | null
}

export interface TranscriptMetricsEvent {
  sessionId: string
  metrics: TranscriptMetrics
}

/* ─── Stage 6: screen understanding ────────────────────────────────────── */

export const ScreenKindSchema = z.enum(['screen', 'window'])
export type ScreenKind = z.infer<typeof ScreenKindSchema>

/** Arms (or revokes) screen analysis consent. Captures require an unexpired arm. */
export const ScreenArmRequestSchema = z.object({
  enabled: z.boolean()
})

export const ScreenSourcesRequestSchema = z.object({
  kind: ScreenKindSchema
})

export interface ScreenSourceInfo {
  id: string
  name: string
  /** Small JPEG data URL for the picker preview. */
  thumbnailDataUrl: string
}

export const ScreenRegionSchema = z.object({
  /** Normalized 0..1 coordinates relative to the captured image. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1)
})
export type ScreenRegion = z.infer<typeof ScreenRegionSchema>

export type ScreenCaptureRequest = z.infer<typeof ScreenCaptureRequestSchema>

export const ScreenCaptureRequestSchema = z.object({
  kind: ScreenKindSchema,
  sourceId: z.string().min(1).max(256).optional(),
  region: ScreenRegionSchema.optional(),
  question: z.string().min(1).max(4_000),
  /** Attach recent transcript segments from the CURRENT session only. */
  includeTranscript: z.boolean().default(false),
  /** Persist the analysis observations into the shared context engine. */
  includeContext: z.boolean().default(true),
  /** Omit to use the first enabled vision-capable chat provider. */
  providerId: z.string().min(1).max(64).optional()
})

export interface ScreenAnalysisProcessing {
  captureMs: number | null
  preprocessMs: number | null
  ttftMs: number | null
  totalMs: number
  /** Dimensions of the image actually sent to the provider. */
  sentWidth: number | null
  sentHeight: number | null
  /** Similarity to the previous capture, 0..1 (1 = identical hash). */
  similarityToPrevious: number | null
  duplicate: boolean
}

export type ScreenAnalysisStatus = 'completed' | 'duplicate' | 'cancelled' | 'error'

export interface ScreenAnalysisResult {
  requestId: string
  status: ScreenAnalysisStatus
  question: string
  /** Model output (observations), empty for duplicate/cancelled/error. */
  observations: string
  provider: { id: string; label: string; model: string } | null
  processing: ScreenAnalysisProcessing
  /** Transcript segments (current session only) included in the prompt. */
  transcriptRefs: Array<{ segmentId: string; seq: number; text: string }>
  /** Error message when status === 'error'. */
  message?: string
}

export interface ScreenPreviewEvent {
  requestId: string
  /** Medium-size JPEG data URL of the captured (post-crop) image. */
  dataUrl: string
  width: number
  height: number
  similarityToPrevious: number | null
  duplicate: boolean
}

export interface ScreenDeltaEvent {
  requestId: string
  delta: string
}

export interface ScreenErrorEvent {
  requestId: string
  code: 'permission' | 'no-source' | 'no-vision-provider' | 'image-too-large' | 'provider' | 'invalid' | 'internal'
  message: string
}

export interface ScreenStatusEvent {
  requestId: string
  phase: 'capturing' | 'preprocessing' | 'analyzing'
}

export interface ScreenMetricsEvent {
  requestId: string
  captureMs: number | null
  preprocessMs: number
  ttftMs: number | null
  totalMs: number
  peakImageBytes: number
  duplicateDetectionMs: number
}

/* ─── Stage 7: unified context engine ──────────────────────────────────── */

export const ContextSourceTypeSchema = z.enum(['document', 'profile', 'transcript', 'screen'])
export type ContextSourceType = z.infer<typeof ContextSourceTypeSchema>

export const ProfileCategorySchema = z.enum(['background', 'skill', 'preference', 'project', 'other'])
export type ProfileCategory = z.infer<typeof ProfileCategorySchema>

/**
 * Model-visible context records deliberately carry NO credentials, NO raw
 * images, and NO filesystem paths — documents are referenced by sourceId and
 * surfaced to the user by displayName only.
 */
export interface ContextSourceInfo {
  sourceId: string
  type: ContextSourceType
  displayName: string
  createdAt: string
  updatedAt: string
  /** Present for session-scoped sources. */
  sessionId?: string
  extractionStatus: 'ready' | 'failed' | 'partial'
  /** Character count of extracted text (never the text itself). */
  extractedChars: number
  /** Preview of the extracted text (bounded). */
  preview: string
  excluded: boolean
  error?: string
  /** Profile rows only: who authored the fact. Never set automatically. */
  origin?: 'user' | 'model'
  category?: ProfileCategory
}

export interface RetrievedItem {
  itemId: string
  sourceId: string
  type: ContextSourceType
  displayName: string
  text: string
  /** 0..1 normalized relevance score. */
  score: number
  /** Deterministic human-readable explanation of why this was included. */
  reason: string
  sessionId?: string
}

export const ContextImportResultSchema = z.object({
  sourceId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(256),
  status: z.enum(['ready', 'failed', 'partial']),
  extractedChars: z.number().int().min(0),
  message: z.string().max(500).optional()
})

export const ProfileFactOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    text: z.string().min(1).max(2_000),
    category: ProfileCategorySchema
  }),
  z.object({
    op: z.literal('update'),
    factId: z.string().min(1).max(64),
    text: z.string().min(1).max(2_000).optional(),
    category: ProfileCategorySchema.optional()
  }),
  z.object({
    op: z.literal('remove'),
    factId: z.string().min(1).max(64)
  })
])
export type ProfileFactOp = z.infer<typeof ProfileFactOpSchema>

export const ContextExclusionSchema = z
  .object({
    /** Exclude one source, or a whole category when sourceId is omitted. */
    sourceId: z.string().min(1).max(64).optional(),
    type: ContextSourceTypeSchema.optional(),
    excluded: z.boolean()
  })
  .refine((v) => v.sourceId !== undefined || v.type !== undefined, 'An exclusion must target a source or a type')

export const ContextOptionsSchema = z.object({
  includeDocuments: z.boolean().default(true),
  includeProfile: z.boolean().default(true),
  /** Current-session transcript/screen only; never other sessions. */
  includeSession: z.boolean().default(true)
})
export type ContextOptions = z.infer<typeof ContextOptionsSchema>

export const ContextPreviewRequestSchema = z.object({
  question: z.string().min(1).max(4_000),
  options: ContextOptionsSchema.default({
    includeDocuments: true,
    includeProfile: true,
    includeSession: true
  })
})

export const ContextSettingsSchema = z.object({
  /** Total retrieved-context token budget per request. */
  totalTokenBudget: z.number().int().min(200).max(8_000).default(1_200),
  /** Per-source character cap before ranking. */
  perSourceCharBudget: z.number().int().min(200).max(20_000).default(1_200),
  /** Below this normalized score an item is irrelevant. */
  minScore: z.number().min(0).max(1).default(0.05)
})
export type ContextSettings = z.infer<typeof ContextSettingsSchema>

export const ChatContextUsedEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  items: z
    .array(
      z.object({
        sourceId: z.string().max(64),
        displayName: z.string().max(256),
        type: ContextSourceTypeSchema,
        score: z.number()
      })
    )
    .max(50),
  estimatedTokens: z.number().int().min(0)
})

/* ─── Stage 8: interview & meeting modes ───────────────────────────────── */

export const AnswerStyleSchema = z.enum(['concise', 'detailed', 'technical', 'star', 'coding', 'research'])
export type AnswerStyle = z.infer<typeof AnswerStyleSchema>

export const InterviewAnswerRequestSchema = z.object({
  question: z.string().min(1).max(2_000),
  style: AnswerStyleSchema,
  /** Length/detail is a separate control from the answer style. */
  detail: z.enum(['concise', 'detailed']).default('concise'),
  /** Current-session transcript/screen context (never other sessions). */
  includeSession: z.boolean().default(false)
})

export const InterviewRefineRequestSchema = z.object({
  kind: z.enum(['shorter', 'rephrase']),
  question: z.string().min(1).max(2_000),
  previousAnswer: z.string().min(1).max(20_000)
})

/** Interview session preferences (Setup), persisted with app settings. */
export const InterviewSettingsSchema = z.object({
  /** Wait-before-answering after a question is detected (seconds). */
  delaySeconds: z.number().int().min(1).max(9).default(3),
  /** Auto-generate when the delay elapses after a detected question. */
  autoAnswer: z.boolean().default(true),
  company: z.string().max(200).default(''),
  role: z.string().max(200).default(''),
  source: z.enum(['mic', 'system']).default('mic')
})
export type InterviewSettings = z.infer<typeof InterviewSettingsSchema>

export const MeetingGenerateRequestSchema = z.object({
  kind: z.enum(['summary', 'actions']),
  /** Saved sources require explicit opt-in; session context is the default. */
  includeDocuments: z.boolean().default(false),
  includeProfile: z.boolean().default(false)
})

export const MeetingAskRequestSchema = z.object({
  question: z.string().min(1).max(2_000),
  /**
   * When set, the question is answered from the SAVED meeting's transcript
   * instead of the live session. Saved transcripts are never mixed with
   * live session context.
   */
  meetingId: z.string().min(1).max(64).optional()
})

/** Structured action item extracted from a meeting (evidence-only fields). */
export interface MeetingActionItem {
  task: string
  owner: string
  deadline: string
  suggested: boolean
}

export const MeetingSaveRequestSchema = z.object({
  meetingId: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  transcript: z.string().max(500_000).default(''),
  notes: z.string().max(500_000).default(''),
  /** Structured extraction produced at end-of-meeting (editable afterwards). */
  actionItems: z
    .array(
      z.object({
        task: z.string().max(2_000),
        owner: z.string().max(200),
        deadline: z.string().max(200),
        suggested: z.boolean().default(false)
      })
    )
    .max(100)
    .optional(),
  /** Provenance: how this meeting was recorded. */
  source: z.enum(['mic', 'system']).optional(),
  language: z.string().max(16).optional(),
  providerLabel: z.string().max(64).optional(),
  startedAt: z.string().max(40).optional(),
  endedAt: z.string().max(40).optional(),
  durationMs: z.number().int().min(0).max(2_147_483_647).optional()
})

export const MeetingIdRequestSchema = z.object({
  meetingId: z.string().min(1).max(64)
})

export const MeetingGetRequestSchema = MeetingIdRequestSchema

export interface MeetingSummary {
  meetingId: string
  title: string
  createdAt: string
  updatedAt: string
  /** Notes preview (bounded), never the full text. */
  preview: string
  /** Provenance and lifecycle metadata for the list view. */
  source?: 'mic' | 'system'
  language?: string
  providerLabel?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  actionItemCount?: number
}

export interface MeetingDetail extends MeetingSummary {
  transcript: string
  notes: string
  actionItems: MeetingActionItem[]
}

export const JobDescriptionRequestSchema = z.object({
  text: z.string().max(8_000)
})

export const NotesExportRequestSchema = z.object({
  content: z.string().min(1).max(1_000_000),
  format: z.enum(['markdown', 'txt'])
})

export type ModeChannel = 'interview' | 'meeting'

export interface ContextPersistenceStatus {
  kind: 'sqlite'
  schemaVersion: number
  counts: { documents: number; facts: number }
  migration: {
    status: string
    imported: { documents: number; facts: number; exclusions: number }
    skipped: number
    message?: string
  } | null
  lastBackupAt: string | null
  backupsAvailable: number
}

export interface ModeQuestion {
  id: string
  text: string
  confidence: 'high' | 'medium'
  kind: 'behavioral' | 'technical' | 'general'
  detectedAt: string
  sessionId: string
}

export interface ModeContextUsed {
  sourceId: string
  displayName: string
  type: ContextSourceType
  score: number
}

export interface ModeResultEvent {
  channel: ModeChannel
  requestId: string
  status: 'completed' | 'cancelled' | 'error'
  text: string
  /** Application-computed evidence assessment for interview answers. */
  evidenceLevel?: 'none' | 'partial' | 'good'
  contextUsed: ModeContextUsed[]
  message?: string
  /** Provider-reported token usage when the provider supplies it. */
  usage?: { inputTokens: number | null; outputTokens: number | null }
}

export interface ModeErrorEvent {
  channel: ModeChannel
  requestId: string
  message: string
}

/** Credentials are write-only from the renderer; they can never be read back. */
export interface CredentialResult {
  ok: boolean
  message?: string
}

export const ProviderConfigSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  kind: z.literal('openai-compatible'),
  baseUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), 'baseUrl must be http(s)'),
  model: z.string().min(1).max(128),
  enabled: z.boolean(),
  /** Whether the configured model accepts image input. */
  vision: z.boolean().default(false)
})
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/** Speech-to-text provider row (Module A). kind drives the adapter used. */
export const STTProviderSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  /** stt-segment: OpenAI-compatible /audio/transcriptions (utterance-final). */
  /** stt-stream: Deepgram-style WebSocket (interim partials + finals). */
  kind: z.enum(['stt-segment', 'stt-stream']),
  baseUrl: z
    .string()
    .min(1)
    .max(2048)
    .refine((v) => v.startsWith('http://') || v.startsWith('https://'), 'baseUrl must be http(s)'),
  model: z.string().min(1).max(128),
  language: z.string().min(2).max(16).default('en'),
  enabled: z.boolean()
})
export type STTProvider = z.infer<typeof STTProviderSchema>

export const STTSettingsSchema = z.object({
  providers: z.array(STTProviderSchema).max(10).default([]),
  activeSttProviderId: z.string().min(1).max(64).nullable().default(null),
  /** Energy VAD threshold in dBFS. */
  vadThresholdDb: z.number().min(-90).max(-10).default(-45),
  /** Force-close an open speech segment after this long to bound latency. */
  maxSegmentMs: z.number().int().min(2_000).max(60_000).default(20_000)
})
export type STTSettings = z.infer<typeof STTSettingsSchema>

export const AppSettingsSchema = z.object({
  providers: z.array(ProviderConfigSchema).max(20).default([]),
  activeProviderId: z.string().min(1).max(64).nullable().default(null),
  theme: z.enum(['dark', 'light']).default('dark'),
  responseMode: z.enum(['concise', 'detailed']).default('concise'),
  /**
   * Response language shared by transcription + AI generation. 'auto' means
   * no forced language: transcription uses the STT provider's configured
   * language and the model mirrors the question's language.
   */
  responseLanguage: z.string().min(2).max(24).default('auto'),
  /** Active personal profile: facts and retrieval are scoped to it. */
  activeProfileId: z.string().min(1).max(64).default('default'),
  context: ContextSettingsSchema.default({
    totalTokenBudget: 1_200,
    perSourceCharBudget: 1_200,
    minScore: 0.05
  }),
  interview: InterviewSettingsSchema.default({
    delaySeconds: 3,
    autoAnswer: true,
    company: '',
    role: '',
    source: 'mic'
  }),
  stt: STTSettingsSchema.default({
    providers: [],
    activeSttProviderId: null,
    vadThresholdDb: -45,
    maxSegmentMs: 20_000
  })
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const DEFAULT_SETTINGS: AppSettings = AppSettingsSchema.parse({})

/** Provider metadata safe to expose to the renderer (never contains keys). */
export interface ProviderInfo {
  id: string
  label: string
  kind: string
  enabled: boolean
  vision: boolean
  /** True when a credential for this provider exists in secure storage. */
  hasCredential: boolean
  model: string
  baseUrl: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs: number | null
}

/* ─── Transformation: personal profiles ─────────────────────────────────── */

export interface ProfileInfo {
  profileId: string
  name: string
  factCount: number
  createdAt: string
  updatedAt: string
}

export const ProfileCreateRequestSchema = z.object({
  name: z.string().min(1).max(80)
})
export const ProfileRenameRequestSchema = z.object({
  profileId: z.string().min(1).max(64),
  name: z.string().min(1).max(80)
})
export const ProfileIdRequestSchema = z.object({
  profileId: z.string().min(1).max(64)
})

/* ─── Transformation: practice interviews (Module K) ────────────────────── */

export const PracticeTypeSchema = z.enum([
  'behavioral',
  'technical',
  'software-engineering',
  'coding',
  'system-design',
  'ai-evaluation',
  'custom'
])
export type PracticeType = z.infer<typeof PracticeTypeSchema>

export const PracticeDifficultySchema = z.enum(['easy', 'medium', 'hard'])
export type PracticeDifficulty = z.infer<typeof PracticeDifficultySchema>

export const PracticeStartRequestSchema = z.object({
  type: PracticeTypeSchema,
  difficulty: PracticeDifficultySchema.default('medium'),
  /** Number of questions for the whole session (2–10). */
  questionCount: z.number().int().min(2).max(10).default(5),
  /** Optional job description grounding; never used to invent experience. */
  jobDescription: z.string().max(8_000).default(''),
  /** Custom interview focus when type === 'custom'. */
  customFocus: z.string().max(500).default(''),
  /** Optional role label for context. */
  role: z.string().max(200).default(''),
  /** Active profile id — the session retrieves facts from this profile. */
  profileId: z.string().min(1).max(64).default('default')
})

export const PracticeSubmitRequestSchema = z.object({
  practiceId: z.string().min(1).max(64),
  answer: z.string().max(100_000),
  spoken: z.boolean().default(false)
})

export const PracticeIdRequestSchema = z.object({
  practiceId: z.string().min(1).max(64)
})

/** One scored dimension of a practice answer. */
export interface PracticeDimensionScore {
  dimension: string
  score: number
  comment: string
}

/** Rubric feedback for a single practice answer (explicit + explainable). */
export interface PracticeFeedback {
  overall: number
  dimensions: PracticeDimensionScore[]
  strengths: string[]
  improvements: string[]
  /** A better version of the answer grounded ONLY in what the user said. */
  improvedAnswer: string
}

export interface PracticeTurn {
  index: number
  question: string
  answer: string
  /** Present once the answer has been evaluated. */
  feedback?: PracticeFeedback
  spoken: boolean
}

export interface PracticeScorecard {
  overall: number
  communication: number
  technicalAccuracy: number
  relevance: number
  completeness: number
  problemSolving: number
  summary: string
  areasForImprovement: string[]
}

export interface PracticeSessionInfo {
  practiceId: string
  type: PracticeType
  difficulty: PracticeDifficulty
  questionCount: number
  status: 'active' | 'completed' | 'cancelled'
  role: string
  createdAt: string
  updatedAt: string
  /** Populated when status === 'completed'. */
  scorecard?: PracticeScorecard
}

export interface PracticeDetail extends PracticeSessionInfo {
  jobDescription: string
  turns: PracticeTurn[]
}

export interface PracticeQuestionEvent {
  practiceId: string
  index: number
  question: string
}

export interface PracticeEvaluatedEvent {
  practiceId: string
  index: number
  feedback: PracticeFeedback
}

export interface PracticeFinishedEvent {
  practiceId: string
  scorecard: PracticeScorecard
}

/** Window into the main process exposed on window.copilot by the preload. */
export interface CopilotApi {
  getSettings(): Promise<AppSettings>
  setSettings(settings: AppSettings): Promise<AppSettings>
  listProviders(): Promise<ProviderInfo[]>
  testProvider(providerId: string): Promise<ProviderTestResult>
  setCredential(providerId: string, secret: string): Promise<CredentialResult>
  removeCredential(providerId: string): Promise<CredentialResult>
  sendChat(req: ChatSendRequest): void
  cancelChat(requestId: string): void
  togglePin(): Promise<boolean>
  prepareTranscript(
    source: TranscriptSource,
    purpose?: SessionPurpose
  ): Promise<z.infer<typeof TranscriptPrepareResultSchema>>
  beginTranscript(sessionId: string): void
  sendAudioChunk(sessionId: string, seq: number, b64: string): void
  pauseTranscript(sessionId: string): void
  resumeTranscript(sessionId: string): void
  muteTranscript(sessionId: string, muted: boolean): void
  stopTranscript(sessionId: string): void
  onTranscriptStatus(cb: (e: TranscriptStatusEvent) => void): () => void
  onTranscriptPartial(cb: (e: TranscriptPartialEvent) => void): () => void
  onTranscriptSegment(cb: (e: TranscriptSegmentEvent) => void): () => void
  onTranscriptError(cb: (e: TranscriptErrorEvent) => void): () => void
  onTranscriptMetrics(cb: (e: TranscriptMetricsEvent) => void): () => void
  armScreen(enabled: boolean): Promise<{ ok: boolean; message?: string }>
  listScreenSources(kind: ScreenKind): Promise<{ ok: boolean; sources?: ScreenSourceInfo[]; message?: string }>
  analyzeScreen(req: z.infer<typeof ScreenCaptureRequestSchema>): Promise<{ ok: boolean; requestId?: string; message?: string }>
  cancelScreen(requestId: string): void
  clearScreen(): void
  onScreenPreview(cb: (e: ScreenPreviewEvent) => void): () => void
  onScreenDelta(cb: (e: ScreenDeltaEvent) => void): () => void
  onScreenResult(cb: (e: ScreenAnalysisResult) => void): () => void
  onScreenError(cb: (e: ScreenErrorEvent) => void): () => void
  onScreenStatus(cb: (e: ScreenStatusEvent) => void): () => void
  onScreenMetrics(cb: (e: ScreenMetricsEvent) => void): () => void
  listContextSources(): Promise<{
    sources: ContextSourceInfo[]
    session: { id: string | null; transcriptItems: number; screenItems: number }
  }>
  importDocuments(): Promise<{ results: z.infer<typeof ContextImportResultSchema>[] }>
  applyProfileOp(op: ProfileFactOp): Promise<{ ok: boolean; message?: string }>
  setContextExclusion(req: z.infer<typeof ContextExclusionSchema>): Promise<{ ok: boolean }>
  removeDocument(sourceId: string): Promise<{ ok: boolean }>
  setJobDescription(text: string): Promise<{ ok: boolean; message?: string }>
  listMeetings(): Promise<{ meetings: MeetingSummary[] }>
  searchMeetings(query: string): Promise<{ meetings: MeetingSummary[] }>
  saveMeeting(req: z.infer<typeof MeetingSaveRequestSchema>): Promise<{ ok: boolean; message?: string }>
  deleteMeeting(meetingId: string): Promise<{ ok: boolean }>
  getMeeting(meetingId: string): Promise<MeetingDetail | undefined>
  previewContext(req: { question: string; options?: ContextOptions }): Promise<{
    items: RetrievedItem[]
    estimatedTokens: number
  }>
  clearSessionContext(): void
  onChatContext(cb: (e: z.infer<typeof ChatContextUsedEventSchema>) => void): () => void
  persistenceStatus(): Promise<ContextPersistenceStatus>
  backupNow(): Promise<{ ok: boolean; message?: string }>
  restoreBackup(): Promise<{ ok: boolean; message?: string }>
  answerInterview(req: z.infer<typeof InterviewAnswerRequestSchema>): Promise<{ ok: boolean; requestId?: string; message?: string }>
  refineInterview(req: z.infer<typeof InterviewRefineRequestSchema>): Promise<{ ok: boolean; requestId?: string; message?: string }>
  cancelInterview(): void
  onAppTrigger(cb: (e: { action: 'read-screen' | 'end-session' | 'clear' }) => void): () => void
  generateMeeting(req: z.infer<typeof MeetingGenerateRequestSchema>): Promise<{ ok: boolean; requestId?: string; message?: string }>
  askMeeting(req: z.infer<typeof MeetingAskRequestSchema>): Promise<{ ok: boolean; requestId?: string; message?: string }>
  cancelMeeting(): void
  exportNotes(req: z.infer<typeof NotesExportRequestSchema>): Promise<{ ok: boolean; canceled?: boolean; message?: string }>
  onModeDelta(cb: (e: { channel: string; requestId: string; delta: string }) => void): () => void
  onModeResult(cb: (e: ModeResultEvent) => void): () => void
  onModeError(cb: (e: { channel: string; requestId: string; message: string }) => void): () => void
  onModeQuestion(cb: (e: ModeQuestion) => void): () => void
  onChatChunk(cb: (e: ChatChunkEvent) => void): () => void
  onChatDone(cb: (e: { requestId: string }) => void): () => void
  onChatError(cb: (e: z.infer<typeof ChatErrorEventSchema>) => void): () => void
  /* profiles */
  listProfiles(): Promise<{ profiles: ProfileInfo[] }>
  createProfile(req: z.infer<typeof ProfileCreateRequestSchema>): Promise<{ ok: boolean; profileId?: string; message?: string }>
  renameProfile(req: z.infer<typeof ProfileRenameRequestSchema>): Promise<{ ok: boolean; message?: string }>
  deleteProfile(req: z.infer<typeof ProfileIdRequestSchema>): Promise<{ ok: boolean; message?: string }>
  /* practice */
  practiceStart(
    req: z.infer<typeof PracticeStartRequestSchema>
  ): Promise<{ ok: boolean; practiceId?: string; message?: string }>
  practiceSubmit(req: { practiceId: string; answer: string; spoken: boolean }): Promise<{ ok: boolean; message?: string }>
  practiceEnd(req: { practiceId: string }): Promise<{ ok: boolean; message?: string }>
  practiceCancel(req: { practiceId: string }): Promise<{ ok: boolean; message?: string }>
  listPractice(): Promise<{ sessions: PracticeSessionInfo[] }>
  getPractice(practiceId: string): Promise<PracticeDetail | undefined>
  deletePractice(practiceId: string): Promise<{ ok: boolean }>
  onPracticeQuestion(cb: (e: PracticeQuestionEvent) => void): () => void
  onPracticeEvaluated(cb: (e: PracticeEvaluatedEvent) => void): () => void
  onPracticeFinished(cb: (e: PracticeFinishedEvent) => void): () => void
  onPracticeDelta(cb: (e: { practiceId: string; requestId: string; kind: 'question' | 'eval' | 'scorecard'; delta: string }) => void): () => void
  onPracticeError(cb: (e: { practiceId: string; requestId: string; message: string }) => void): () => void
}

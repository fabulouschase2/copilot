/**
 * Credential-save logic for the provider key fields, kept separate from the
 * component so the success/failure/empty paths are unit-testable without a
 * DOM. The secret lives only in component state and travels exactly one
 * place: window.copilot.setCredential → the OS-encrypted CredentialStore.
 * It is never logged.
 */

export interface CredentialSaveResult {
  ok: boolean
  /** Feedback text for the user ('Saved' on success; never contains the key). */
  message: string
}

export async function saveCredential(
  providerId: string,
  rawSecret: string,
  setCredential: (id: string, secret: string) => Promise<{ ok: boolean; message?: string }>
): Promise<CredentialSaveResult> {
  const secret = rawSecret.trim()
  if (secret.length === 0) {
    // Empty or whitespace-only keys are rejected BEFORE any IPC call —
    // a failed-looking save must never store a bogus empty credential.
    return { ok: false, message: 'Enter a key first.' }
  }
  try {
    const res = await setCredential(providerId, secret)
    if (res.ok) return { ok: true, message: 'Saved' }
    return { ok: false, message: `Save failed: ${res.message ?? 'the credential store refused the key'}` }
  } catch (err) {
    return { ok: false, message: `Save failed: ${err instanceof Error ? err.message : 'unexpected error'}` }
  }
}

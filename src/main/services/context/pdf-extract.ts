/**
 * PDF text extraction for resumes/documents (Stage 9.5, user requirement:
 * resumes arrive as PDFs). Uses pdf-parse (pure JS, no native modules).
 * Bounded: input ≤ 10 MB (PDFs are binary), extracted text ≤ 200 K chars.
 * Malformed/encrypted/empty PDFs fail with a clear status, never garbage.
 */
import * as fs from 'node:fs'
import { MAX_EXTRACTED_CHARS } from './document-extract'

export const MAX_PDF_BYTES = 10 * 1024 * 1024

export interface PdfExtractionResult {
  status: 'ready' | 'failed' | 'partial'
  text: string
  preview: string
  pages?: number
  message?: string
}

export function isPdfFile(fileName: string, bytes: Uint8Array): boolean {
  if (!fileName.toLowerCase().endsWith('.pdf')) return false
  // magic check: %PDF-
  const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1')
  return head === '%PDF-'
}

/** Extract text from a PDF buffer. Never throws; failures return status. */
export async function extractPdf(fileName: string, bytes: Uint8Array): Promise<PdfExtractionResult> {
  if (!isPdfFile(fileName, bytes)) {
    return { status: 'failed', text: '', preview: '', message: 'Not a PDF file' }
  }
  if (bytes.length > MAX_PDF_BYTES) {
    return {
      status: 'failed',
      text: '',
      preview: '',
      message: `PDF exceeds the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB import limit`
    }
  }
  try {
    // Lazy require keeps startup light and isolates the dependency.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (
      b: Buffer,
      opts?: object
    ) => Promise<{ text?: string; numpages?: number }>
    const parsed = await pdfParse(Buffer.from(bytes), { max: 50 }) // ≤50 pages
    let text = (parsed.text ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (text.length === 0) {
      return { status: 'failed', text: '', preview: '', message: 'PDF contains no extractable text (scanned/image PDFs are not supported)' }
    }
    let status: PdfExtractionResult['status'] = 'ready'
    if (text.length > MAX_EXTRACTED_CHARS) {
      text = text.slice(0, MAX_EXTRACTED_CHARS)
      status = 'partial'
    }
    return {
      status,
      text,
      preview: text.slice(0, 400),
      pages: parsed.numpages,
      message: status === 'partial' ? 'Text truncated at the extraction limit' : undefined
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const encrypted = /password|encrypt/i.test(message)
    return {
      status: 'failed',
      text: '',
      preview: '',
      message: encrypted ? 'PDF is password-protected' : `Could not parse PDF: ${message.slice(0, 160)}`
    }
  }
}

/** Read a PDF from disk with the shared bounds applied. */
export async function extractPdfFromFile(filePath: string): Promise<PdfExtractionResult & { fileName: string }> {
  const fileName = filePath.replace(/^.*[/\\]/, '')
  const stat = await fs.promises.stat(filePath).catch(() => null)
  if (!stat || !stat.isFile()) {
    return { status: 'failed', text: '', preview: '', fileName, message: 'File not readable' }
  }
  if (stat.size > MAX_PDF_BYTES) {
    return {
      status: 'failed',
      text: '',
      preview: '',
      fileName,
      message: `PDF exceeds the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB import limit`
    }
  }
  const bytes = new Uint8Array(await fs.promises.readFile(filePath))
  const result = await extractPdf(fileName, bytes)
  return { ...result, fileName }
}

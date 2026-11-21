/**
 * DOCX text extraction — dependency-free (Phase 2 completion).
 *
 * A .docx is a ZIP containing `word/document.xml`. Rather than adding a
 * document-processing dependency (and its memory cost), this module reads the
 * ZIP central directory, inflates just `word/document.xml`, and converts the
 * WordprocessingML body to plain text:
 *
 *   <w:p>  → paragraph break        <w:tab/> → tab
 *   <w:br/> → line break            <w:tc>   → tab-separated cells
 *
 * Everything is bounded and failure-safe: encrypted, malformed, or oversized
 * archives return a status instead of garbage text. Content is untrusted data,
 * exactly like every other imported document.
 */
import { inflateRawSync } from 'node:zlib'
import { MAX_EXTRACTED_CHARS } from './document-extract'

export const MAX_DOCX_BYTES = 10 * 1024 * 1024

export interface DocxExtractionResult {
  status: 'ready' | 'failed' | 'partial'
  text: string
  preview: string
  message?: string
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export function isDocxFile(fileName: string, bytes: Uint8Array): boolean {
  if (!fileName.toLowerCase().endsWith('.docx')) return false
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 && // P
    bytes[1] === 0x4b && // K
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

/** Read the ZIP central directory. Returns [] when the archive is unusable. */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD is at the end, possibly followed by a comment (≤ 65535 bytes).
  const minPos = Math.max(0, view.length - 66_000)
  let eocd = -1
  for (let i = view.length - 22; i >= minPos; i -= 1) {
    if (view.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return []
  const entries = view.readUInt16LE(eocd + 10)
  const dirOffset = view.readUInt32LE(eocd + 16)
  if (dirOffset <= 0 || dirOffset >= view.length) return []

  const list: ZipEntry[] = []
  let p = dirOffset
  for (let i = 0; i < entries; i += 1) {
    if (p + 46 > view.length || view.readUInt32LE(p) !== CENTRAL_SIG) break
    const method = view.readUInt16LE(p + 10)
    const compressedSize = view.readUInt32LE(p + 20)
    const uncompressedSize = view.readUInt32LE(p + 24)
    const nameLen = view.readUInt16LE(p + 28)
    const extraLen = view.readUInt16LE(p + 30)
    const commentLen = view.readUInt16LE(p + 32)
    const localOffset = view.readUInt32LE(p + 42)
    const name = view.toString('utf8', p + 46, p + 46 + nameLen)
    list.push({ name, method, compressedSize, uncompressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return list
}

/** Inflate one entry's bytes (stored or deflate). Null when unsupported. */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Buffer | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const local = entry.localOffset
  if (local + 30 > view.length || view.readUInt32LE(local) !== LOCAL_SIG) return null
  const nameLen = view.readUInt16LE(local + 26)
  const extraLen = view.readUInt16LE(local + 28)
  const dataStart = local + 30 + nameLen + extraLen
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > view.length || entry.compressedSize < 0) return null
  const data = view.subarray(dataStart, dataEnd)
  try {
    if (entry.method === 0) return Buffer.from(data)
    if (entry.method === 8) return inflateRawSync(data)
  } catch {
    return null
  }
  return null
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return XML_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Convert `word/document.xml` into readable plain text. */
export function wordXmlToText(xml: string): string {
  let body = xml
  // Keep only the document body when present (avoid styles/settings noise).
  const bodyStart = body.indexOf('<w:body')
  if (bodyStart !== -1) body = body.slice(bodyStart)
  const text = body
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<w:cr\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeXmlEntities(text)
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** Extract text from a .docx buffer. Never throws; failures return a status. */
export function extractDocx(fileName: string, bytes: Uint8Array): DocxExtractionResult {
  if (!fileName.toLowerCase().endsWith('.docx')) {
    return { status: 'failed', text: '', preview: '', message: 'Not a .docx file' }
  }
  if (bytes.length === 0) {
    return { status: 'failed', text: '', preview: '', message: 'File is empty' }
  }
  if (bytes.length > MAX_DOCX_BYTES) {
    return {
      status: 'failed',
      text: '',
      preview: '',
      message: `File exceeds the ${Math.round(MAX_DOCX_BYTES / 1024 / 1024)} MB import limit`
    }
  }
  if (!isDocxFile(fileName, bytes)) {
    // Common causes: a .doc renamed to .docx, or a password-protected file.
    return {
      status: 'failed',
      text: '',
      preview: '',
      message: 'Not a valid .docx archive. Legacy .doc files and encrypted documents are not supported — re-save as .docx or PDF.'
    }
  }
  const directory = readZipDirectory(bytes)
  const documentXml = directory.find((e) => e.name === 'word/document.xml')
  if (!documentXml) {
    return {
      status: 'failed',
      text: '',
      preview: '',
      message: 'The .docx archive has no word/document.xml (it may be encrypted or not a Word document).'
    }
  }
  const inflated = readZipEntry(bytes, documentXml)
  if (!inflated) {
    return { status: 'failed', text: '', preview: '', message: 'Could not decompress the document body (unsupported compression).' }
  }
  let text = wordXmlToText(inflated.toString('utf8'))
  if (text.length === 0) {
    return { status: 'failed', text: '', preview: '', message: 'The document contains no extractable text.' }
  }
  let status: DocxExtractionResult['status'] = 'ready'
  if (text.length > MAX_EXTRACTED_CHARS) {
    text = text.slice(0, MAX_EXTRACTED_CHARS)
    status = 'partial'
  }
  return { status, text, preview: text.slice(0, 400) }
}

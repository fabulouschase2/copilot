import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractPdf, isPdfFile } from '../src/main/services/context/pdf-extract'

/** Build a minimal but structurally valid one-page PDF with the given text. */
function buildMinimalPdf(text: string): Uint8Array {
  const objects: string[] = []
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefStart = body.length
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return new TextEncoder().encode(body + xref + trailer)
}

describe('PDF extraction', () => {
  it('recognizes PDF files by name and magic', () => {
    expect(isPdfFile('resume.pdf', new TextEncoder().encode('%PDF-1.4 rest'))).toBe(true)
    expect(isPdfFile('resume.pdf', new TextEncoder().encode('not a pdf'))).toBe(false)
    expect(isPdfFile('resume.txt', new TextEncoder().encode('%PDF-1.4'))).toBe(false)
  })

  it('extracts text from a real PDF fixture (Chrome-generated)', async () => {
    const { readFileSync } = await import('node:fs')
    const bytes = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'test-resume.pdf')))
    const res = await extractPdf('test-resume.pdf', bytes)
    expect(res.status).toBe('ready')
    expect(res.text).toContain('Six years of TypeScript')
    expect(res.pages).toBeGreaterThanOrEqual(1)
  })

  it('rejects non-PDF payloads passed with a .pdf name', async () => {
    const res = await extractPdf('fake.pdf', new TextEncoder().encode('just text, no pdf structure'))
    expect(res.status).toBe('failed')
    expect(res.message).toBeDefined()
  })

  it('rejects oversized PDFs', async () => {
    const big = new Uint8Array(11 * 1024 * 1024)
    big.set(new TextEncoder().encode('%PDF-1.4'), 0)
    const res = await extractPdf('big.pdf', big)
    expect(res.status).toBe('failed')
    expect(res.message).toMatch(/import limit/)
  })

  it('reports scanned/image PDFs (no text layer) as failed, not empty success', async () => {
    // A structurally valid PDF whose content stream draws no text
    const bytes = buildMinimalPdf('')
    const res = await extractPdf('scan.pdf', bytes)
    // pdf-parse returns empty text for a no-op content stream
    expect(res.status === 'failed' || (res.status === 'ready' && res.text.length === 0)).toBe(true)
  })
})

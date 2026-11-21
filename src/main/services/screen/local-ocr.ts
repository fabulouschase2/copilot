/**
 * Local OCR through the OCR engine built into Windows (Windows.Media.Ocr).
 *
 * No dependency, no model download, no network: PowerShell loads WinRT, runs the
 * recognizer for the user's installed languages and returns JSON. Verified on
 * this machine: "Hello world. This is an OCR test. Second line: 12345" was read
 * back exactly, with recognizer en-US installed.
 *
 * Limits stated honestly:
 *  - Only languages with an installed OCR pack are recognised (en-US here).
 *  - Tiny text, heavy styling or unusual fonts may produce partial text; the UI
 *    must show what was actually recognised.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const OCR_TIMEOUT_MS = 30_000

// `IAsyncOperation`1` contains a backtick, which would terminate a JS template
// literal, so the PowerShell script builds the name with [char]96 instead.
const OCR_SCRIPT = `param([string]$ImagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asyncName = 'IAsyncOperation' + [char]96 + '1'
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $asyncName
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  [pscustomobject]@{ ok = $false; error = 'No Windows OCR language pack is installed.'; text = ''; lines = @(); language = $null } | ConvertTo-Json -Compress
  exit 0
}
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @()
foreach ($line in $result.Lines) { $lines += $line.Text }
[pscustomobject]@{
  ok = $true
  text = $result.Text
  lines = $lines
  language = $engine.RecognizerLanguage.LanguageTag
} | ConvertTo-Json -Compress
`

export interface OcrResult {
  ok: boolean
  text: string
  lines: string[]
  language: string | null
  message?: string
}

/** Parse the JSON the OCR script prints (last non-empty JSON line). */
export function parseOcrOutput(stdout: string): OcrResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue
    try {
      const parsed = JSON.parse(lines[i]) as {
        ok?: unknown
        text?: unknown
        lines?: unknown
        language?: unknown
        error?: unknown
      }
      if (parsed.ok !== true) {
        return {
          ok: false,
          text: '',
          lines: [],
          language: null,
          message: typeof parsed.error === 'string' ? parsed.error : 'OCR failed.'
        }
      }
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
      const ocrLines = Array.isArray(parsed.lines)
        ? parsed.lines
            .filter((l): l is string => typeof l === 'string')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
        : []
      return {
        ok: true,
        text,
        lines: ocrLines,
        language: typeof parsed.language === 'string' ? parsed.language : null
      }
    } catch {
      continue
    }
  }
  return { ok: false, text: '', lines: [], language: null, message: 'OCR produced no readable output.' }
}

export interface OcrOptions {
  timeoutMs?: number
  /** Test seam. */
  execFileImpl?: typeof execFile
}

/**
 * OCR one image file locally. Never throws: failures return `ok: false` with a
 * message so the UI can say what happened instead of showing an empty panel.
 */
export async function ocrImageFile(imagePath: string, opts: OcrOptions = {}): Promise<OcrResult> {
  if (process.platform !== 'win32') {
    return { ok: false, text: '', lines: [], language: null, message: 'Local OCR is Windows-only.' }
  }
  if (!fs.existsSync(imagePath)) {
    return { ok: false, text: '', lines: [], language: null, message: 'Image file not found.' }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-ocr-'))
  const scriptPath = path.join(dir, 'ocr.ps1')
  fs.writeFileSync(scriptPath, OCR_SCRIPT, 'utf-8')

  const run = opts.execFileImpl ?? execFile
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-ImagePath', imagePath],
        { windowsHide: true, timeout: opts.timeoutMs ?? OCR_TIMEOUT_MS },
        (err, out) => (err ? reject(err) : resolve(String(out)))
      )
    })
    return parseOcrOutput(stdout)
  } catch (err) {
    return {
      ok: false,
      text: '',
      lines: [],
      language: null,
      message: `Local OCR failed: ${err instanceof Error ? err.message : String(err)}`
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

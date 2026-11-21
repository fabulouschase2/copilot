/**
 * Supported output languages for live translation.
 *
 * Coverage note (honest): this list is what the UI offers. Whether a given
 * provider actually translates a pair well depends on the model — large cloud
 * models handle all of them, small local models (e.g. qwen2.5:1.5b) are weaker
 * outside English and the major European/Asian languages. The UI names the
 * provider that produced each line so the user can judge.
 */
export interface LanguageDef {
  code: string
  label: string
  /** Name used in prompts; native label helps the model. */
  native: string
}

export const TRANSLATION_LANGUAGES: readonly LanguageDef[] = [
  { code: 'en', label: 'English', native: 'English' },
  { code: 'es', label: 'Spanish', native: 'Español' },
  { code: 'fr', label: 'French', native: 'Français' },
  { code: 'de', label: 'German', native: 'Deutsch' },
  { code: 'pt', label: 'Portuguese', native: 'Português' },
  { code: 'it', label: 'Italian', native: 'Italiano' },
  { code: 'nl', label: 'Dutch', native: 'Nederlands' },
  { code: 'pl', label: 'Polish', native: 'Polski' },
  { code: 'cs', label: 'Czech', native: 'Čeština' },
  { code: 'sk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'hu', label: 'Hungarian', native: 'Magyar' },
  { code: 'ro', label: 'Romanian', native: 'Română' },
  { code: 'bg', label: 'Bulgarian', native: 'Български' },
  { code: 'el', label: 'Greek', native: 'Ελληνικά' },
  { code: 'sv', label: 'Swedish', native: 'Svenska' },
  { code: 'da', label: 'Danish', native: 'Dansk' },
  { code: 'nb', label: 'Norwegian', native: 'Norsk' },
  { code: 'fi', label: 'Finnish', native: 'Suomi' },
  { code: 'et', label: 'Estonian', native: 'Eesti' },
  { code: 'lv', label: 'Latvian', native: 'Latviešu' },
  { code: 'lt', label: 'Lithuanian', native: 'Lietuvių' },
  { code: 'uk', label: 'Ukrainian', native: 'Українська' },
  { code: 'ru', label: 'Russian', native: 'Русский' },
  { code: 'tr', label: 'Turkish', native: 'Türkçe' },
  { code: 'ar', label: 'Arabic', native: 'العربية' },
  { code: 'he', label: 'Hebrew', native: 'עברית' },
  { code: 'fa', label: 'Persian', native: 'فارسی' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी' },
  { code: 'bn', label: 'Bengali', native: 'বাংলা' },
  { code: 'ta', label: 'Tamil', native: 'தமிழ்' },
  { code: 'te', label: 'Telugu', native: 'తెలుగు' },
  { code: 'ur', label: 'Urdu', native: 'اردو' },
  { code: 'th', label: 'Thai', native: 'ไทย' },
  { code: 'vi', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'id', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ms', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'fil', label: 'Filipino', native: 'Filipino' },
  { code: 'zh', label: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'ja', label: 'Japanese', native: '日本語' },
  { code: 'ko', label: 'Korean', native: '한국어' },
  { code: 'sw', label: 'Swahili', native: 'Kiswahili' },
  { code: 'am', label: 'Amharic', native: 'አማርኛ' },
  { code: 'af', label: 'Afrikaans', native: 'Afrikaans' },
  { code: 'ca', label: 'Catalan', native: 'Català' },
  { code: 'sr', label: 'Serbian', native: 'Српски' },
  { code: 'hr', label: 'Croatian', native: 'Hrvatski' },
  { code: 'sl', label: 'Slovenian', native: 'Slovenščina' },
  { code: 'is', label: 'Icelandic', native: 'Íslenska' }
] as const

export function languageLabel(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.label ?? code
}

export function languageNative(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.native ?? code
}

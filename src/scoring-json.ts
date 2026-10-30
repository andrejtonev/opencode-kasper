import { parse as parseJSONC } from "jsonc-parser"

function extractBalancedJSON(text: string): string | null {
  const startIdx = text.indexOf("{")
  if (startIdx === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  return null
}

export function parseScoringJSON(text: string): Record<string, unknown> {
  if (text.length > 262144) return {}
  const trimmed = text.trim()
  if (!trimmed) return {}

  const tryParse = (s: string): Record<string, unknown> | undefined => {
    const extracted = extractBalancedJSON(s)
    if (!extracted) return undefined
    try {
      const errors: { error: number; offset: number; length: number }[] = []
      const result = parseJSONC(extracted, errors, { allowTrailingComma: true })
      if (
        errors.length === 0 &&
        result &&
        typeof result === "object" &&
        !Array.isArray(result)
      ) {
        return result as Record<string, unknown>
      }
    } catch {
      /* parse failure is non-fatal */
    }
    return undefined
  }

  const codeBlockRegex = /```(?:json)?\s*\n?/i
  const startMatch = trimmed.match(codeBlockRegex)
  if (startMatch) {
    const contentStart = (startMatch.index ?? 0) + startMatch[0].length
    const closeIdx = trimmed.indexOf("```", contentStart)
    if (closeIdx !== -1) {
      const inner = trimmed.slice(contentStart, closeIdx).trim()
      const parsed = tryParse(inner)
      if (parsed) return parsed
    }
  }

  const parsed = tryParse(trimmed)
  if (parsed) return parsed

  return {}
}

const SENSITIVE_FIELD =
  /^(?:authorization|proxy[-_]?authorization|cookies?|set[-_]?cookie|headers|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client[-_]?secret|credentials?|token)$/i

/** Diagnostic output only. Business data and conflict-checked backup bytes stay intact. */
export function redactDiagnosticText(text: string): string {
  let result = text
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /(?:API_KEY|PASSWORD|TOKEN|SECRET|CREDENTIAL)$/i.test(name) &&
      value &&
      value.length >= 8
    )
      result = result.replaceAll(value, "[redacted]")
  }
  return result
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(
      /((?:api[-_]?key|password|secret|access[-_]?token|refresh[-_]?token|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;\]}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
      "[redacted]",
    )
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'<>]+/g, "%USERPROFILE%")
    .replace(/\/(?:home|Users)\/[^/\s"'<>]+/g, "~")
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "[redacted email]",
    )
}

export function redactDiagnostic(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const visit = (item: unknown, depth: number): unknown => {
    if (typeof item === "string") return redactDiagnosticText(item)
    if (item === null || typeof item !== "object") return item
    if (depth > 20) return "[depth limit]"
    if (seen.has(item)) return "[circular]"
    seen.add(item)
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1))
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [
        key,
        SENSITIVE_FIELD.test(key) ? "[redacted]" : visit(entry, depth + 1),
      ]),
    )
  }
  return visit(value, 0)
}

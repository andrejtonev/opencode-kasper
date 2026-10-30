export interface ScoreTargetInput {
  session_id?: string
  count?: number
  since?: string
  until?: string
}
export function positiveInteger(value: unknown, max = 1000): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= max
  )
}
export function calendarDate(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date
    : undefined
}
export function validateScoreTarget(
  input: ScoreTargetInput,
): string | undefined {
  const selected = [
    input.session_id !== undefined,
    input.count !== undefined,
    input.since !== undefined,
  ].filter(Boolean).length
  if (selected > 1) return "session_id, count and since are mutually exclusive."
  if (input.session_id !== undefined && !input.session_id.trim())
    return "Session ID must not be empty."
  if (input.count !== undefined && !positiveInteger(input.count))
    return "Count must be a positive integer from 1 to 1000."
  if (input.until !== undefined && input.since === undefined)
    return "until requires since."
  if (input.since !== undefined && !calendarDate(input.since))
    return "Invalid since date. Use YYYY-MM-DD format."
  if (input.until !== undefined && !calendarDate(input.until))
    return "Invalid until date. Use YYYY-MM-DD format."
  if (input.since && input.until && input.since > input.until)
    return "since must be before or equal to until."
  return undefined
}

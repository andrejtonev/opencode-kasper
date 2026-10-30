import { MAX_TOOL_CALLS_EVAL } from "./constants.js"
import type { ScorerInput } from "./scorer.js"
import { boundedEvidence } from "./scoring-validation.js"
import type { KasperConfig } from "./types.js"

interface Field {
  tag: string
  value: string
  cap: number
  weight: number
}

/** UTF-16 characters after XML escaping, including delimiters and omission markers. */
export function scoringEvidence(input: ScorerInput, config: KasperConfig) {
  const limit = Math.max(1000, Math.min(50000, config.max_score_input_chars))
  const fields: Field[] = [
    ...(input.agentName
      ? [{ tag: "agent", value: input.agentName, cap: 256, weight: 1 }]
      : []),
    { tag: "user_request", value: input.userInstruction, cap: 5000, weight: 3 },
    {
      tag: "agent_response",
      value: input.agentResponse,
      cap: 10000,
      weight: 5,
    },
  ]
  const selectedTools = input.toolCalls.slice(
    0,
    Math.min(MAX_TOOL_CALLS_EVAL, Math.max(0, Math.floor((limit - 600) / 400))),
  )
  for (const call of selectedTools) {
    fields.push({ tag: "tool", value: call.tool, cap: 256, weight: 1 })
    if (config.detail_level !== "minimal") {
      fields.push({ tag: "args", value: call.args, cap: 4000, weight: 1 })
      fields.push({
        tag: "result",
        value: call.result,
        cap: config.detail_level === "thorough" ? 2000 : 500,
        weight: 1,
      })
    }
  }
  const selectedSubagents = (input.subagentCalls ?? []).slice(
    0,
    Math.min(
      MAX_TOOL_CALLS_EVAL,
      Math.max(0, Math.floor((limit - 600 - selectedTools.length * 400) / 300)),
    ),
  )
  for (const call of selectedSubagents) {
    fields.push({ tag: "subagent", value: call.agent, cap: 256, weight: 1 })
    if (config.detail_level !== "minimal")
      fields.push({
        tag: "subagent_input",
        value: call.input ?? "",
        cap: 4000,
        weight: 1,
      })
  }
  let truncated =
    selectedTools.length < input.toolCalls.length ||
    selectedSubagents.length < (input.subagentCalls?.length ?? 0)
  const minimalOmission =
    config.detail_level === "minimal" &&
    (selectedTools.some((call) => call.args || call.result) ||
      selectedSubagents.some((call) => call.input))
  if (minimalOmission) truncated = true
  const omissions = [
    ...(minimalOmission
      ? ["[tool and subagent arguments/results omitted for minimal detail]"]
      : []),
    ...(selectedTools.length < input.toolCalls.length
      ? [
          `[${input.toolCalls.length - selectedTools.length} tool calls omitted]`,
        ]
      : []),
    ...(selectedSubagents.length < (input.subagentCalls?.length ?? 0)
      ? [
          `[${input.subagentCalls.length - selectedSubagents.length} subagent calls omitted]`,
        ]
      : []),
  ].join("\n")
  const opening = "<session_data>\n"
  const closing = "\n</session_data>"
  const overhead =
    opening.length +
    closing.length +
    omissions.length +
    1 +
    fields.reduce((sum, field) => sum + field.tag.length * 2 + 7, 0)
  let remaining = limit - overhead
  const sizes = fields.map((field) => Math.min(64, field.cap))
  remaining -= sizes.reduce((sum, size) => sum + size, 0)
  // Weighted round-robin reserves evidence from every retained field, including tools.
  while (remaining > 0) {
    let allocated = false
    for (let index = 0; index < fields.length && remaining > 0; index++) {
      const add = Math.min(
        fields[index].weight,
        fields[index].cap - sizes[index],
        remaining,
      )
      if (add <= 0) continue
      sizes[index] += add
      remaining -= add
      allocated = true
    }
    if (!allocated) break
  }
  const contents = fields
    .map((field, index) => {
      const encoded = boundedEvidence(field.value, sizes[index])
      if (encoded.includes("[truncated;")) truncated = true
      return `<${field.tag}>${encoded}</${field.tag}>`
    })
    .join("\n")
  const text = `${opening}${contents}\n${omissions}${closing}`
  if (text.length > limit) throw new Error("Scoring evidence budget exceeded")
  return { text, truncated }
}

/** Estimate escaped evidence before deliberate per-turn splitting; does not allocate or call a model. */
export function scoringEvidenceSize(input: ScorerInput): number {
  const size = (value: string) => {
    let length = value.length
    for (const char of value)
      if (char === "&") length += 4
      else if (char === "<" || char === ">") length += 3
    return length
  }
  return (
    size(input.userInstruction) +
    size(input.agentResponse) +
    input.toolCalls.reduce(
      (sum, tool) =>
        sum + size(tool.tool) + size(tool.args) + size(tool.result) + 100,
      0,
    ) +
    (input.subagentCalls ?? []).reduce(
      (sum, call) => sum + size(call.agent) + size(call.input ?? "") + 60,
      0,
    ) +
    200
  )
}

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeStats, KasperStateStore } from "../src/state.js"
import { DEFAULT_CONFIG, type ScoreCard } from "../src/types.js"

function card(evidence_truncated: boolean): ScoreCard {
  return {
    session_id: "source",
    timestamp: Date.now(),
    overall_score: 0.2,
    categories: {
      instruction_following: 0.2,
      completeness: 0.2,
      proactiveness: 0.2,
      code_quality: 0.2,
      communication: 0.2,
    },
    strengths: ["useful tests"],
    weaknesses: ["missed security checks"],
    weakness_suggestions: [
      {
        weakness: "missed security checks",
        suggested_fix: "Always check all relevant inputs before changes.",
        target: "agents_md",
      },
    ],
    evidence_truncated,
  }
}

test("incomplete judge observations remain readable but never authorize aggregate proposals", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "kasper-generation-eligibility-"),
  )
  const resolved = path.resolve(directory)
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("kasper-generation-eligibility-")
  )
    throw new Error("Unexpected fixture cleanup path")
  try {
    const store = new KasperStateStore(
      path.join(directory, "state.json"),
      path.join(directory, "backups"),
      DEFAULT_CONFIG,
    )
    await store.init()
    store.recordSession("partial", "Partial", card(true), "agent")
    expect(store.getSession("partial")?.score_card.weaknesses).toEqual([
      "missed security checks",
    ])
    expect(store.getSession("partial")?.score_card.evidence_truncated).toBe(
      true,
    )
    expect(store.getAggregate().top_weaknesses).toEqual([])
    expect(store.getAggregate().top_strengths).toEqual([])
    expect(store.getAgentAggregate("agent")?.top_weaknesses).toEqual([])
    await store.flush()
    const reloaded = new KasperStateStore(
      path.join(directory, "state.json"),
      path.join(directory, "backups"),
      DEFAULT_CONFIG,
    )
    await reloaded.init()
    expect(reloaded.getAggregate().top_weaknesses).toEqual([])
    reloaded.recordSession("full", "Complete", card(false), "agent")
    expect(reloaded.getAggregate().top_weaknesses[0].count).toBe(1)
    reloaded.recordSession("partial", "Now complete", card(false), "agent")
    expect(reloaded.getAggregate().top_weaknesses[0].count).toBe(2)
    reloaded.recordSession("partial", "Partial again", card(true), "agent")
    expect(reloaded.getAggregate().top_weaknesses[0].count).toBe(1)
    expect(
      computeStats([
        { score: 0.2, score_card: card(true), timestamp: Date.now() },
      ]).top_weaknesses,
    ).toEqual([])
    await store.destroy()
    await reloaded.destroy()
  } finally {
    await rm(resolved, { recursive: true, force: true })
  }
})

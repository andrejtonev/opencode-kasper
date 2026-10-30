import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KasperStateStore } from "../src/state.js"
import {
  DEFAULT_CONFIG,
  type ImprovementRecord,
  type ScoreCard,
} from "../src/types.js"

const stores: KasperStateStore[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.destroy()))
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  )
})
async function scope() {
  const dir = await mkdtemp(join(tmpdir(), "kasper-state-concurrency-"))
  directories.push(dir)
  const open = async () => {
    const store = new KasperStateStore(
      join(dir, "state.json"),
      join(dir, "backups"),
    )
    stores.push(store)
    await store.init()
    return store
  }
  return { open, dir }
}
function card(score: number, timestamp = 1): ScoreCard {
  return {
    overall_score: score,
    weaknesses: [],
    strengths: [],
    timestamp,
  } as unknown as ScoreCard
}
function improvement(id: string): ImprovementRecord {
  return {
    id,
    timestamp: 1,
    target: "agents_md",
    agents_md_diff: "rule",
    reason: "rule",
    backup_path: "",
  }
}

describe("disk-authoritative state merge", () => {
  test("expiry survives flushing, restart and a stale instance", async () => {
    const { open } = await scope()
    const a = await open()
    a.recordImprovement(improvement("expired"))
    a.getImprovements()[0].expires_at = 1
    await a.flush()
    const stale = await open()
    expect(a.expireOldImprovements()).toBe(1)
    await a.flush()
    stale.addRejectedPattern("unrelated mutation")
    await stale.flush()
    expect(stale.getImprovements()).toEqual([])
    expect((await open()).getImprovements()).toEqual([])
  })

  test("explicit removals survive another writer's unrelated changes", async () => {
    const { open } = await scope()
    const a = await open()
    a.recordSession(
      "deleted",
      "session",
      card(0.4),
      "build",
      "primary",
      undefined,
      "m1",
      10,
    )
    a.addEvaluatedSession("deleted")
    a.addRejectedPattern("removed rejection")
    a.recordImprovement(improvement("removed improvement"))
    await a.flush()
    const stale = await open()
    a.removeSession("deleted")
    a.removeRejectedPattern("removed rejection")
    a.removeImprovement("removed improvement")
    await a.flush()
    // This checkpoint was computed from a now-deleted prior session.
    stale.recordSession(
      "deleted",
      "stale",
      card(0.9),
      "build",
      "primary",
      undefined,
      "m2",
      20,
    )
    stale.recordSession("independent", "new", card(0.8))
    await stale.flush()
    const disk = await open()
    expect(disk.getSession("deleted")).toBeUndefined()
    expect(disk.getEvaluatedSessions()).not.toContain("deleted")
    expect(disk.getRejectedPatterns()).toEqual([])
    expect(disk.getImprovements()).toEqual([])
    expect(disk.getSession("independent")?.score).toBe(0.8)
    expect(disk.getAggregate().total_sessions).toBe(1)
  })

  test("newer same-session checkpoints win regardless of flush order", async () => {
    const { open } = await scope()
    const a = await open()
    a.recordSession(
      "session",
      "initial",
      card(0.1),
      "build",
      "primary",
      undefined,
      "m1",
      10,
    )
    await a.flush()
    const b = await open()
    a.recordSession(
      "session",
      "older",
      card(0.3),
      "build",
      "primary",
      undefined,
      "m2",
      20,
    )
    b.recordSession(
      "session",
      "newer",
      card(0.9),
      "build",
      "primary",
      undefined,
      "m3",
      30,
    )
    await b.flush()
    await a.flush()
    expect(a.getSession("session")?.last_msg_id).toBe("m3")
    expect(a.getAggregate().avg_score).toBe(0.9)
    expect((await open()).getSession("session")?.score).toBe(0.9)
  })

  test("a durable reset fences pending work in previously loaded instances", async () => {
    const { open } = await scope()
    const a = await open()
    await a.flush()
    const b = await open()
    b.recordSession("pre-reset", "stale", card(0.7))
    b.addRejectedPattern("pre-reset")
    await a.reset()
    await b.flush()
    expect(b.getTotalSessions()).toBe(0)
    expect((await open()).getRejectedPatterns()).toEqual([])
    b.recordSession("post-reset", "fresh", card(0.5))
    await b.flush()
    expect((await open()).getSession("post-reset")?.score).toBe(0.5)
  })

  test("concurrent flushes merge independent sessions and consistent aggregates", async () => {
    const { open } = await scope()
    const a = await open()
    await a.flush()
    const b = await open()
    a.recordSession("a", "A", card(0.2))
    b.recordSession("b", "B", card(0.8))
    await Promise.all([a.flush(), b.flush(), a.flush()])
    const disk = await open()
    expect(disk.getTotalSessions()).toBe(2)
    expect(disk.getAggregate().avg_score).toBe(0.5)
  })

  test("live policy changes govern expiry and guidance budgets", async () => {
    const { open } = await scope()
    const a = await open()
    a.reloadConfig({
      ...DEFAULT_CONFIG,
      improvement_expiry_days: 0,
      max_agent_guidance_chars: 250,
    })
    a.recordImprovement(improvement("unexpired"))
    expect(a.getImprovements()[0].expires_at).toBeUndefined()
    expect(a.getImprovementBudget()).toBe(250)
    a.updateConfig({ improvement_expiry_days: 1 })
    a.recordImprovement(improvement("tomorrow"))
    expect(a.getImprovements()[1].expires_at).toBeGreaterThan(
      Date.now() + 86_000_000,
    )
  })

  test("mutations made while a flush is awaiting completion remain dirty", async () => {
    const { open } = await scope()
    const a = await open()
    await a.flush()
    // Delay completion after the first snapshot is written, simulating
    // another synchronous mutation while asynchronous flush work settles.
    const io = a as unknown as { doFlush(): Promise<void> }
    const original = io.doFlush.bind(a)
    let written!: () => void
    let release!: () => void
    const firstWritten = new Promise<void>((resolve) => {
      written = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true
    io.doFlush = async () => {
      await original()
      if (first) {
        first = false
        written()
        await gate
      }
    }
    a.recordSession("first", "first", card(0.2))
    const flushing = a.flush()
    await firstWritten
    a.recordSession("later", "later", card(0.8))
    release()
    await flushing
    await a.flush()
    const disk = await open()
    expect(disk.getTotalSessions()).toBe(2)
    expect(disk.getSession("later")?.score).toBe(0.8)
  })

  test("independent processes commit under the same filesystem lock", async () => {
    const { open, dir } = await scope()
    const a = await open()
    await a.flush()
    const module = new URL("../src/state.ts", import.meta.url).href
    const code = `
      import { KasperStateStore } from ${JSON.stringify(module)};
      import { writeFile, stat } from 'node:fs/promises';
      import { join } from 'node:path';
      const [dir, id, score] = process.argv.slice(1);
      const store = new KasperStateStore(join(dir,'state.json'), join(dir,'backups'));
      await store.init();
      await writeFile(join(dir,id+'.ready'),'ready');
      const deadline=Date.now()+5000;
      while(!await stat(join(dir,'go')).then(()=>true,()=>false)) {
        if(Date.now()>deadline) throw Error('barrier timeout');
        await new Promise(r=>setTimeout(r,10));
      }
      store.recordSession(id,id,{overall_score:Number(score),weaknesses:[],strengths:[],timestamp:1});
      await store.destroy();
    `
    const children = [
      Bun.spawn([process.execPath, "-e", code, dir, "process-a", "0.2"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
      Bun.spawn([process.execPath, "-e", code, dir, "process-b", "0.8"], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    ]
    try {
      const deadline = Date.now() + 5000
      for (const id of ["process-a", "process-b"]) {
        while (
          !(await readFile(join(dir, `${id}.ready`)).then(
            () => true,
            () => false,
          ))
        ) {
          if (Date.now() > deadline) throw new Error("child ready timeout")
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      await writeFile(join(dir, "go"), "go")
      for (const child of children) {
        const status = await child.exited
        expect(await new Response(child.stderr).text()).toBe("")
        expect(status).toBe(0)
      }
      const disk = await open()
      expect(disk.getTotalSessions()).toBe(2)
      expect(disk.getAggregate().avg_score).toBe(0.5)
    } finally {
      for (const child of children) child.kill()
      await Promise.all(children.map((child) => child.exited))
    }
  }, 10000)
})

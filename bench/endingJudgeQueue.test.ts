/** npx tsx bench/endingJudgeQueue.test.ts
 * LOCK-EndingJudgeQueue-20260930: ending judge complete goes through
 * GenerationQueue.run (no direct model.complete bypass). Occupied-queue
 * must not deadlock. Still void fire-and-forget; no queue.register.
 * Isolated: temp DB + fake model. No systemd, no live DB, no deploy.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { openMigratedDb } from "../apps/server/src/db/index.ts";
import { setHead, insertMessage } from "../apps/server/src/db/tree.ts";
import { GenerationQueue } from "../apps/server/src/model/queue.ts";
import { characterRoutes } from "../apps/server/src/routes/characters.ts";
import { conversationRoutes } from "../apps/server/src/routes/conversations.ts";
import { storyRoutes } from "../apps/server/src/routes/stories.ts";
import { fireEndingEvalJob } from "../apps/server/src/endingJudge.ts";
import type { Ctx } from "../apps/server/src/ctx.ts";
import type { GenParams, GenResult } from "../apps/server/src/model/adapter.ts";

let passed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`ok ${passed} ${name}`);
}

const okResult = (text: string): GenResult => ({
  text,
  finishReason: "stop",
  usage: null,
  ttftMs: 1,
  totalMs: 5,
});

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main() {
  const judgeSrc = fs.readFileSync("apps/server/src/endingJudge.ts", "utf8");

  await t("source: fireEndingEvalJob adapter uses queue.run; no register", () => {
    assert.ok(
      /complete:\s*\(p\)\s*=>\s*ctx\.queue\.run\(\(\) => ctx\.model\.complete\(p\), p\.signal\)/.test(judgeSrc),
      "adapter wraps complete with queue.run + signal",
    );
    const code = judgeSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    assert.equal(code.includes("queue.register"), false);
    assert.equal(code.includes("activeList"), false);
    assert.equal(/await fireEndingEvalJob/.test(judgeSrc), false);
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rpchat-ending-judge-queue-"));
  const db = openMigratedDb(tmp, path.resolve("apps/server/migrations"));

  // Shared room setup via routes (same pattern as storyEndingEvalLlm).
  const bootstrapQueue = new GenerationQueue(1);
  const bootstrapCtx = {
    db,
    model: {} as unknown as Ctx["model"],
    queue: bootstrapQueue,
    log: { error() {}, info() {}, warn() {}, debug() {} } as unknown as Ctx["log"],
    resolvedModel: () => "test-model",
    setResolvedModel: () => {},
    health: async () => ({ ok: true, checkedAt: "t", latencyMs: 0, models: ["test-model"] }),
  } as Ctx;
  const app = Fastify({ logger: false });
  await app.register(characterRoutes(bootstrapCtx));
  await app.register(storyRoutes(bootstrapCtx));
  await app.register(conversationRoutes(bootstrapCtx));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;
  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${origin}${url}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  }

  const ch = (await api("POST", "/api/characters", { name: "하연", personality: "반장", first_message: "인사" }))
    .json as { id: string };
  const st = await api("POST", "/api/stories", { name: "교실", setting: "학교" });
  const story = st.json as { id: string };
  const put = await api("PUT", `/api/stories/${story.id}`, {
    name: "교실",
    tagline: "",
    setting: "학교",
    minor_cast: [],
    endings: [
      { id: "h1", title: "재회", conditions: { min_turns: 1, narrative_hint: "이름을 다시 불렀다" } },
      { id: "h2", title: "이별", conditions: { min_turns: 1, narrative_hint: "등을 돌렸다" } },
    ],
  });
  assert.equal(put.status, 200, put.text);
  const room = await api("POST", "/api/conversations", { characterId: ch.id, storyId: story.id, mode: "story" });
  const roomId = (room.json as { id: string }).id;
  const g = db.prepare("SELECT head_message_id AS h FROM conversations WHERE id = ?").get(roomId) as { h: string };
  const u = insertMessage(db, roomId, g.h, "user", "첫 대사", "complete", {});
  const a = insertMessage(db, roomId, u.id, "assistant", "응답", "complete", {});
  setHead(db, roomId, a.id);

  await t("adapter: model.complete only runs inside queue.run callback", async () => {
    let insideRun = false;
    let runCalls = 0;
    let completeCalls = 0;
    const logs: object[] = [];
    const fakeQueue = {
      run: async <T>(fn: () => Promise<T>, _signal?: AbortSignal): Promise<T> => {
        runCalls++;
        insideRun = true;
        try {
          return await fn();
        } finally {
          insideRun = false;
        }
      },
    };
    const model = {
      complete: async (_p: GenParams): Promise<GenResult> => {
        completeCalls++;
        assert.equal(insideRun, true, "direct complete outside queue.run callback fails");
        return okResult(
          {evals: [{ending_id: h1, eligible: true, confidence: 0.8, reason: ok}]},
        );
      },
    };
    fireEndingEvalJob(
      {
        db,
        model,
        queue: fakeQueue,
        resolvedModel: () => "test-model",
        log: { info: (obj) => { logs.push(obj); } },
      },
      roomId,
    );
    await withTimeout(
      (async () => {
        while (completeCalls < 1 || logs.length < 1) await sleep(10);
      })(),
      5000,
      "adapter complete+log",
    );
    assert.equal(runCalls, 1);
    assert.equal(completeCalls, 1);
    assert.ok(logs.length >= 1);
  });

  await t("concurrency=1 occupied queue: ending job waits, then completes (no deadlock)", async () => {
    const queue = new GenerationQueue(1);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const occupyDone = queue.run(async () => {
      await held;
      return "held";
    });

    let completeCalls = 0;
    const logs: object[] = [];
    let jobFinished = false;
    const model = {
      complete: async (_p: GenParams): Promise<GenResult> => {
        completeCalls++;
        return okResult(
          {evals: [{ending_id: h1, eligible: false, confidence: 0.1, reason: no}]},
        );
      },
    };

    // Occupy is holding the only slot — ending must not call model yet.
    await sleep(30);
    assert.equal(completeCalls, 0, "model must not run while queue occupied");

    fireEndingEvalJob(
      {
        db,
        model,
        queue,
        resolvedModel: () => "test-model",
        log: {
          info: (obj) => {
            logs.push(obj);
            jobFinished = true;
          },
        },
      },
      roomId,
    );

    // Give the fire-and-forget a chance to enqueue; still blocked.
    await sleep(80);
    assert.equal(completeCalls, 0, "still blocked until hold releases");
    assert.equal(queue.activeList.length, 0, "ending eval must not queue.register");

    release();
    await withTimeout(occupyDone, 3000, "occupy release");
    await withTimeout(
      (async () => {
        while (!jobFinished || completeCalls < 1) await sleep(10);
      })(),
      5000,
      "ending job after release (deadlock?)",
    );
    assert.equal(completeCalls, 1, "exactly one complete after release");
    assert.ok(logs.length >= 1, "job finished with log");
    assert.equal(queue.activeList.length, 0, "still no register after finish");
  });

  await t("void fire-and-forget: returns sync; model throw does not reach caller", async () => {
    const queue = new GenerationQueue(1);
    let logCount = 0;
    const model = {
      complete: async (): Promise<GenResult> => {
        throw new Error("model boom");
      },
    };
    let threw = false;
    try {
      fireEndingEvalJob(
        {
          db,
          model,
          queue,
          resolvedModel: () => "test-model",
          log: {
            info: () => {
              logCount++;
            },
          },
        },
        roomId,
      );
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "fireEndingEvalJob must not throw synchronously");
    await withTimeout(
      (async () => {
        while (logCount < 1) await sleep(10);
      })(),
      5000,
      "throw path still logs (llm_called:0)",
    );
    assert.ok(logCount >= 1);
  });

  await app.close();
  console.log(`PASS=${passed}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

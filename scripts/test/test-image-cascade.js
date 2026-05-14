/**
 * test-image-cascade.js — skills/image-cascade.js のオーケストレータ層を検証
 *
 * Phase 3a (2026-05-15): cascadeImageFetch の動作 (順序・stop-on-hit・throw-skip)。
 * itandi 実 handler 自体は Playwright 依存なのでユニットテストでは mock 注入する。
 */

const assert = require("assert");
const { cascadeImageFetch } = require("../../skills/image-cascade");

let pass = 0;
let fail = 0;
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok ${label}`);
      pass++;
    })
    .catch((e) => {
      console.error(`FAIL ${label}: ${e.message}`);
      fail++;
    });
}

const reinsData = { 建物名: "テスト物件", 部屋番号: "101" };

(async () => {
  // ── 順序: 最初に hit した PF で stop ────────────────────
  await check("先頭 PF が hit → そこで stop、後続は呼ばれない", async () => {
    const calls = [];
    const handlers = {
      itandi: async (_, name, room) => {
        calls.push({ pf: "itandi", name, room });
        return { status: "hit", images: [{ index: 1, localPath: "/x/1.jpg" }] };
      },
      atbb: async () => {
        calls.push({ pf: "atbb" });
        return { status: "hit", images: [{ index: 1, localPath: "/x/atbb.jpg" }] };
      },
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", {
      platforms: ["itandi", "atbb"],
      handlers,
    });
    assert.strictEqual(r.platform, "itandi");
    assert.strictEqual(r.images.length, 1);
    assert.strictEqual(calls.length, 1, "atbb should not have been called");
    assert.strictEqual(calls[0].name, "テスト物件");
    assert.strictEqual(calls[0].room, "101");
  });

  // ── 順序: 先頭 miss → 次へ ─────────────────────────────
  await check("先頭 PF が miss (images:[]) → 次の PF に進む", async () => {
    const calls = [];
    const handlers = {
      itandi: async () => {
        calls.push("itandi");
        return { status: "no-hit", images: [] };
      },
      atbb: async () => {
        calls.push("atbb");
        return { status: "hit", images: [{ index: 1, localPath: "/x/a.jpg" }] };
      },
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", {
      platforms: ["itandi", "atbb"],
      handlers,
    });
    assert.strictEqual(r.platform, "atbb");
    assert.strictEqual(r.images.length, 1);
    assert.deepStrictEqual(calls, ["itandi", "atbb"]);
  });

  // ── 全 miss → platform: null ────────────────────────────
  await check("全 PF miss → platform:null, images:[]", async () => {
    const handlers = {
      itandi: async () => ({ status: "no-hit", images: [] }),
      atbb: async () => ({ status: "no-hit", images: [] }),
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", {
      platforms: ["itandi", "atbb"],
      handlers,
    });
    assert.strictEqual(r.platform, null);
    assert.strictEqual(r.images.length, 0);
    assert.strictEqual(r.attempts.length, 2);
  });

  // ── handler が throw → skip して次へ ─────────────────────
  await check("handler が throw → その PF は skip、次の PF を試す", async () => {
    const handlers = {
      itandi: async () => {
        throw new Error("login crashed");
      },
      atbb: async () => ({ status: "hit", images: [{ index: 1, localPath: "/x/a.jpg" }] }),
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", {
      platforms: ["itandi", "atbb"],
      handlers,
    });
    assert.strictEqual(r.platform, "atbb");
    assert.strictEqual(r.attempts[0].status, "throw");
    assert.ok(r.attempts[0].error.includes("login crashed"));
  });

  // ── 未登録 PF → no-handler attempt 記録 ──────────────────
  await check("未登録 PF (handler に存在しない) → no-handler を記録して次へ", async () => {
    const handlers = {
      atbb: async () => ({ status: "hit", images: [{ index: 1, localPath: "/x/a.jpg" }] }),
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", {
      platforms: ["essquare", "atbb"],
      handlers,
    });
    assert.strictEqual(r.platform, "atbb");
    assert.strictEqual(r.attempts[0].platform, "essquare");
    assert.strictEqual(r.attempts[0].status, "no-handler");
  });

  // ── reinsData 不正 → 建物名 空文字で handler に渡る ───────
  await check("reinsData が null/undefined → buildingName='' で handler 呼出", async () => {
    let received = null;
    const handlers = {
      itandi: async (_, name, room) => {
        received = { name, room };
        return { status: "no-building-name", images: [] };
      },
    };
    await cascadeImageFetch(null, null, "/tmp/x", { platforms: ["itandi"], handlers });
    assert.strictEqual(received.name, "");
    assert.strictEqual(received.room, "");
  });

  // ── default platforms = ["itandi"] ───────────────────────
  await check("opts.platforms 未指定 → default ['itandi']", async () => {
    let called = "";
    const handlers = {
      itandi: async () => {
        called = "itandi";
        return { status: "hit", images: [{ index: 1, localPath: "/x/a.jpg" }] };
      },
    };
    const r = await cascadeImageFetch(null, reinsData, "/tmp/x", { handlers });
    assert.strictEqual(called, "itandi");
    assert.strictEqual(r.platform, "itandi");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();

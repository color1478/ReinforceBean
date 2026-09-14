// ReinforceBean 검증용 서버 — 시뮬레이터와 같은 구조를 실제로 갖는 최소 서버 (의존성 없음, Node 22+)
//
//   요청 → [대기 큐 (QUEUE)] → [워커 스레드 세마포어 (THREADS)] → [DB 커넥션 풀 (CONNS)] → 응답
//
// DB 커넥션 풀 = worker_threads 로 띄운 SQLite 커넥션 N개. 각 워커는 자기 DatabaseSync 를 갖고
// 실제로 CPU를 태우는 쿼리(재귀 CTE)를 돌린다. 시작 시 DB_MS 만큼 걸리도록 쿼리 크기를 자동 보정한다.
//
// 실행:  node server.js            (기본: THREADS=50 CONNS=10 QUEUE=100 DB_MS=30 PORT=8080)
//        THREADS=200 CONNS=10 node server.js
//
// ── 작업 구성(work mix) ────────────────────────────────────────────────
//   MIX="상품조회:0.9:20,복잡검색:0.1:150" node server.js
//   요청마다 비율대로 작업 종류를 뽑아 그 종류의 목표 시간만큼 도는 쿼리를 실행한다.
//   MIX 를 주지 않으면 DB_MS 하나짜리 단일 작업(기존 동작).
//
//   GET /            → 요청 1건 처리 (응답 JSON에 처리한 작업 종류 type 포함)
//   GET /stats       → 현재 상태 (in-flight, 대기, 커넥션 사용, 종류별 카운트)
//   GET /calib       → 시작 시 측정한 보정값 (단독 실행 시간 / 전 커넥션 동시 실행 시간)
//   GET /reset       → 카운터 초기화

const http = require('node:http');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// MIX="이름:비율:ms,이름:비율:ms" → [{name, share, ms}]
function parseMix(s) {
  if (!s) return null;
  const out = [];
  for (const part of String(s).split(',')) {
    const [name, share, ms] = part.split(':');
    if (!name || !isFinite(+share) || !isFinite(+ms)) continue;
    out.push({ name: name.trim(), share: +share, ms: +ms });
  }
  const tot = out.reduce((a, b) => a + b.share, 0);
  if (!out.length || tot <= 0) return null;
  out.forEach(m => { m.share /= tot; });     // 합이 1이 되도록 정규화
  return out;
}

const CFG = {
  THREADS: +process.env.THREADS || 50,
  CONNS: +process.env.CONNS || 10,
  QUEUE: +process.env.QUEUE || 100,
  DB_MS: +process.env.DB_MS || 30,
  CPU_MS: +process.env.CPU_MS || 0,   // Node 메인 스레드는 하나라 병렬 CPU 구간을 재현 못함 → 기본 0 (시뮬 스윕도 cpu 0으로 맞춤)
  PORT: +process.env.PORT || 8080,
  MIX: parseMix(process.env.MIX),
};

/* ─────────── 워커 = DB 커넥션 1개 ─────────── */
if (!isMainThread) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const q = db.prepare('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c');
  parentPort.on('message', ({ id, n }) => {
    const t0 = process.hrtime.bigint();
    q.get(n);                                                     // 실제 SQLite 실행 (CPU 점유)
    parentPort.postMessage({ id, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  });
  return;
}

/* ─────────── 메인: 큐 → 스레드 → 커넥션 풀 ─────────── */
const pool = [];                 // { w, busy }
const connWaiters = [];          // 커넥션을 기다리는 콜백 (= 시뮬레이터의 waitconn)
const pending = new Map();       // id → resolve
let nextId = 1;
for (let i = 0; i < CFG.CONNS; i++) {
  const w = new Worker(__filename, { workerData: { i } });
  const slot = { w, busy: false };
  w.on('message', ({ id, ms }) => { const res = pending.get(id); pending.delete(id); slot.busy = false; grantConn(); res(ms); });
  pool.push(slot);
}
function grantConn() {
  while (connWaiters.length) { const s = pool.find(p => !p.busy); if (!s) return; s.busy = true; connWaiters.shift()(s); }
}
function acquireConn() { return new Promise(res => { connWaiters.push(res); grantConn(); }); }
function dbQuery(slot, n) { return new Promise(res => { const id = nextId++; pending.set(id, res); slot.w.postMessage({ id, n }); }); }

// 작업 종류: MIX 가 있으면 그대로, 없으면 DB_MS 하나짜리 단일 작업
const WORK = CFG.MIX || [{ name: 'default', share: 1, ms: CFG.DB_MS }];
const CALIB = { rowsPerMs: 0, perType: [], alone: 0, together: 0, concurrentRps: 0 };

// 보정: 재귀 깊이 n ↔ 실행시간(ms)이 거의 선형이므로 기준 하나만 이진탐색하고 나머지는 비례로 잡은 뒤 실측 확인
async function calibrate() {
  const slot = pool[0]; slot.busy = true;
  await dbQuery(slot, 1000);                                     // 워밍업
  let lo = 1000, hi = 5_000_000;
  for (let it = 0; it < 22; it++) {
    const mid = Math.floor((lo + hi) / 2); let sum = 0;
    for (let k = 0; k < 5; k++) sum += await dbQuery(slot, mid);
    (sum / 5 < CFG.DB_MS ? (lo = mid) : (hi = mid));
    if (hi - lo < 200) break;
  }
  CALIB.rowsPerMs = lo / CFG.DB_MS;
  // 종류별 rows 를 비례로 잡고, 실제로 그 시간이 나오는지 단독 실행으로 확인한다
  for (const w of WORK) {
    w.rows = Math.max(500, Math.round(CALIB.rowsPerMs * w.ms));
    let sum = 0; for (let k = 0; k < 8; k++) sum += await dbQuery(slot, w.rows);
    w.aloneMs = sum / 8;
    CALIB.perType.push({ name: w.name, share: +w.share.toFixed(3), targetMs: w.ms, aloneMs: +w.aloneMs.toFixed(1), rows: w.rows });
  }
  slot.busy = false;
  CALIB.alone = WORK.reduce((a, w) => a + w.share * w.aloneMs, 0);     // 실효(가중평균) 단독 시간

  // ── 여기가 핵심 측정 ──────────────────────────────────────────────
  // 전 커넥션이 동시에 돌 때의 시간. CPU/캐시/터보 경합 때문에 단독보다 반드시 느리다.
  // 용량을 결정하는 건 단독 시간이 아니라 이 값이고, 시뮬레이터에 넣어야 하는 것도 이 값이다.
  const pick = () => { let x = Math.random(); for (const w of WORK) { x -= w.share; if (x <= 0) return w; } return WORK[WORK.length - 1]; };
  const R = 8, t0 = performance.now();
  await Promise.all(pool.map(p => (async () => { for (let k = 0; k < R; k++) await dbQuery(p, pick().rows); })()));
  CALIB.together = (performance.now() - t0) / R;
  CALIB.concurrentRps = CFG.CONNS / CALIB.together * 1000;
  CALIB.alpha = CALIB.alone > 0 ? +((CALIB.together / CALIB.alone) - 1).toFixed(2) : 0;

  console.log(`[calibrate] rows/ms=${CALIB.rowsPerMs.toFixed(0)}`);
  for (const t of CALIB.perType) console.log(`[calibrate]   ${t.name.padEnd(10)} 비율 ${(t.share * 100).toFixed(0).padStart(3)}%  목표 ${String(t.targetMs).padStart(4)}ms → 단독 실측 ${t.aloneMs.toFixed(1)}ms`);
  console.log(`[calibrate] 실효 단독 ${CALIB.alone.toFixed(1)}ms  |  ${CFG.CONNS}개 동시 ${CALIB.together.toFixed(1)}ms → 실질 용량 ≈ ${CALIB.concurrentRps.toFixed(0)}rps`);
  console.log(`[calibrate] ⇒ 화면 ⑤ 실측 보정의 「서버가 측정한 α」 칸에 넣을 값:  α = ${CALIB.alpha}`);
  console.log(`[calibrate]    α = (전 커넥션 동시 실행 ÷ 단독 실행) − 1. 커넥션이 꽉 찼을 때의 감속률이고,`);
  console.log(`[calibrate]    시뮬레이터의 dbTime × (1 + α × (사용중/전체)^γ) 에서 k=c 일 때의 배율과 정확히 같은 양이다.`);
  console.log(`[calibrate]    γ(언제부터 느려지나)는 이 벤치마크로는 알 수 없다 — 부하 곡선(load.js)에서 보정해야 한다.`);
}
// 시뮬레이터처럼 지수분포 서비스 시간
const expo = (mean) => -Math.log(1 - Math.random()) * mean;

// 스레드 세마포어 + 대기 큐
let inThreads = 0; const queue = [];
const stats = { total: 0, done: 0, rejected: 0, queueMax: 0, waitConnMax: 0, byType: {} };
function acquireThread() {
  return new Promise((res, rej) => {
    if (inThreads < CFG.THREADS) { inThreads++; return res(); }
    if (queue.length >= CFG.QUEUE) return rej(new Error('queue full'));
    queue.push(res); stats.queueMax = Math.max(stats.queueMax, queue.length);
  });
}
function releaseThread() { if (queue.length) queue.shift()(); else inThreads--; }
function busyCpu(ms) { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } }
function pickWork() { let x = Math.random(); for (const w of WORK) { x -= w.share; if (x <= 0) return w; } return WORK[WORK.length - 1]; }

const server = http.createServer(async (req, res) => {
  if (req.url === '/stats') return res.end(JSON.stringify({ cfg: CFG, inThreads, queued: queue.length, waitConn: connWaiters.length, connBusy: pool.filter(p => p.busy).length, ...stats }));
  if (req.url === '/calib') return res.end(JSON.stringify(CALIB));
  if (req.url === '/reset') { Object.assign(stats, { total: 0, done: 0, rejected: 0, queueMax: 0, waitConnMax: 0, byType: {} }); return res.end('ok'); }
  stats.total++;
  const work = pickWork();
  try { await acquireThread(); } catch { stats.rejected++; res.statusCode = 503; return res.end('queue full'); }
  try {
    stats.waitConnMax = Math.max(stats.waitConnMax, connWaiters.length + 1);
    const slot = await acquireConn();                             // ← waitconn 구간
    const dbMs = await dbQuery(slot, Math.max(500, Math.round(expo(work.rows))));   // ← db 구간
    if (CFG.CPU_MS) busyCpu(CFG.CPU_MS);                          // ← cpu 구간 (옵션. 이벤트 루프를 점유하므로 낮은 rps에서만 의미 있음)
    stats.done++; stats.byType[work.name] = (stats.byType[work.name] || 0) + 1;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, type: work.name, dbMs: +dbMs.toFixed(2) }));
  } finally { releaseThread(); }
});
server.keepAliveTimeout = 30000; server.maxConnections = 10000;

calibrate().then(() => server.listen(CFG.PORT, () => console.log(
  `[server] http://localhost:${CFG.PORT}  threads=${CFG.THREADS} conns=${CFG.CONNS} queue=${CFG.QUEUE} cpu=${CFG.CPU_MS}ms  작업=${WORK.map(w => `${w.name}(${Math.round(w.share * 100)}%/${w.ms}ms)`).join(' ')}`)));

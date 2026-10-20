/* engine.js — 파트 1 · 진단
   구획 1~5: 모델 · 시뮬레이션 엔진 · 이론값/병목 판정 · 시나리오 · 렌더링
   밖으로 내보내는 계약: createSim(M) · runHeadless(cfg, sec, warmup) · theory(cfg) · MODEL/BASE
                        · SCENARIOS/applyScenario/syncTrace · drawStage(sim) · drawCompare(list, opts)
                        · parseScenarioFile/registerFileScenario (파일 시나리오, 구획 4b)
   반환 모양만 지키면 엔진 내부는 자유롭게 바꿔도 된다. */
'use strict';
/* =====================================================================
 * 1. MODEL — 모델 파라미터 (UI에 바인딩되는 메인 인스턴스용)
 * ===================================================================== */
const MODEL = {
  cpuTimeMs: 5, dbTimeMs: 30, queueCap: 100, timeoutMs: 3000, threads: 50, conns: 10, rps: 100,
  // 앱 서버의 vCPU 개수. null 이면 CPU 무제한(예전 동작). EC2 인스턴스 비교가 인스턴스마다 이 값을 바꿔 넣는다 —
  // 같은 설정·같은 트래픽에서 "CPU 할당이 몇 개인가"만 달라졌을 때 무엇이 변하는지가 이 도구의 주 화면이다.
  cores: null,
  retryProb: 0,          // 실패(타임아웃·거절) 시 클라이언트가 재시도할 확률
  retryDelayMs: 200,
  cancelOnTimeout: false, // true면 클라이언트 타임아웃 시 서버도 즉시 작업 취소. false(현실 기본)면 서버는 아무도 안 기다리는 요청을 끝까지 처리(고아 요청 = 낭비)
  // ── 작업 구성(work mix) ──────────────────────────────────────────────
  //  같은 100rps라도 "조회 90 + 검색 10"과 "조회 50 + 검색 50"은 전혀 다른 자원을 요구한다.
  //  mixOn=false면 단일 평균 작업(dbTimeMs/cpuTimeMs)으로 기존과 동일하게 동작한다.
  mixOn: false,
  mix: [
    { id: 'browse', name: '상품 조회', share: 0.90, dbTimeMs: 20,  cpuTimeMs: 3 },
    { id: 'search', name: '복잡 검색', share: 0.10, dbTimeMs: 150, cpuTimeMs: 12 },
    { id: 'write',  name: '주문 쓰기', share: 0.00, dbTimeMs: 45,  cpuTimeMs: 6 },
  ],
  // ── 부하 의존 서비스 시간 (비선형) ───────────────────────────────────
  //  실측 발견 ①: 단독 30ms 쿼리가 커넥션 10개 동시 실행에서는 40~42ms가 된다(CPU·캐시·IO 경합).
  //  실측 발견 ②: 그 감속이 점유율에 비례하지 않는다. 250rps(ρ≈0.9)까지 p95가 129ms로 평평하다가
  //               300rps에서 654ms로 절벽처럼 떨어진다 — 한산할 땐 경합이 거의 없다가 포화 직전에 몰린다.
  //  그래서 선형(α×점유율)이 아니라 지수를 둔다:
  //
  //      dbTime_eff = dbTime × (1 + α × (사용 중 커넥션 / 커넥션 수)^γ)
  //
  //  γ=1 이면 예전의 선형. γ가 클수록 "평평하다 절벽" 모양이 된다.
  //  이 형태의 이점: 커넥션이 전부 찼을 때(k=c) 배율이 정확히 (1+α)가 되므로,
  //  α가 validation/server.js 가 시작할 때 직접 재는 「전 커넥션 동시 실행 감속률」과 같은 양이 된다.
  //  → α는 실측으로 고정하고 γ만 부하 곡선에서 맞추는 것이 가능하다 (D7).
  dbLoadAlpha: 0,
  dbLoadGamma: 2,
  dbScale: 1,            // 시나리오/개선안이 DB 시간 전체를 배율로 조정 (슬로우 쿼리 ×5, 쿼리 튜닝 ×0.7 …)
  dt: 2, historySec: 60,
};
const BASE = {};          // 슬라이더 값 (시나리오가 덮어쓰기 전 기준값)
// 작업 구성의 실효(가중평균) 서비스 시간 — 이론값·표시·보정이 모두 이 값을 기준으로 한다
function effTimes(M) {
  const scale = M.dbScale == null ? 1 : M.dbScale;
  if (!M.mixOn || !M.mix || !M.mix.length) return { db: M.dbTimeMs * scale, cpu: M.cpuTimeMs };
  let db = 0, cpu = 0, w = 0;
  for (const m of M.mix) { db += m.share * m.dbTimeMs; cpu += m.share * m.cpuTimeMs; w += m.share; }
  if (w <= 0) return { db: M.dbTimeMs * scale, cpu: M.cpuTimeMs };
  return { db: db / w * scale, cpu: cpu / w };
}

/* =====================================================================
 * 2. createSim() — 시뮬레이션 엔진 (동시에 여러 벌: 인스턴스마다 한 벌 + 보정용 헤드리스)
 *   요청 생애: spawn → queued → waitconn → db → waitcpu → cpu → done
 *                       ↘ rejected(큐 포화)   ↘ timeout(대기 초과) → (확률) 재시도 유입
 *   슬롯 자원 세 개: 스레드(threads) · DB 커넥션(conns) · vCPU(cores)
 * ===================================================================== */
function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) { const n = Math.round(lambda + Math.sqrt(lambda) * gauss()); return n < 0 ? 0 : n; }
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function expo(mean) { return -Math.log(1 - Math.random()) * mean; }
function pct(arr, p) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }

function createSim(M, opts = {}) {
  const visual = !!opts.visual;
  const S = {
    M, t: 0, reqs: [], fx: [], retryQ: [], nextId: 1, usedThreads: 0, usedConns: 0, usedCores: 0, lastSec: 0, history: [],
    win: null, onSecond: opts.onSecond || null,
    trace: null,   // 파일 trace 재생 상태 (startTrace). 켜져 있으면 포아송 도착 대신 이벤트 시각에 요청을 넣는다
  };
  const nCls = (M.mix && M.mix.length) || 0;
  const newWin = () => ({ done: 0, rej: 0, to: 0, retry: 0, wasted: 0, dbSum: 0, dbN: 0, lat: [],
    brk: { q: 0, wc: 0, db: 0, cpu: 0 },   // 완료 요청의 단계별 체류시간 합 (ms) — 지연 분해용
    pass: { thread: 0, conn: 0, cpu: 0 },  // 이 구간을 실제로 통과한 건수 — 흐름도의 띠 두께
    lost: { q: 0, wc: 0, run: 0 },         // 클라이언트가 포기한 지점 (큐 / 커넥션 대기 / 처리 중)
    cls: Array.from({ length: nCls }, () => ({ done: 0, lat: [] })),   // 작업 유형별 완료·지연
    thBusy: 0, coBusy: 0, cpBusy: 0, ticks: 0, waitSum: 0, spawned: 0 });
  S.win = newWin();

  // ── 작업 유형 샘플링: 비율(share)대로 요청 하나의 종류를 정한다. mixOn=false면 -1(단일 평균 작업) ──
  function pickClass() {
    if (!M.mixOn || !nCls) return -1;
    let tot = 0; for (const m of M.mix) tot += m.share;
    if (tot <= 0) return -1;
    let x = Math.random() * tot;
    for (let i = 0; i < nCls; i++) { x -= M.mix[i].share; if (x <= 0) return i; }
    return nCls - 1;
  }
  const dbBase  = (r) => (r.cls >= 0 ? M.mix[r.cls].dbTimeMs  : M.dbTimeMs) * (M.dbScale == null ? 1 : M.dbScale);
  const cpuBase = (r) => (r.cls >= 0 ? M.mix[r.cls].cpuTimeMs : M.cpuTimeMs);
  // 부하 의존: 커넥션이 동시에 붐빌수록 쿼리 한 건이 느려진다 (usedConns는 이 시점에 방금 +1 된 상태)
  const dbEff = (r) => dbBase(r) * (1 + (M.dbLoadAlpha || 0) * Math.pow(S.usedConns / M.conns, M.dbLoadGamma == null ? 2 : M.dbLoadGamma));

  // cls·tAt 을 주지 않으면 지금 시각에 비율대로 유형을 뽑는다. trace 는 이벤트의 op·정확한 도착 시각을 넘긴다
  function spawn(retry, cls, tAt) {
    const t0 = tAt == null ? S.t : tAt;
    return { id: S.nextId++, state: 'queued', tSpawn: t0, tState: t0, tDone: 0, retry: !!retry, abandoned: false, cls: cls === undefined ? pickClass() : cls,
             tq: 0, twc: 0, tdb: 0, tcw: 0, x: -20, y: 0, tx: 0, ty: 0, thrSlot: null, dbSlot: null };
  }
  function finish(r, state) {
    if (r.state === 'waitconn' || r.state === 'db' || r.state === 'waitcpu' || r.state === 'cpu') S.usedThreads--;
    if (r.state === 'db') S.usedConns--;
    if (r.state === 'cpu') S.usedCores--;
    r.state = state; r.tEnd = S.t;
    if (state === 'done') { if (r.abandoned) { S.win.wasted++; r.state = 'wasted'; } else { const tot = S.t - r.tSpawn; S.win.done++; S.win.lat.push(tot);
      const b = S.win.brk; b.q += r.tq; b.wc += r.twc; b.db += r.tdb; b.cpu += Math.max(0, tot - r.tq - r.twc - r.tdb);
      if (r.cls >= 0 && S.win.cls[r.cls]) { S.win.cls[r.cls].done++; S.win.cls[r.cls].lat.push(tot); } } }
    else if (state === 'rejected') { S.win.rej++; clientFail(); }
    // 'timeout' 상태로 finish되는 건 cancelOnTimeout일 때뿐 (집계는 abandon()에서 이미 함)
    if (visual) { r.fade = 1; S.fx.push(r); if (S.fx.length > 800) S.fx.shift(); }
  }
  function clientFail() { if (Math.random() < M.retryProb) S.retryQ.push(S.t + M.retryDelayMs); }   // 타임아웃·거절(503) 모두 재시도 대상
  // 클라이언트가 포기하는 순간: 클라이언트 관점 실패 확정. 서버는 (취소 전파가 없으면) 계속 처리한다
  function abandon(r) {
    r.abandoned = true; S.win.to++;
    S.win.lost[r.state === 'queued' ? 'q' : r.state === 'waitconn' ? 'wc' : 'run']++;   // 어디서 포기당했나
    clientFail(); if (M.cancelOnTimeout) { finish(r, 'timeout'); return true; } return false;
  }
  function enqueue(r, queued) {
    S.win.spawned++;
    if (queued >= M.queueCap) { finish(r, 'rejected'); return false; }
    S.reqs.push(r); return true;
  }
  // trace 재생: 도착 시각(origin + 주기 오프셋 + t_ms)이 지금 이하인 이벤트를 전부 꺼내 그 시각 그대로 요청을 만든다
  function injectTrace(queued) {
    const tr = S.trace;
    const cls = M.mixOn && M.mix ? TRACE_OP_MIX.map(id => M.mix.findIndex(m => m.id === id)) : null;
    while (!tr.done) {
      if (tr.i >= tr.n) { if (!tr.loop) { tr.done = true; break; } tr.i = 0; tr.base += tr.dur; tr.cycle++; continue; }
      const tAt = tr.base + tr.t[tr.i];
      if (tAt > S.t) break;
      const c = cls ? cls[tr.op[tr.i]] : -1;
      tr.i++; tr.injected++; tr.lastT = tAt; tr.rec.push(tAt);
      if (tr.log) tr.log.push(tAt);
      if (enqueue(spawn(false, c, tAt), queued)) queued++;
    }
    const lo = S.t - 1000;
    while (tr.recHead < tr.rec.length && tr.rec[tr.recHead] <= lo) tr.recHead++;
    if (tr.recHead > 4096) { tr.rec = tr.rec.slice(tr.recHead); tr.recHead = 0; }
    return queued;
  }
  function step(dt) {
    S.t += dt;
    let queued = 0; for (const r of S.reqs) if (r.state === 'queued') queued++;
    // (a) 유입: 신규(포아송 — trace 재생 중이면 0건) + trace 이벤트 + 재시도(예약)
    const n = S.trace ? 0 : poisson(M.rps * dt / 1000);
    for (let i = 0; i < n; i++) if (enqueue(spawn(false), queued)) queued++;
    if (S.trace) queued = injectTrace(queued);
    while (S.retryQ.length && S.retryQ[0] <= S.t) { S.retryQ.shift(); S.win.retry++; if (enqueue(spawn(true), queued)) queued++; }
    // (b) 상태 전이 (FIFO)
    const alive = [];
    for (const r of S.reqs) {
      const age = S.t - r.tSpawn;
      if (!r.abandoned && age > M.timeoutMs && r.state !== 'cpu' && abandon(r)) continue;
      if (r.state === 'queued') {
        if (S.usedThreads < M.threads) { S.usedThreads++; S.win.pass.thread++; r.tq = S.t - r.tState; r.state = 'waitconn'; r.tState = S.t; }
      }
      if (r.state === 'waitconn') {
        if (S.usedConns < M.conns) { S.usedConns++; S.win.pass.conn++; r.twc = S.t - r.tState; r.state = 'db'; r.tState = S.t; r.tDone = S.t + expo(dbEff(r)); }
      }
      if (r.state === 'db' && S.t >= r.tDone) { S.usedConns--; r.tdb = S.t - r.tState; S.win.dbSum += r.tdb; S.win.dbN++; r.state = 'waitcpu'; r.tState = S.t; }
      // vCPU 슬롯: 코어가 전부 차 있으면 스레드를 쥔 채로 CPU를 기다린다 (작은 인스턴스에서 여기가 병목이 된다)
      if (r.state === 'waitcpu' && (M.cores == null || S.usedCores < M.cores)) {
        S.usedCores++; S.win.pass.cpu++; r.tcw = S.t - r.tState; r.state = 'cpu'; r.tState = S.t; r.tDone = S.t + cpuBase(r);
      }
      if (r.state === 'cpu' && S.t >= r.tDone) { finish(r, 'done'); continue; }
      alive.push(r);
    }
    S.reqs = alive;
    // (c) 집계
    const w = S.win; w.ticks++; w.thBusy += S.usedThreads / M.threads; w.coBusy += S.usedConns / M.conns;
    w.cpBusy += M.cores ? Math.min(1, S.usedCores / M.cores) : 0;
    let waiting = 0; for (const r of S.reqs) if (r.state === 'queued' || r.state === 'waitconn') waiting++;
    w.waitSum += waiting;
    const sec = Math.floor(S.t / 1000);
    if (sec !== S.lastSec) { S.lastSec = sec; roll(); }
  }
  function roll() {
    const w = S.win, k = Math.max(1, w.ticks);
    let q = 0, wc = 0, cw = 0; for (const r of S.reqs) { if (r.state === 'queued') q++; else if (r.state === 'waitconn') wc++; else if (r.state === 'waitcpu') cw++; }
    const n = Math.max(1, w.done);
    const h = { t: S.t / 1000, in: w.spawned, out: w.done, rej: w.rej, to: w.to, retry: w.retry, wasted: w.wasted, dbMean: w.dbN ? w.dbSum / w.dbN : 0,
      brk: { q: w.brk.q / n, wc: w.brk.wc / n, db: w.brk.db / n, cpu: w.brk.cpu / n },
      pass: { thread: w.pass.thread, conn: w.pass.conn, cpu: w.pass.cpu },
      lost: { q: w.lost.q, wc: w.lost.wc, run: w.lost.run },
      p50: pct(w.lat, .5), p95: pct(w.lat, .95), p99: pct(w.lat, .99), lat: w.lat,
      thU: w.thBusy / k, coU: w.coBusy / k, cpU: w.cpBusy / k, q, wc, cw, avgWait: w.waitSum / k,
      // 작업 유형별: 같은 서버인데 어떤 작업이 먼저 SLO를 깨는지 보려면 유형별 p95를 따로 봐야 한다
      cls: w.cls.map((c, i) => ({ name: (M.mix && M.mix[i]) ? M.mix[i].name : '', done: c.done, p50: pct(c.lat, .5), p95: pct(c.lat, .95) })),
      clsLat: w.cls.map(c => c.lat),
      rps: M.rps, dbTimeMs: M.dbTimeMs };
    S.history.push(h); while (S.history.length > M.historySec + 1) S.history.shift();
    S.win = newWin();
    if (S.onSecond) S.onSecond(h);
  }
  function reset() { S.t = 0; S.reqs = []; S.fx = []; S.retryQ = []; S.usedThreads = 0; S.usedConns = 0; S.usedCores = 0; S.history = []; S.lastSec = 0; S.win = newWin(); S.trace = null; }
  return { S, step, reset };
}

// 헤드리스 실행: cfg로 durationSec 동안 돌리고 warmupSec 이후 집계
function runHeadless(cfg, durationSec, warmupSec) {
  const M = Object.assign({}, MODEL, cfg, { dt: 4 });
  const sim = createSim(M);
  const lat = []; let inN = 0, done = 0, rej = 0, to = 0; const B = { q: 0, wc: 0, db: 0, cpu: 0 }; let bn = 0;
  const nC = (M.mixOn && M.mix) ? M.mix.length : 0, CL = Array.from({ length: nC }, () => []);
  let thU = 0, coU = 0, cpU = 0, qSum = 0, samples = 0;
  sim.S.onSecond = (h) => { if (h.t > warmupSec) { lat.push(...h.lat); inN += h.in; done += h.out; rej += h.rej; to += h.to;
    thU += h.thU; coU += h.coU; cpU += h.cpU || 0; qSum += h.q; samples++;
    for (let i = 0; i < nC; i++) if (h.clsLat && h.clsLat[i]) CL[i].push(...h.clsLat[i]);
    if (h.out) { for (const k in B) B[k] += h.brk[k] * h.out; bn += h.out; } } };
  for (let i = 0; i < durationSec * 1000 / M.dt; i++) sim.step(M.dt);
  const secs = durationSec - warmupSec, k = Math.max(1, samples);
  if (bn) for (const key in B) B[key] /= bn;
  return { p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), errRate: inN ? (rej + to) / inN : 0,
    thr: done / secs, inRate: inN / secs, brk: B, thU: thU / k, coU: coU / k, cpU: cpU / k, qAvg: qSum / k,
    cls: CL.map((a, i) => ({ name: M.mix[i].name, n: a.length, p50: pct(a, .5), p95: pct(a, .95) })) };
}

/* =====================================================================
 * 3. 이론값 + detectBottleneck() — 병목·장애 패턴 판정
 * ===================================================================== */
function erlangC(c, a) { if (a >= c) return 1; let sum = 0, term = 1;
  for (let k = 0; k < c; k++) { if (k > 0) term *= a / k; sum += term; }
  const last = term * a / c, top = last * c / (c - a); return top / (sum + top); }
function theory(M) {
  const e = effTimes(M), lam = M.rps / 1000, alpha = M.dbLoadAlpha || 0, gamma = M.dbLoadGamma == null ? 2 : M.dbLoadGamma;
  // 부하 의존 서비스 시간은 자기참조적이다(느려지면 더 붐비고, 더 붐비면 더 느려진다) → 고정점 반복으로 푼다
  let dbT = e.db;
  for (let i = 0; i < 8; i++) dbT = e.db * (1 + alpha * Math.pow(Math.min(1, lam * dbT / M.conns), gamma));
  const muT = 1 / (dbT + e.cpu), muD = 1 / dbT;
  const rhoT = lam / (M.threads * muT), rhoD = lam / (M.conns * muD);
  const capT = M.threads * muT * 1000, capD = M.conns * muD * 1000;
  // vCPU: 코어 하나가 초당 1000ms 의 CPU 시간을 준다 → 요청당 CPU 시간으로 나누면 코어당 처리 가능 rps
  const cores = M.cores || 0, useCpu = cores > 0 && e.cpu > 0;
  const rhoC = useCpu ? lam * e.cpu / cores : 0, capC = useCpu ? cores / e.cpu * 1000 : Infinity;
  const cap = Math.min(capT, capD, capC);
  const bottle = rhoC >= rhoD && rhoC >= rhoT ? 'cpu' : rhoD >= rhoT ? 'db' : 'thread';
  const dbBottle = rhoD >= rhoT, c = dbBottle ? M.conns : M.threads, mu = dbBottle ? muD : muT, rho = dbBottle ? rhoD : rhoT;
  let wq = Infinity; if (rho < 1) wq = erlangC(c, lam / mu) / (c * mu - lam);
  return { rhoT, rhoD, rhoC, cap, capT, capD, capC, wq, dbBottle, bottle, dbEffMs: dbT, dbNomMs: e.db, cpuEffMs: e.cpu };
}
function detectBottleneck(S, M) {
  const h = S.history[S.history.length - 1]; if (!h) return { level: 'ok', title: '정상', desc: '데이터 수집 중' };
  const th = theory(M), errRate = (h.rej + h.to) / Math.max(1, h.in), rhoMax = Math.max(th.rhoT, th.rhoD, th.rhoC);
  const retryShare = h.retry / Math.max(1, h.in);
  const nomDb = effTimes(Object.assign({}, BASE, { dbScale: 1 })).db;   // 설정상 기대되는 DB 시간 (작업 구성 가중평균)
  // 관측된 DB 처리시간(완료 요청의 db 구간 평균)이 기준의 1.8배 이상 + 커넥션 포화 = 슬로우 쿼리
  if (h.coU > 0.9 && h.dbMean > nomDb * 1.8)
    return { level: 'bad', title: '슬로우 쿼리 → 커넥션 고갈', desc: `DB 처리시간이 ${Math.round(nomDb)}ms → ${Math.round(h.dbMean)}ms로 늘어 유입(${M.rps}rps)이 그대로인데 커넥션이 100% 점유. 앱 서버 CPU/스레드는 멀쩡해 보인다 — 커넥션 증설은 증상 완화일 뿐, 원인은 쿼리/DB에 있다` };
  // 작업 구성 진단: 소수 비율의 무거운 작업이 DB 시간의 대부분을 먹는 경우 (같은 rps라도 구성이 다르면 병목이 다르다)
  if (M.mixOn && M.mix) {
    let tot = 0; const load = M.mix.map(m => { const l = m.share * m.dbTimeMs; tot += l; return l; });
    let hi = 0; for (let i = 1; i < load.length; i++) if (load[i] > load[hi]) hi = i;
    const heavy = M.mix[hi], loadShare = tot > 0 ? load[hi] / tot : 0;
    if (rhoMax > 0.7 && loadShare > 0.5 && heavy.share < 0.35)
      return { level: 'warn', title: `작업 구성 편중 — "${heavy.name}"`, desc: `요청의 ${Math.round(heavy.share * 100)}%뿐인 「${heavy.name}」(DB ${heavy.dbTimeMs}ms)가 DB 시간의 ${Math.round(loadShare * 100)}%를 쓴다. 유입 총량이 아니라 <b>구성</b>이 병목을 만든 상태 — 이 작업의 비율이 조금만 늘어도 용량이 급격히 준다. 자원 증설보다 이 작업의 쿼리/캐시가 먼저다 (ρ=${rhoMax.toFixed(2)})` };
  }
  if (h.q > M.queueCap * 0.25 && errRate < 0.02 && h.p95 > 600)
    return { level: 'bad', title: '큐 지연 축적 (숨은 장애)', desc: `실패율 ${(errRate * 100).toFixed(1)}%로 대시보드는 초록인데 p95 ${Math.round(h.p95)}ms, 큐 ${h.q}/${M.queueCap}. 큐가 크면 "안 죽는" 대신 모두가 느려진다 — 에러율만 보는 알람은 이걸 놓친다. 큐를 줄이고 빨리 실패시키는 편이 낫다 (병목: ${th.dbBottle ? 'DB 커넥션' : '스레드'})` };
  if (retryShare > 0.25 && h.coU > 0.85)
    return { level: 'bad', title: '재시도 폭풍 (metastable)', desc: `유입의 ${(retryShare * 100).toFixed(0)}%가 재시도, 서버 작업 중 ${h.wasted}/s는 이미 포기한 클라이언트를 위한 낭비. 부하가 줄어도 재시도가 자리를 채워 스스로 회복하지 못한다 — 재시도 backoff/서킷브레이커, 취소 전파, 또는 유입 차단이 필요` };
  if (M.cores && h.cpU > 0.9 && (h.cw || 0) >= 1)
    return { level: 'bad', title: `CPU 포화 — vCPU ${M.cores}개 부족`, desc: `코어 ${M.cores}개가 계속 100%. 요청 ${h.cw}건이 DB를 끝내고도 CPU를 기다린다. 이론상 이 코어 수로는 ${Math.round(th.capC)}rps가 한계 (유입 ${M.rps}rps) — 커넥션·스레드를 늘려도 나아지지 않는다. 더 큰 인스턴스(vCPU↑) 또는 요청당 CPU 시간 감소가 답이다` };
  if (h.coU > 0.9 && h.wc >= Math.max(3, M.threads * 0.2))
    return { level: 'bad', title: 'DB 커넥션 병목', desc: `스레드 ${h.wc}개가 커넥션을 못 얻어 놀고 있음. 스레드를 늘려도 나아지지 않는다 — 커넥션 풀을 늘리거나 DB 처리시간을 줄일 것 (ρ_db=${th.rhoD.toFixed(2)})` };
  if (h.thU > 0.9 && h.q > 0)
    return { level: 'bad', title: '스레드 포화', desc: `모든 스레드가 실제 작업 중이고 큐가 쌓임 (ρ_thread=${th.rhoT.toFixed(2)}). 스레드를 늘리면 개선된다 — 커넥션 여유가 있을 때까지만` };
  if (errRate > 0.05)
    return { level: 'bad', title: '유입 과다', desc: `요청의 ${(errRate * 100).toFixed(0)}%가 거절/타임아웃. 이론 최대 처리량 ${th.cap.toFixed(0)}rps 대비 유입 ${M.rps}rps` };
  if (rhoMax > 0.75)
    return { level: 'warn', title: '임계 접근', desc: `이용률 ρ=${rhoMax.toFixed(2)}. 여기서부터 대기시간이 비선형으로 폭발한다 (${th.dbBottle ? 'DB 커넥션' : '스레드'} 단계)` };
  return { level: 'ok', title: '정상', desc: `여유 있음 (ρ=${rhoMax.toFixed(2)}, 최대 ${th.cap.toFixed(0)}rps)` };
}

/* =====================================================================
 * 4. 시나리오 — 정상 부하 + 장애 패턴 (유입 곡선, 파라미터 덮어쓰기, 단계별 해설)
 * ===================================================================== */
const SCENARIOS = {
  manual:     { name: '수동 (슬라이더)',        at: () => ({ rps: null }), explain: [{ t: 0, text: '수동' }] },
  steady:     { name: '정상 부하 80 rps',        at: () => ({ rps: 80 }),   explain: [{ t: 0, text: '정상' }] },
  spike:      { name: '스파이크 100 → 400 rps', period: 40, at: (t) => ({ rps: t > 15 && t < 25 ? 400 : 100 }),
    explain: [{ t: 15, text: '스파이크 400rps' }, { t: 25, text: '회복' }] },
  ramp:       { name: '점증 0 → 600 rps',       period: 80, at: (t) => ({ rps: t < 60 ? Math.round(t / 60 * 600) : 0 }),
    explain: [{ t: 33, text: 'ρ→1 (333rps)' }, { t: 60, text: '유입 0' }] },
  slowq:      { name: '장애: 슬로우 쿼리',       period: 60, params: { rps: 150 },
    at: (t) => ({ rps: 150, dbScale: t > 15 && t < 40 ? 5 : 1 }),
    explain: [{ t: 15, text: 'DB 시간 ×5' }, { t: 40, text: 'DB 회복' }] },
  retrystorm: { name: '장애: 재시도 폭풍',       period: 70, params: { retryProb: 0.9, timeoutMs: 1000, queueCap: 400 },
    at: (t) => ({ rps: t > 15 && t < 25 ? 450 : 300 }),
    explain: [{ t: 15, text: '스파이크 450rps' }, { t: 25, text: '유입 복귀 (회복 안 됨)' }] },
  herd:       { name: '장애: Thundering herd',  period: 50, params: { queueCap: 100 },
    at: (t) => ({ rps: t < 10 ? 150 : t < 18 ? 0 : t < 24 ? 700 : 150 }),
    explain: [{ t: 10, text: '재시작 (유입 0)' }, { t: 18, text: '복구 순간 700rps' }, { t: 24, text: '평시 복귀' }] },
  hiddenq:    { name: '장애: 큐 지연 축적',      period: 60, params: { queueCap: 1000, timeoutMs: 10000 },
    at: (t) => ({ rps: t > 10 && t < 40 ? 360 : 200 }),
    explain: [{ t: 10, text: '360rps (에러 없이 느려짐)' }, { t: 40, text: '유입 감소' }] },
};
let scenarioKey = 'manual', scenarioStart = 0;
function applyScenario(sim) {
  const sc = SCENARIOS[scenarioKey];
  const t = (sim.S.t - scenarioStart) / 1000, tt = sc.period ? t % sc.period : t;
  // 슬라이더 기준값으로 되돌린 뒤 시나리오 덮어쓰기
  Object.assign(MODEL, BASE);
  const cur = sc.at(tt);
  for (const k in cur) if (cur[k] != null) MODEL[k] = cur[k];
  return tt;
}
// 파일 trace 는 인스턴스 시뮬마다 따로 재생한다 — 같은 이벤트를 같은 시각에 넣으므로 모든 인스턴스가 같은 유입을 받는다.
// 시나리오가 바뀌거나 scenarioStart 가 바뀌면(재시작) 포인터를 처음으로 되돌리고, 도중에 추가된 시뮬은 지난 이벤트를 건너뛴다.
// 반환: 최근 1초 실제 도착 수 (trace 시나리오가 아니면 null) — MODEL.rps 에 넣어 이론값·병목 판정이 실제 유입을 보게 한다
function syncTrace(sim) {
  const sc = SCENARIOS[scenarioKey];
  if (!sc || !sc.trace) { sim.S.trace = null; return null; }
  let tr = sim.S.trace;
  if (!tr || tr.data !== sc.trace || tr.origin !== scenarioStart) {
    tr = sim.S.trace = startTrace(sc.trace, scenarioStart);
    const now = sim.S.t;
    if (tr.loop && now > tr.origin) { tr.cycle = Math.floor((now - tr.origin) / tr.dur); tr.base += tr.cycle * tr.dur; }
    while (tr.i < tr.n && tr.base + tr.t[tr.i] < now) tr.i++;
  }
  return traceRecent(tr, sim.S.t);
}

/* =====================================================================
 * 4b. 파일 시나리오 — docs/scenario-format.md (v1)
 *   curve: 키프레임 RPS 곡선 → 기존 at(t) 경로 (포아송 도착)
 *   trace: 요청별 도착 시각 → createSim 의 S.trace 로 적힌 시각에 정확히 주입
 *   배율은 불러올 때 적용하는 옵션이다. 파일에는 원본 규모만 둔다.
 *   이 구획의 함수는 DOM 에 접근하지 않는다.
 * ===================================================================== */
const SCN_FORMAT = 'reinforcebean-scenario';
const TRACE_OPS = ['read', 'search', 'write'];            // op 코드 0·1·2
const TRACE_OP_MIX = ['browse', 'search', 'write'];       // 같은 순서의 MODEL.mix id (조회·검색·쓰기)
const TRACE_EXCLUDE_DEFAULT = ['cron', 'admin', 'infra'];
const TRACE_MAX_EVENTS = 5000000;                         // 배율 결과 상한 — 넘으면 브라우저 메모리·정렬 시간이 감당이 안 된다
// 이 키들은 슬라이더·체크박스가 있어 params 를 UI에 한 번 반영한다. 나머지 params 는 그 시나리오가 켜져 있는 동안만 at() 이 덮어쓴다
const SCN_UI_PARAMS = ['rps', 'threads', 'conns', 'queueCap', 'dbTimeMs', 'timeoutMs', 'retryProb', 'dbLoadAlpha', 'dbLoadGamma', 'cancelOnTimeout', 'mixOn'];

const scnIsObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// explain.text 는 innerHTML 로 그려지므로 <b> 만 살리고 나머지는 글자로 만든다
const scnSanitize = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)b&gt;/g, '<$1b>');

// 텍스트 → { ok: true, scenario, warnings } | { ok: false, errors }
function parseScenarioFile(text) {
  const errors = [], warnings = [], MAXE = 30; let more = 0;
  const err = (m) => { if (errors.length < MAXE) errors.push(m); else more++; };
  const fail = () => ({ ok: false, errors: more ? errors.concat(`… 외 ${more}건의 오류`) : errors });
  if (typeof text !== 'string' || !text.trim()) return { ok: false, errors: ['빈 파일입니다.'] };
  let d;
  try { d = JSON.parse(text); } catch (e) { return { ok: false, errors: [`JSON 파싱 실패: ${e.message}`] }; }
  if (!scnIsObj(d)) return { ok: false, errors: ['최상위는 객체({ … })여야 합니다.'] };
  const isInt = Number.isInteger;
  const unitless = (o, where) => {
    for (const k of ['t', 'time', 't_s', 't_sec']) if (k in o && !('t_ms' in o)) {
      err(`${where}: 단위 없는 시간 필드 \`${k}\`가 있습니다. \`t_ms\`(밀리초)를 사용하세요.`); return true;
    }
    return false;
  };
  const modelKeyErr = (k, where, numericOnly) => {
    if (!Object.prototype.hasOwnProperty.call(MODEL, k)) return `${where}: "${k}"는 MODEL에 없는 키입니다.`;
    const tp = typeof MODEL[k];
    if (tp !== 'number' && !(tp === 'boolean' && !numericOnly)) return `${where}: "${k}"는 ${numericOnly ? '숫자 트랙으로' : '값으로'} 지정할 수 없는 키입니다.`;
    return null;
  };

  // ── 공통 필드 ──
  if (d.format !== SCN_FORMAT) err(`format은 "${SCN_FORMAT}"이어야 합니다${d.format === undefined ? ' (누락)' : ` (현재 ${JSON.stringify(d.format)})`}.`);
  if (d.version === undefined) err('version이 없습니다.');
  else if (d.version !== 1) err(`version ${JSON.stringify(d.version)}은 지원하지 않습니다. 1만 지원합니다.`);
  if (d.mode !== 'curve' && d.mode !== 'trace') err(`mode는 "curve" 또는 "trace"여야 합니다${d.mode === undefined ? ' (누락)' : ` (현재 ${JSON.stringify(d.mode)})`}.`);
  if (typeof d.name !== 'string' || !d.name.trim()) err('name(문자열)이 없습니다.');
  if (d.duration_ms === undefined) {
    const alt = ['duration', 'duration_s', 'duration_sec'].find(k => k in d);
    err(alt ? `단위 없는 시간 필드 \`${alt}\`가 있습니다. \`duration_ms\`(밀리초)를 사용하세요.` : 'duration_ms가 없습니다.');
  } else if (!isInt(d.duration_ms) || d.duration_ms <= 0) err('duration_ms는 0보다 큰 정수(밀리초)여야 합니다.');
  if (d.loop !== undefined && typeof d.loop !== 'boolean') err('loop는 true 또는 false여야 합니다.');
  if (d.description !== undefined && typeof d.description !== 'string') err('description은 문자열이어야 합니다.');
  if (d.source !== undefined && !scnIsObj(d.source)) err('source는 객체여야 합니다.');
  const dur = d.duration_ms, durOk = isInt(dur) && dur > 0;

  const params = {};
  if (d.params !== undefined) {
    if (!scnIsObj(d.params)) err('params는 객체여야 합니다.');
    else for (const k in d.params) {
      const ke = modelKeyErr(k, 'params', false); if (ke) { err(ke); continue; }
      const v = d.params[k], num = typeof MODEL[k] === 'number';
      if (num ? !(typeof v === 'number' && isFinite(v)) : typeof v !== 'boolean') err(`params.${k}: ${num ? '숫자' : 'true/false'}여야 합니다.`);
      else params[k] = v;
    }
  }

  const explain = [];
  if (d.explain !== undefined) {
    if (!Array.isArray(d.explain)) err('explain은 배열이어야 합니다.');
    else d.explain.forEach((e, i) => {
      const w = `explain[${i}]`;
      if (!scnIsObj(e)) return err(`${w}: 객체여야 합니다.`);
      if (unitless(e, w)) return;
      if (!isInt(e.t_ms) || e.t_ms < 0) return err(`${w}: t_ms는 0 이상의 정수(밀리초)여야 합니다.`);
      if (typeof e.text !== 'string') return err(`${w}: text(문자열)가 없습니다.`);
      explain.push({ t_ms: e.t_ms, text: scnSanitize(e.text) });
    });
  }

  // ── curve ──
  let tracks = null, events = null;
  if (d.mode === 'curve') {
    if (!scnIsObj(d.tracks)) err('curve 모드에는 tracks 객체가 필요합니다.');
    else {
      if (!('rps' in d.tracks)) err('tracks.rps가 없습니다 (curve 모드 필수).');
      tracks = {};
      for (const k in d.tracks) {
        const w = `tracks.${k}`;
        const ke = modelKeyErr(k, 'tracks', true); if (ke) { err(ke); continue; }
        const pts = d.tracks[k];
        if (!Array.isArray(pts) || !pts.length) { err(`${w}: 점 배열이 비어 있거나 배열이 아닙니다.`); continue; }
        let bad = false; const out = [];
        pts.forEach((p, i) => {
          const wp = `${w}[${i}]`;
          if (!scnIsObj(p)) { err(`${wp}: 객체여야 합니다.`); bad = true; return; }
          if (unitless(p, wp)) { bad = true; return; }
          if (!isInt(p.t_ms) || p.t_ms < 0) { err(`${wp}: t_ms는 0 이상의 정수(밀리초)여야 합니다.`); bad = true; return; }
          if (typeof p.v !== 'number' || !isFinite(p.v) || p.v < 0) { err(`${wp}: v는 0 이상의 유한한 숫자여야 합니다.`); bad = true; return; }
          out.push({ t_ms: p.t_ms, v: p.v });
        });
        if (bad) continue;
        for (let i = 1; i < out.length && !bad; i++) {
          if (out[i].t_ms < out[i - 1].t_ms) { err(`${w}[${i}]: t_ms ${out[i].t_ms}가 앞 점(${out[i - 1].t_ms})보다 작습니다. 오름차순이어야 합니다 (역순 불가).`); bad = true; }
          else if (i >= 2 && out[i].t_ms === out[i - 1].t_ms && out[i].t_ms === out[i - 2].t_ms) { err(`${w}: t_ms ${out[i].t_ms}가 3개 이상입니다. 같은 시각은 최대 2개(순간 점프)까지만 허용됩니다.`); bad = true; }
        }
        if (!bad && durOk && out[out.length - 1].t_ms > dur) { err(`${w}: 마지막 t_ms ${out[out.length - 1].t_ms}가 duration_ms(${dur})보다 큽니다.`); bad = true; }
        if (!bad) tracks[k] = out;
      }
    }
  }

  // ── trace ──
  else if (d.mode === 'trace') {
    if (!Array.isArray(d.events)) err('trace 모드에는 events 배열이 필요합니다.');
    else if (!d.events.length) err('events가 비어 있습니다.');
    else {
      const E = d.events; let sorted = true, prev = -Infinity;
      for (let i = 0; i < E.length; i++) {
        const e = E[i], w = `events[${i}]`;
        if (!scnIsObj(e)) { err(`${w}: 객체여야 합니다.`); continue; }
        if (unitless(e, w)) continue;
        if (!isInt(e.t_ms) || e.t_ms < 0 || (durOk && e.t_ms >= dur)) { err(`${w}: t_ms ${JSON.stringify(e.t_ms)}는 0 이상, duration_ms(${dur}) 미만의 정수(밀리초)여야 합니다.`); continue; }
        if (!TRACE_OPS.includes(e.op)) { err(`${w}: op ${JSON.stringify(e.op)}는 허용되지 않습니다. "read", "search", "write" 중 하나여야 합니다.`); continue; }
        if (e.g != null && !isInt(e.g)) err(`${w}: g(묶음 번호)는 정수여야 합니다.`);
        if (e.src !== undefined && typeof e.src !== 'string') err(`${w}: src는 문자열이어야 합니다.`);
        if (e.ep !== undefined && typeof e.ep !== 'string') err(`${w}: ep는 문자열이어야 합니다.`);
        if (e.t_ms < prev) sorted = false;
        prev = e.t_ms;
      }
      if (!errors.length) {
        events = traceColumns(E, sorted);
        if (!sorted) warnings.push('events가 t_ms 순으로 정렬되어 있지 않아 불러오면서 정렬했습니다.');
      }
    }
  }
  if (errors.length) return fail();
  return { ok: true, warnings, scenario: {
    format: SCN_FORMAT, version: 1, mode: d.mode, name: d.name.trim(), description: d.description || '',
    duration_ms: dur, loop: !!d.loop, source: d.source || {}, params, explain, tracks, events } };
}

// 이벤트 객체 배열 → 타입 배열 열 (수십만 건 대비). sorted=false 면 t_ms 기준 안정 정렬
function traceColumns(E, sorted) {
  const n = E.length, order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (!sorted) order.sort((a, b) => E[a].t_ms - E[b].t_ms || a - b);
  const t = new Float64Array(n), op = new Uint8Array(n), g = new Float64Array(n), src = new Uint16Array(n), ep = new Uint32Array(n);
  const srcNames = [], epNames = [], srcIdx = new Map(), epIdx = new Map(), opCount = [0, 0, 0], gs = new Set();
  const intern = (m, names, s) => { let k = m.get(s); if (k === undefined) { k = names.length; m.set(s, k); names.push(s); } return k; };
  for (let j = 0; j < n; j++) {
    const e = E[order[j]];
    t[j] = e.t_ms; op[j] = TRACE_OPS.indexOf(e.op); opCount[op[j]]++;
    if (e.g == null) g[j] = NaN; else { g[j] = e.g; gs.add(e.g); }
    src[j] = intern(srcIdx, srcNames, e.src || 'user');
    ep[j] = intern(epIdx, epNames, e.ep || '');
  }
  return { n, t, op, g, src, srcNames, ep, epNames, opCount, groupCount: gs.size };
}

// 명세 2장 보간. x(ms) 에서의 트랙 값. loop=false 이고 x >= duration 이면 rps 는 0, 다른 트랙은 undefined(MODEL 기본값 유지)
function curveValue(p, x, dur, loop, isRps) {
  if (loop) x = ((x % dur) + dur) % dur;
  else if (x >= dur) return isRps ? 0 : undefined;
  const n = p.length;
  if (x < p[0].t_ms) return p[0].v;
  if (x >= p[n - 1].t_ms) return p[n - 1].v;
  // p[i].t_ms <= x 인 마지막 i. 같은 t_ms 가 두 개면 뒤쪽 점이 잡히므로 그 시각에서는 뒤쪽 값이 된다
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (p[mid].t_ms <= x) lo = mid; else hi = mid - 1; }
  const a = p[lo], b = p[lo + 1];
  return a.v + (b.v - a.v) * (x - a.t_ms) / (b.t_ms - a.t_ms);
}
const scaleCurvePoints = (p, N) => p.map(q => ({ t_ms: q.t_ms, v: q.v * N }));
// 곡선의 평균 rps(정확한 면적 ÷ 길이)와 최댓값
function curveStats(p, dur) {
  const n = p.length; let area = p[0].v * Math.min(p[0].t_ms, dur), peak = 0;
  for (let i = 0; i < n; i++) {
    peak = Math.max(peak, p[i].v);
    if (i < n - 1) area += (p[i].v + p[i + 1].v) / 2 * (p[i + 1].t_ms - p[i].t_ms);
  }
  area += p[n - 1].v * Math.max(0, dur - p[n - 1].t_ms);
  return { meanRps: area / dur, peakRps: peak };
}
// 정렬된 도착 시각 배열의 총 건수 · 평균 rps · 1초 창 최대 건수
function traceStats(t, n, dur) {
  let peak = 0;
  for (let i = 0, j = 0; i < n; i++) { while (t[i] - t[j] >= 1000) j++; if (i - j + 1 > peak) peak = i - j + 1; }
  return { n, meanRps: n / (dur / 1000), peak1s: peak };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 명세 4장 trace 배율. ev = traceColumns 결과. o = { N, jitter_ms, seed, exclude_src, duration_ms }
function scaleTrace(ev, o) {
  const N = o.N, J = o.jitter_ms || 0, d = o.duration_ms;
  if (!(typeof N === 'number' && isFinite(N) && N > 0)) return { ok: false, errors: ['배율 N은 0보다 큰 숫자여야 합니다.'] };
  if (!(isFinite(J) && J >= 0)) return { ok: false, errors: ['jitter_ms는 0 이상이어야 합니다.'] };
  const n = ev.n, excl = new Set(o.exclude_src || []);
  const isEx = ev.srcNames.map(s => excl.has(s));
  // 1~2. 제외 출처는 그대로 한 번. 나머지는 g 로 묶는다(없으면 이벤트 하나가 한 묶음). 묶음은 처음 등장한 순서
  const gid = new Int32Array(n).fill(-1), groups = [], gmap = new Map();
  let nEx = 0, maxG = 0;
  for (let i = 0; i < n; i++) {
    if (!isNaN(ev.g[i])) maxG = Math.max(maxG, ev.g[i]);
    if (isEx[ev.src[i]]) { nEx++; continue; }
    let q;
    if (!isNaN(ev.g[i])) { q = gmap.get(ev.g[i]); if (q === undefined) { q = groups.length; gmap.set(ev.g[i], q); groups.push([]); } }
    else { q = groups.length; groups.push([]); }
    groups[q].push(i); gid[i] = q;
  }
  const est = nEx + (n - nEx) * Math.ceil(N);
  if (est > TRACE_MAX_EVENTS) return { ok: false, errors: [`배율 결과가 약 ${est.toLocaleString()}건으로 너무 많습니다 (최대 ${TRACE_MAX_EVENTS.toLocaleString()}건). 배율을 낮추세요.`] };
  // 3~6. 묶음마다 복제 수와 복제본별 shift 를 시드 난수로 정한다 (묶음 순서대로 c → shift… 순으로 뽑는다)
  const rng = mulberry32(o.seed | 0), fl = Math.floor(N), frac = N - fl;
  const copies = new Uint32Array(groups.length), shifts = new Array(groups.length);
  let total = nEx;
  for (let q = 0; q < groups.length; q++) {
    const c = fl + (rng() < frac ? 1 : 0), sh = [];
    for (let k = 1; k < c; k++) sh.push(Math.round((rng() * 2 - 1) * J));
    copies[q] = c; shifts[q] = sh; total += c * groups[q].length;
  }
  // 원본 자리(k=0)는 원래 순서 그대로 앞에, 복제본은 뒤에 쌓은 뒤 안정 정렬 → N=1 이면 원본과 완전히 같다
  const t = new Float64Array(total), op = new Uint8Array(total), g = new Float64Array(total), src = new Uint16Array(total);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (!isEx[ev.src[i]] && copies[gid[i]] === 0) continue;
    t[w] = ev.t[i]; op[w] = ev.op[i]; g[w] = ev.g[i]; src[w] = ev.src[i]; w++;
  }
  let nextG = maxG + 1, bundles = 0;
  for (let q = 0; q < groups.length; q++) {
    bundles += copies[q];
    for (const s of shifts[q]) {
      const ng = nextG++;
      for (const i of groups[q]) {
        let x = ev.t[i] + s;
        if (x < 0 || x >= d) x = ((x % d) + d) % d;   // 7. 범위를 벗어나면 감는다
        t[w] = x; op[w] = ev.op[i]; g[w] = ng; src[w] = ev.src[i]; w++;
      }
    }
  }
  // 9. t_ms 기준 안정 정렬 (동률은 쌓은 순서)
  const ord = new Uint32Array(total);
  for (let i = 0; i < total; i++) ord[i] = i;
  ord.sort((a, b) => t[a] - t[b] || a - b);
  const T = new Float64Array(total), OP = new Uint8Array(total), G = new Float64Array(total), SRC = new Uint16Array(total);
  for (let i = 0; i < total; i++) { const k = ord[i]; T[i] = t[k]; OP[i] = op[k]; G[i] = g[k]; SRC[i] = src[k]; }
  return { ok: true, n: total, t: T, op: OP, g: G, src: SRC, srcNames: ev.srcNames, bundles, excluded: nEx };
}

// 파싱된 시나리오를 배율 옵션과 함께 SCENARIOS['file:이름'] 에 등록 (같은 이름이면 덮어쓴다)
//   → { ok: true, key, entry, before, after } | { ok: false, errors }
function registerFileScenario(sc, opts) {
  const o = Object.assign({ N: 1, jitter_ms: 30000, seed: 1, exclude_src: TRACE_EXCLUDE_DEFAULT }, opts);
  const key = 'file:' + sc.name, dur = sc.duration_ms;
  const ui = {}, fixed = {};
  for (const k in sc.params) (SCN_UI_PARAMS.includes(k) ? ui : fixed)[k] = sc.params[k];
  const explain = sc.explain.map(e => ({ t: e.t_ms / 1000, text: e.text })).sort((a, b) => a.t - b.t);
  if (!explain.length) explain.push({ t: 0, text: scnSanitize(sc.description || sc.name) });
  const entry = { name: '파일: ' + sc.name, file: sc, mode: sc.mode, spanSec: dur / 1000, params: ui, explain };
  if (sc.loop) entry.period = dur / 1000;
  let before, after;
  if (sc.mode === 'curve') {
    const tracks = Object.assign({}, sc.tracks, { rps: scaleCurvePoints(sc.tracks.rps, o.N) });
    entry.at = (t) => {
      const out = Object.assign({}, fixed), x = t * 1000;
      for (const k in tracks) { const v = curveValue(tracks[k], x, dur, sc.loop, k === 'rps'); if (v !== undefined) out[k] = v; }
      return out;
    };
    const s = curveStats(sc.tracks.rps, dur);
    before = { meanRps: s.meanRps, peak: s.peakRps };
    after = { meanRps: s.meanRps * o.N, peak: s.peakRps * o.N };
  } else {
    const r = scaleTrace(sc.events, { N: o.N, jitter_ms: o.jitter_ms, seed: o.seed, exclude_src: o.exclude_src, duration_ms: dur });
    if (!r.ok) return r;
    entry.trace = { t: r.t, op: r.op, n: r.n, dur, loop: sc.loop };
    entry.at = () => Object.assign({}, fixed);   // rps 는 반환하지 않는다 — 도착은 applyScenario 가 켜는 trace 재생이 만든다
    const b = traceStats(sc.events.t, sc.events.n, dur), a = traceStats(r.t, r.n, dur);
    // 배율 대상 묶음 수 (g 가 없는 이벤트는 하나가 한 묶음)
    const ev = sc.events, ex = new Set(o.exclude_src || []), seen = new Set();
    let singles = 0;
    for (let i = 0; i < ev.n; i++) {
      if (ex.has(ev.srcNames[ev.src[i]])) continue;
      if (isNaN(ev.g[i])) singles++; else seen.add(ev.g[i]);
    }
    before = { n: b.n, meanRps: b.meanRps, peak: b.peak1s, bundles: singles + seen.size };
    after = { n: a.n, meanRps: a.meanRps, peak: a.peak1s, bundles: r.bundles };
  }
  SCENARIOS[key] = entry;
  return { ok: true, key, entry, before, after };
}

// trace 재생 상태. origin = 재생을 시작한 엔진 시각(ms). 이벤트 도착 시각 = origin + 주기×길이 + t_ms
function startTrace(data, origin) {
  return { data, t: data.t, op: data.op, n: data.n, dur: data.dur, loop: data.loop, origin, base: origin,
           i: 0, cycle: 0, done: false, injected: 0, lastT: NaN, rec: [], recHead: 0, log: null };
}
// 최근 1초 동안 실제로 들어온 trace 요청 수
function traceRecent(tr, now) {
  if (!tr) return 0;
  let h = tr.recHead; const lo = now - 1000;
  while (h < tr.rec.length && tr.rec[h] <= lo) h++;
  return tr.rec.length - h;
}

// 헤드리스로 trace 를 재생해 엔진 주입 경로를 검사한다 (셀프 테스트용)
function replayTraceHeadless(trace, sec, opts) {
  const M = Object.assign({}, MODEL, { dt: 4, retryProb: 0 }, opts || {});
  const sim = createSim(M);
  sim.S.trace = startTrace(trace, 0); sim.S.trace.log = [];
  const steps = Math.round(sec * 1000 / M.dt);
  for (let i = 0; i < steps; i++) sim.step(M.dt);
  return { tr: sim.S.trace, history: sim.S.history, sim };
}

// 브라우저 콘솔에서 runScenarioSelfTest() — 명세 6장 기대 결과를 전부 검사한다
function runScenarioSelfTest() {
  const rows = [];
  const add = (구분, 항목, pass, 상세) => rows.push({ 구분, 항목, 결과: pass === null ? '건너뜀' : pass ? '통과' : '실패', 상세: 상세 == null ? '' : String(상세) });
  const r2 = (v) => Math.round(v * 100) / 100;
  const base = { format: SCN_FORMAT, version: 1 };

  // ── curve: spike_then_surge_3min.json 과 같은 키프레임 ──
  const CURVE = Object.assign({}, base, { mode: 'curve', name: '__selftest_curve', duration_ms: 180000, loop: false,
    tracks: { rps: [[0, 0], [40000, 100], [60000, 100], [60000, 400], [70000, 400], [70000, 100], [120000, 100], [130000, 600], [180000, 100]].map(([t_ms, v]) => ({ t_ms, v })) } });
  const pc = parseScenarioFile(JSON.stringify(CURVE));
  add('curve', '예제 파싱', pc.ok, pc.ok ? '' : pc.errors.join(' / '));
  if (pc.ok) {
    const EXP = [[20000, 50], [59999, 100], [60000, 400], [69999, 400], [70000, 100], [125000, 350], [130000, 600], [155000, 350], [180000, 0]];
    for (const N of [1, 2]) {
      const reg = registerFileScenario(pc.scenario, { N }), sc = SCENARIOS[reg.key];
      const pts = scaleCurvePoints(pc.scenario.tracks.rps, N);
      for (const [x, v] of EXP) {
        const viaAt = sc.at(x / 1000).rps, direct = curveValue(pts, x, 180000, false, true);
        add('curve', `x=${x}ms · 배율 ${N}`, r2(viaAt) === r2(v * N) && r2(direct) === r2(v * N), `기대 ${v * N} · 보간 ${r2(direct)} · at(t) ${r2(viaAt)}`);
      }
      delete SCENARIOS[reg.key];
    }
  }

  // ── trace: test_trace_small.json ──
  const SMALL = Object.assign({}, base, { mode: 'trace', name: '__selftest_trace', duration_ms: 10000, loop: false, events: [
    { t_ms: 1000, op: 'read', ep: 'GET products', g: 1, src: 'user' },
    { t_ms: 1005, op: 'read', ep: 'GET banners', g: 1, src: 'user' },
    { t_ms: 1010, op: 'read', ep: 'GET notices', g: 1, src: 'user' },
    { t_ms: 5000, op: 'write', ep: 'POST orders', g: 2, src: 'user' },
    { t_ms: 5020, op: 'read', ep: 'GET orders', g: 2, src: 'user' },
    { t_ms: 7000, op: 'write', ep: 'PATCH matches', src: 'cron' }] });
  const pt = parseScenarioFile(JSON.stringify(SMALL));
  add('trace', '예제 파싱 (6건)', pt.ok && pt.scenario.events.n === 6, pt.ok ? `${pt.scenario.events.n}건` : pt.errors.join(' / '));
  if (pt.ok) {
    const ev = pt.scenario.events;
    const run = (N, J, seed) => scaleTrace(ev, { N, jitter_ms: J, seed, exclude_src: TRACE_EXCLUDE_DEFAULT, duration_ms: 10000 });
    const dump = (r) => JSON.stringify(Array.from({ length: r.n }, (_, i) => [r.t[i], r.op[i], r.srcNames[r.src[i]], isNaN(r.g[i]) ? null : r.g[i]]));
    const countAt = (r) => { const m = {}; for (let i = 0; i < r.n; i++) m[r.t[i]] = (m[r.t[i]] || 0) + 1; return m; };
    const sortedOk = (r) => { for (let i = 1; i < r.n; i++) if (r.t[i] < r.t[i - 1]) return false; return true; };

    const a1 = run(1, 30000, 1);
    add('trace 배율', '배율 1 = 원본과 완전히 같음', dump(a1) === dump(ev), `${a1.n}건`);

    const a3 = run(3, 0, 1), c3 = countAt(a3), exp3 = { 1000: 3, 1005: 3, 1010: 3, 5000: 3, 5020: 3, 7000: 1 };
    add('trace 배율', '배율 3 · jitter 0 → 16건', a3.n === 16, `${a3.n}건`);
    add('trace 배율', '배율 3 · jitter 0 → t_ms별 개수', JSON.stringify(c3) === JSON.stringify(exp3), JSON.stringify(c3));

    const b = run(3, 2000, 1), b2 = run(3, 2000, 1);
    add('trace 배율', '배율 3 · jitter 2000 → 16건', b.n === 16, `${b.n}건`);
    const cron = []; for (let i = 0; i < b.n; i++) if (b.srcNames[b.src[i]] === 'cron') cron.push(b.t[i]);
    add('trace 배율', '크론은 정확히 1건, 시각 7000 그대로', cron.length === 1 && cron[0] === 7000, JSON.stringify(cron));
    const byG = new Map(); for (let i = 0; i < b.n; i++) if (b.srcNames[b.src[i]] === 'user') { const k = b.g[i]; if (!byG.has(k)) byG.set(k, []); byG.get(k).push(b.t[i]); }
    let g1ok = 0, g1wrap = 0, g1bad = 0;
    for (const ts of byG.values()) {
      if (ts.length !== 3) continue;
      ts.sort((x, y) => x - y);
      if (ts[2] - ts[0] > 1000) { g1wrap++; continue; }
      if (ts[1] - ts[0] === 5 && ts[2] - ts[1] === 5) g1ok++; else g1bad++;
    }
    add('trace 배율', 'g1 복제본 내부 간격 5ms·5ms 유지', g1bad === 0 && g1ok + g1wrap === 3, `유지 ${g1ok} · 감기로 경계 넘음 ${g1wrap} · 깨짐 ${g1bad}`);
    add('trace 배율', '같은 시드 두 번 → 같은 결과', dump(b) === dump(b2), '');
    add('trace 배율', '결과가 t_ms 오름차순', sortedOk(b), '');

    const h = run(0.5, 30000, 1), h2 = run(0.5, 30000, 1);
    add('trace 배율', '배율 0.5 → 1·3·4·6건 중 하나', [1, 3, 4, 6].includes(h.n), `${h.n}건`);
    add('trace 배율', '배율 0.5 · 같은 시드 → 같은 결과', dump(h) === dump(h2), '');
    const seen = new Set(); let allIn = true;
    for (let s = 1; s <= 40; s++) { const x = run(0.5, 30000, s).n; seen.add(x); if (![1, 3, 4, 6].includes(x)) allIn = false; }
    add('trace 배율', '배율 0.5 · 시드 1~40 모두 허용값', allIn, `나온 값 ${[...seen].sort((p, q) => p - q).join(', ')}`);

    // 엔진 재생: 도착 시각이 프레임·틱(4ms)에 뭉개지지 않고 t_ms 그대로 들어가는가
    const data = { t: ev.t, op: ev.op, n: ev.n, dur: 10000, loop: false };
    const rp = replayTraceHeadless(data, 12);
    add('trace 재생', '6건 도착', rp.tr.injected === 6, `${rp.tr.injected}건`);
    add('trace 재생', '도착 시각 = t_ms 그대로', JSON.stringify(rp.tr.log) === '[1000,1005,1010,5000,5020,7000]', JSON.stringify(rp.tr.log));
    add('trace 재생', 'loop=false → 끝난 뒤 유입 0', rp.tr.done && rp.tr.injected === 6, '');
    const rl = replayTraceHeadless(Object.assign({}, data, { loop: true }), 24.5);
    add('trace 재생', 'loop=true → 24.5초에 15건 (6+6+3)', rl.tr.injected === 15, `${rl.tr.injected}건`);
    const sumCls = (hist) => { const s = [0, 0, 0]; for (const x of hist) (x.cls || []).forEach((c, i) => { if (i < 3) s[i] += c.done; }); return s; };
    const mixOnRun = replayTraceHeadless(data, 12, { mixOn: true });
    add('trace 재생', '작업 구성 켬 → 유형 = op (조회 4 · 검색 0 · 쓰기 2)', sumCls(mixOnRun.history).join(',') === '4,0,2', sumCls(mixOnRun.history).join(','));
    const mixOffRun = replayTraceHeadless(data, 12, { mixOn: false });
    const outOff = mixOffRun.history.reduce((s, x) => s + x.out, 0);
    add('trace 재생', '작업 구성 끔 → 기본 시간 (유형 집계 0, 완료 6)', sumCls(mixOffRun.history).join(',') === '0,0,0' && outOff === 6, `유형 ${sumCls(mixOffRun.history).join(',')} · 완료 ${outOff}`);
  }

  // ── 잘못된 입력 ──
  const tr = (events, extra) => JSON.stringify(Object.assign({}, base, { mode: 'trace', name: 'x', duration_ms: 10000, events }, extra || {}));
  const cv = (tracks, extra) => JSON.stringify(Object.assign({}, base, { mode: 'curve', name: 'x', duration_ms: 10000, tracks }, extra || {}));
  const BAD = [
    ['curve t_ms 역순', cv({ rps: [{ t_ms: 1000, v: 1 }, { t_ms: 500, v: 2 }] }), '역순'],
    ['curve 같은 t_ms 3개', cv({ rps: [{ t_ms: 0, v: 0 }, { t_ms: 1000, v: 1 }, { t_ms: 1000, v: 2 }, { t_ms: 1000, v: 3 }] }), '3개 이상'],
    ['curve 없는 트랙 키', cv({ rps: [{ t_ms: 0, v: 1 }], nopeKey: [{ t_ms: 0, v: 1 }] }), 'nopeKey'],
    ['curve tracks.rps 누락', cv({ dbScale: [{ t_ms: 0, v: 1 }] }), 'tracks.rps'],
    ['curve 마지막 t_ms > duration', cv({ rps: [{ t_ms: 0, v: 1 }, { t_ms: 20000, v: 1 }] }), 'duration_ms'],
    ['trace op 오타', tr([{ t_ms: 0, op: 'raed' }]), '"raed"'],
    ['trace t 필드 사용', tr([{ t: 1000, op: 'read' }]), '`t_ms`(밀리초)를 사용하세요'],
    ['trace t_ms 범위 (= duration)', tr([{ t_ms: 10000, op: 'read' }]), '미만'],
    ['trace events 빈 배열', tr([]), 'events가 비어'],
    ['params 없는 키', tr([{ t_ms: 0, op: 'read' }], { params: { fooBar: 1 } }), 'fooBar'],
    ['format 누락', JSON.stringify({ version: 1, mode: 'trace', name: 'x', duration_ms: 1, events: [{ t_ms: 0, op: 'read' }] }), 'format'],
    ['duration 단위 없음', JSON.stringify(Object.assign({}, base, { mode: 'trace', name: 'x', duration: 10, events: [{ t_ms: 0, op: 'read' }] })), '`duration_ms`(밀리초)'],
    ['JSON 파싱 실패', '{ "format": ', 'JSON 파싱 실패'],
    ['빈 파일', '   ', '빈 파일'],
  ];
  for (const [label, text, needle] of BAD) {
    const res = parseScenarioFile(text);
    add('검증', label, !res.ok && res.errors.some(e => e.includes(needle)), res.ok ? '오류 없이 통과됨' : res.errors[0]);
  }
  const uns = parseScenarioFile(tr([{ t_ms: 500, op: 'read' }, { t_ms: 100, op: 'write' }]));
  add('검증', '정렬 안 된 events → 정렬 + 경고', uns.ok && uns.warnings.length === 1 && uns.scenario.events.t[0] === 100, uns.ok ? uns.warnings[0] : uns.errors[0]);

  // ── vote_site_2026-09-14.json (화면에서 불러와 둔 경우에만) ──
  const vote = Object.values(SCENARIOS).find(s => s.file && s.file.mode === 'trace' && s.file.source && s.file.source.type === 'supabase' && s.file.events.n === 886);
  if (!vote) add('vote_site', '불러온 파일 없음', null, '화면에서 scenarios/vote_site_2026-09-14.json 을 불러온 뒤 다시 실행');
  else {
    const ev = vote.file.events;
    add('vote_site', '886건', ev.n === 886, `${ev.n}건`);
    add('vote_site', '묶음 211개', ev.groupCount === 211, `${ev.groupCount}개`);
    add('vote_site', '길이 686951ms', vote.file.duration_ms === 686951, `${vote.file.duration_ms}ms`);
    add('vote_site', '조회 811 · 쓰기 75', ev.opCount[0] === 811 && ev.opCount[2] === 75, `조회 ${ev.opCount[0]} · 검색 ${ev.opCount[1]} · 쓰기 ${ev.opCount[2]}`);
    const one = scaleTrace(ev, { N: 1, jitter_ms: 30000, seed: 1, exclude_src: TRACE_EXCLUDE_DEFAULT, duration_ms: 686951 });
    const rv = replayTraceHeadless({ t: one.t, op: one.op, n: one.n, dur: 686951, loop: false }, 690);
    add('vote_site', '배율 1 재생 → 약 687초 동안 886건', rv.tr.injected === 886 && rv.tr.done && rv.tr.lastT <= 686951,
      `${rv.tr.injected}건 · 마지막 도착 ${(rv.tr.lastT / 1000).toFixed(2)}초`);
  }

  console.table(rows);
  const s = { 통과: rows.filter(r => r.결과 === '통과').length, 실패: rows.filter(r => r.결과 === '실패').length, 건너뜀: rows.filter(r => r.결과 === '건너뜀').length };
  console.log(`[runScenarioSelfTest] 통과 ${s.통과} · 실패 ${s.실패} · 건너뜀 ${s.건너뜀}`);
  return s;
}


/* =====================================================================
 * 5. 렌더링 — 인스턴스 한 대의 단면도 + 인스턴스 실시간 비교 차트
 * ===================================================================== */
const $ = (id) => document.getElementById(id);
const stage = $('stage'), sctx = stage.getContext('2d');
const cmpc = $('cmp'), cctx = cmpc.getContext('2d');
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = {};
(function () { for (const k of ['idle','queued','busy','waitconn','db','done','timeout','retry']) COL[k] = css('--c-' + k);
  for (const k of ['in','out','rej','to','retry','wasted','p50','p95','sim','real']) COL['s_' + k] = css('--s-' + k);
  for (const k of ['ink','ink-2','muted','grid','axis','surface','gray','gray-l','blue-l']) COL[k.replace('-2', '2').replace('-l', 'L')] = css('--' + k); })();

function fitCanvas(c) {
  const r = c.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  return { w: r.width, h: r.height, dpr };
}
function roundRect(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
// ── B 과부하 진단 ──────────────────────────────────────────────────────
//  자원을 칸칸이 따로 보여주는 대신, 요청 한 줄기가 지나가는 길을 그대로 그린다.
//
//   가로 본류        그 구간을 실제로 통과한 초당 건수. 띠가 얇아지는 곳이 막히는 곳이다.
//   노드            길목의 자원. 막대 채움이 이용률, 사이에 뜬 숫자가 그 앞에 선 대기 건수.
//   아래로 빠지는 띠  흐름 밖으로 나간 요청 — 큐 포화로 거절된 것, 끝냈지만 버려진 것(낭비).
//   점선 표시        클라이언트가 포기한 순간. 본류는 줄지 않는다. 서버는 끝까지 처리하고,
//                   그렇게 끝낸 것이 오른쪽 끝에서 「낭비」로 떨어진다.
//   칸 안 추세선     그 자원의 최근 30초 이용률. 세로축은 0~100% 고정이라 칸끼리 바로 견준다.
const INK = { line: '#e3e8ef', off: '#dbe2ea', lab: '#6b7a8c', ink: '#16202c', hot: '#b0201a', warn: '#a16207', accent: '#1f6feb' };
const SEG = { q: '#cbd5e1', wc: '#94a3b8', db: '#1f6feb', cpu: '#64748b' };
const EMPTY_H = { in: 0, out: 0, rej: 0, to: 0, retry: 0, wasted: 0, p50: 0, p95: 0, thU: 0, coU: 0, cpU: 0,
  q: 0, wc: 0, cw: 0, brk: { q: 0, wc: 0, db: 0, cpu: 0 }, pass: { thread: 0, conn: 0, cpu: 0 }, lost: { q: 0, wc: 0, run: 0 } };

function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function fmt(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString(); }
function fmtMs(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms'; }
const FONT = (s) => s + ' "Noto Sans KR", system-ui, sans-serif';

function txt(s, x, y, align, color, font, baseline) {
  sctx.textAlign = align || 'left'; sctx.textBaseline = baseline || 'middle';
  sctx.fillStyle = color || INK.lab; sctx.font = font || FONT('10px');
  sctx.fillText(s, x, y);
}
// 두께가 곧 rps 인 흐름 띠. (x0,c0) 에서 (x1,c1) 로 흐른다 — c 가 다르면 아래로 새는 가지가 된다
function flowBand(x0, c0, t0, x1, c1, t1, col, alpha) {
  if (t0 <= 0 && t1 <= 0) return;
  const a0 = Math.max(t0, 1) / 2, a1 = Math.max(t1, 1) / 2, mx = (x0 + x1) / 2;
  sctx.beginPath();
  sctx.moveTo(x0, c0 - a0);
  sctx.bezierCurveTo(mx, c0 - a0, mx, c1 - a1, x1, c1 - a1);
  sctx.lineTo(x1, c1 + a1);
  sctx.bezierCurveTo(mx, c1 + a1, mx, c0 + a0, x0, c0 + a0);
  sctx.closePath();
  sctx.globalAlpha = alpha == null ? .9 : alpha; sctx.fillStyle = col; sctx.fill(); sctx.globalAlpha = 1;
}
// 자원 칸 안에 들어가는 최근 추세 — 지금 값만으로는 "오르는 중인지"를 못 본다.
// 세로축은 0~100% 고정이라 칸끼리 바로 견줄 수 있고, ref(버스터블 기준선)는 점선으로 깐다.
function microSpark(x, y, w, h, vals, col, ref) {
  sctx.fillStyle = '#f4f7fa'; sctx.fillRect(x, y, w, h);
  if (vals && vals.length > 1) {
    const px = (i) => x + i / (vals.length - 1) * w, py = (v) => y + h - Math.max(0, Math.min(1, v)) * h;
    sctx.beginPath(); sctx.moveTo(px(0), y + h);
    vals.forEach((v, i) => sctx.lineTo(px(i), py(v)));
    sctx.lineTo(px(vals.length - 1), y + h); sctx.closePath();
    sctx.globalAlpha = .18; sctx.fillStyle = col; sctx.fill(); sctx.globalAlpha = 1;
    sctx.beginPath(); vals.forEach((v, i) => i ? sctx.lineTo(px(i), py(v)) : sctx.moveTo(px(i), py(v)));
    sctx.strokeStyle = col; sctx.lineWidth = 1.2; sctx.stroke();
  }
  if (ref != null && ref > 0 && ref < 1) {
    const ry = y + h - ref * h;
    sctx.setLineDash([2, 2]); sctx.strokeStyle = INK.warn; sctx.lineWidth = 1;
    sctx.beginPath(); sctx.moveTo(x, ry); sctx.lineTo(x + w, ry); sctx.stroke(); sctx.setLineDash([]);
  }
}
// 길목의 자원 한 칸 — 채움이 곧 이용률, 아래 추세선이 곧 방향
function flowNode(x, y, nw, nh, o) {
  sctx.fillStyle = '#fff'; roundRect(sctx, x, y, nw, nh, 4); sctx.fill();
  sctx.strokeStyle = o.util > .9 ? '#edc8c6' : COL.grid; sctx.lineWidth = 1; sctx.stroke();
  const bx = x + 7, bw = nw - 14;
  // 1줄: 제목 + 직전 5초 대비 변화
  sctx.fillStyle = o.seg; sctx.fillRect(bx, y + 5, 6, 6);
  txt(o.title, bx + 10, y + 8.5, 'left', INK.ink, FONT('700 10px'));
  if (Math.abs(o.delta) >= .02)
    txt(`${o.delta > 0 ? '▲' : '▼'}${Math.round(Math.abs(o.delta) * 100)}`, x + nw - 7, y + 8.5, 'right',
      o.delta > 0 ? INK.hot : INK.lab, FONT('700 9px'));
  // 2줄: 용량 막대 + 이용률
  const barW = bw - 34;
  sctx.fillStyle = INK.off; sctx.fillRect(bx, y + 16, barW, 7);
  sctx.fillStyle = o.tone; sctx.fillRect(bx, y + 16, Math.max(0, Math.min(1, o.util)) * barW, 7);
  txt(`${Math.round(o.util * 100)}%`, x + nw - 7, y + 20, 'right', o.tone, FONT('700 10.5px'));
  // 3줄: 최근 추세
  microSpark(bx, y + 27, bw, nh - 27 - 15, o.series, o.tone, o.ref);
  // 4줄: 슬롯 수 · 이 자원을 못 잡아 앞에 선 건수 (체류 시간은 아래 시간 축이 번호로 받는다)
  txt(`${fmt(o.used)}/${fmt(o.cap)}`, bx, y + nh - 7, 'left', INK.ink, FONT('700 9.5px'));
  if (o.wait) txt(`대기 ${fmt(o.wait)}`, x + nw - 7, y + nh - 7, 'right', INK.warn, FONT('700 9.5px'));
  else if (o.ref != null) txt(`지속 ${Math.round(o.ref * 100)}%`, x + nw - 7, y + nh - 7, 'right', INK.warn, FONT('9px'));
}

/* ── 5a. 요청 흐름도 — 선택한 인스턴스 한 대를 요청이 지나가는 길로 본다 ──────
   한 칸 안에 「지금 값 · 최근 추세 · 방향 · 대기」를 넣는다. 추세 그래프가 본문이므로 칸을 크게 쓴다. */
function drawStage(sim) {
  const S = sim.S, M = S.M;
  const { w, h, dpr } = fitCanvas(stage);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, w, h);
  const hh = S.history[S.history.length - 1] || EMPTY_H;
  const b = hh.brk || EMPTY_H.brk, pass = hh.pass || EMPTY_H.pass, lost = hh.lost || EMPTY_H.lost;
  const th = theory(M);
  let qn = 0; for (const r of S.reqs) if (r.state === 'queued') qn++;

  const pad = 8, titleH = 15;
  const top = pad + titleH, bot = h - pad;
  const area = bot - top;
  const nh = Math.max(64, Math.min(136, area * 0.60));      // 칸을 크게 — 안의 추세 그래프가 이 화면의 본문이다
  const cy = top + Math.max(nh / 2, area * 0.38);
  const sinkY = bot - 14;
  const nw = Math.max(92, Math.min(136, (w - pad * 2) * 0.175));
  const gap = Math.max(20, (w - pad * 2 - nw * 4 - 46) / 5);
  const X = (i) => pad + gap + i * (nw + gap);
  const xEnd = w - pad - 44;
  const hot = (u) => u > .9 ? INK.hot : u > .75 ? INK.warn : INK.accent;

  // 흐름 → 띠 두께. 한 초 동안 그 구간을 지난 건수를 그대로 굵기로 쓴다
  const maxF = Math.max(1, hh.in, pass.thread, pass.conn, pass.cpu, hh.out + hh.wasted);
  const maxT = Math.min(46, nh * 0.34);
  const T = (v) => v <= 0 ? 0 : Math.max(1.6, v / maxF * maxT);
  // 칸 안 추세선 — 최근 30초 이용률, 직전 5초 대비 변화
  const Hs = S.history.slice(-30);
  const ser = (f) => Hs.map(d => Math.max(0, Math.min(1, f(d))));
  const dlt = (a) => a.length >= 6 ? a[a.length - 1] - a[a.length - 6] : 0;

  /* ── 제목 줄 ── */
  txt(`요청 흐름${M.label ? ' · ' + M.label : ''}`, pad, pad + 6, 'left', INK.ink, FONT('700 11px'));
  const BN = { cpu: 'vCPU', db: 'DB 커넥션', thread: '스레드/큐' };
  txt(`유입 ${fmt(hh.in)}/s${hh.retry ? ` (재시도 ${fmt(hh.retry)})` : ''}  ·  완료 ${fmt(hh.out)}/s  ·  실패 ${fmt(hh.rej + hh.to)}/s`
    + `  ·  p95 ${fmtMs(hh.p95)}  ·  병목 ${BN[th.bottle]}  ·  ρ ${(hh.in / Math.max(1, th.cap)).toFixed(2)}`,
    w - pad, pad + 6, 'right', INK.lab, FONT('10px'));

  /* ── 본류 (노드 뒤에 깔린다) ── */
  const MAIN = COL.blueL || '#b6d1fa';
  flowBand(pad, cy, T(hh.in), X(0), cy, T(hh.in), MAIN, .8);
  flowBand(X(0) + nw, cy, T(pass.thread), X(1), cy, T(pass.thread), MAIN, .8);
  flowBand(X(1) + nw, cy, T(pass.conn), X(2), cy, T(pass.conn), MAIN, .8);
  flowBand(X(2) + nw, cy, T(pass.cpu), X(3), cy, T(pass.cpu), MAIN, .8);

  /* ── 나가는 가지 ── */
  // 거절: 큐가 꽉 차서 아예 들어오지 못한 것 (503). 본류에서 그만큼 빠진다
  if (hh.rej > 0) {
    const t = T(hh.rej), sx = X(0) - Math.min(30, gap * 0.5);
    flowBand(sx, cy + T(hh.in) / 2, t, X(0) + nw * 0.55, sinkY, t, INK.hot, .85);
    txt(`거절 ${fmt(hh.rej)}/s`, X(0) + nw * 0.55 + t / 2 + 5, sinkY, 'left', INK.hot, FONT('700 9.5px'));
  }
  // 완료 / 낭비: 끝까지 간 요청이 마지막에 갈라진다
  const tDone = T(hh.out), tWaste = T(hh.wasted), tSum = tDone + tWaste;
  if (tDone > 0) flowBand(X(3) + nw, cy - tSum / 2 + tDone / 2, tDone, xEnd, cy - tSum / 2 + tDone / 2, tDone, INK.accent, .9);
  txt(`완료 ${fmt(hh.out)}/s`, xEnd + 5, cy - tSum / 2 + tDone / 2, 'left', INK.accent, FONT('700 9.5px'));
  if (hh.wasted > 0) {
    flowBand(X(3) + nw, cy + tSum / 2 - tWaste / 2, tWaste, xEnd - 14, sinkY, tWaste, INK.warn, .85);
    txt(`낭비 ${fmt(hh.wasted)}/s`, xEnd - 14 + tWaste / 2 + 5, sinkY, 'left', INK.warn, FONT('700 9.5px'));
  }

  /* ── 노드 네 개 ── */
  const sQ = ser(d => d.q / Math.max(1, M.queueCap)), sTh = ser(d => d.thU), sDb = ser(d => d.coU), sCp = ser(d => d.cpU || 0);
  const N = [
    { seg: SEG.q,   title: '1 대기 큐',   used: qn,            cap: M.queueCap,   util: qn / Math.max(1, M.queueCap), series: sQ,  delta: dlt(sQ) },
    { seg: SEG.wc,  title: '2 스레드',    used: S.usedThreads, cap: M.threads,    util: hh.thU,                        series: sTh, delta: dlt(sTh) },
    { seg: SEG.db,  title: '3 DB 커넥션', used: S.usedConns,   cap: M.conns,      util: hh.coU,                        series: sDb, delta: dlt(sDb), wait: hh.wc },
    { seg: SEG.cpu, title: '4 vCPU',      used: S.usedCores,   cap: M.cores || 0, util: hh.cpU || 0,                   series: sCp, delta: dlt(sCp), wait: hh.cw,
      ref: M.baseline != null && M.baseline < 1 ? M.baseline : null },   // 버스터블 지속 가능선
  ];
  N.forEach((o, i) => { o.tone = hot(o.util); flowNode(X(i), cy - nh / 2, nw, nh, o); });

  /* ── 포기(타임아웃): 본류는 줄지 않는다. 표시만 하고, 결과는 오른쪽 끝 「낭비」로 나온다 ── */
  sctx.setLineDash([3, 3]); sctx.lineWidth = 1.2; sctx.strokeStyle = INK.warn;
  [lost.q, lost.wc, lost.run].forEach((n, i) => {
    if (!n) return;
    const x = X(i) + nw * 0.28, y0 = cy + nh / 2 + 3, y1 = Math.min(y0 + 14, sinkY - 12);
    sctx.beginPath(); sctx.moveTo(x, y0); sctx.lineTo(x, y1); sctx.stroke();
    txt(`포기 ${fmt(n)}/s`, x + 4, y1, 'left', INK.warn, FONT('700 9.5px'));
  });
  sctx.setLineDash([]);
  // 재시도: 실패한 쪽이 다시 유입으로 돌아온다 (이 되먹임이 재시도 폭풍을 스스로 유지시킨다)
  if (hh.retry > 0) {
    const ry = bot - 2;
    sctx.setLineDash([4, 3]); sctx.strokeStyle = INK.warn; sctx.lineWidth = 1.2;
    sctx.beginPath(); sctx.moveTo(xEnd - 14, ry); sctx.lineTo(pad + 6, ry); sctx.stroke();
    sctx.setLineDash([]);
    sctx.beginPath(); sctx.moveTo(pad + 6, ry); sctx.lineTo(pad + 12, ry - 3.5); sctx.lineTo(pad + 12, ry + 3.5); sctx.closePath();
    sctx.fillStyle = INK.warn; sctx.fill();
    txt(`재시도 ${fmt(hh.retry)}/s 가 유입으로 되돌아온다`, (pad + xEnd) / 2, ry - 6, 'center', INK.warn, FONT('700 9.5px'));
  }

}

/* ── 5b. EC2 인스턴스 실시간 비교 ─────────────────────────────────────────
   같은 트래픽·같은 서버 설정을 인스턴스마다 한 벌씩 동시에 돌리고, 부하 테스트처럼
   1초마다 세 지표를 나란히 그린다. 인스턴스마다 다른 것은 vCPU 할당과 메모리(=스레드 상한)뿐이므로,
   선이 갈라지는 순간이 곧 "CPU 할당이 부족해지는 순간"이다.
     ① CPU 이용률 — 점선은 버스터블(t계열)이 지속 가능한 기준선
     ② p95 응답   — 점선은 목표 p95
     ③ 처리량     — 회색 점선은 유입(공통), 색선은 인스턴스별 완료
   opts: { win, p95, marks:[{t,text}] }                                       */
const CMPV = { hoverX: null };
function drawCompare(list, opts) {
  const { w, h, dpr } = fitCanvas(cmpc);
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0); cctx.clearRect(0, 0, w, h);
  const N = opts.win || 60;
  const padL = 40, padR = 10, padT = 40, padB = 14, gapY = 18;
  const hists = list.map(it => it.sim.S.history);
  const anyH = hists.find(H => H.length) || [];
  if (!anyH.length) {
    cctx.fillStyle = COL.muted; cctx.textAlign = 'center'; cctx.textBaseline = 'middle';
    cctx.font = '11px "Noto Sans KR", system-ui, sans-serif';
    cctx.fillText(list.length ? '부하 테스트 시작 중…' : '왼쪽에서 비교할 인스턴스를 고르세요', w / 2, h / 2);
    return;
  }
  const tEnd = anyH[anyH.length - 1].t, t0 = tEnd - N;
  const X = (t) => padL + (t - t0) / N * (w - padL - padR);
  const rows = [
    { title: 'CPU 이용률', unit: '%', fixedMax: 100, get: (d) => (d.cpU || 0) * 100, baseline: true },
    { title: 'p95 응답', unit: 'ms', get: (d) => d.p95, ref: opts.p95, refName: '목표' },
    { title: '처리량', unit: '/s', get: (d) => d.out, showIn: true },
  ];
  const ph = (h - padT - padB - gapY * (rows.length - 1)) / rows.length;

  // ── 색은 한 번에 하나만 ────────────────────────────────────────────────
  //  선이 전부 제 색을 주장하면 "지금 무엇을 보고 있는지"가 흐려진다. 그래서 기본은 검정이고,
  //  고른 인스턴스(위 흐름도에 띄운 것)만 색으로 앞에 나온다. 나머지는 옅은 검정으로 뒤에 깔린다.
  const CK = (it) => it.sel ? it.color : INK.ink;          // 선·점·기준선 색
  const CA = (it) => it.sel ? 1 : 0.45;                    // 안 고른 것은 옅은 검정으로 뒤에
  const zOrder = list.map((it, i) => ({ it, i })).sort((a, b) => (a.it.sel ? 1 : 0) - (b.it.sel ? 1 : 0));

  // 범례 — 선택된 인스턴스(단면도에 뜬 것)는 색 + 굵게. 제목과 겹치지 않게 오른쪽 정렬.
  cctx.textBaseline = 'middle'; cctx.textAlign = 'left';
  const lab = list.map(it => `${it.type} (${it.vcpu}vCPU)`);
  cctx.font = '10.5px "Noto Sans KR", system-ui, sans-serif';
  const lw = lab.map(t => 12 + cctx.measureText(t).width + 14);
  let lx = Math.max(padL + 150, w - padR - lw.reduce((a, b) => a + b, 0) + 14);
  list.forEach((it, i) => {
    cctx.globalAlpha = CA(it); cctx.fillStyle = CK(it); cctx.fillRect(lx, 7, 9, 9); cctx.globalAlpha = 1;
    cctx.fillStyle = it.sel ? COL.ink : COL.muted;
    cctx.font = `${it.sel ? 700 : 400} 10.5px "Noto Sans KR", system-ui, sans-serif`;
    cctx.fillText(lab[i], lx + 12, 12);
    lx += lw[i];
  });

  rows.forEach((p, ri) => {
    const py0 = padT + ri * (ph + gapY);
    let max = p.fixedMax || 10;
    if (!p.fixedMax) {
      for (const H of hists) for (const d of H) if (d.t >= t0) max = Math.max(max, p.get(d));
      if (p.showIn) for (const d of anyH) if (d.t >= t0) max = Math.max(max, d.in);
      if (p.ref) max = Math.max(max, p.ref * 1.2);
      max = niceMax(max);
    }
    const Y = (v) => py0 + ph - Math.min(v, max) / max * ph;
    // 격자 + y 라벨
    cctx.strokeStyle = COL.grid; cctx.lineWidth = 1; cctx.fillStyle = COL.muted;
    cctx.textAlign = 'right'; cctx.textBaseline = 'middle'; cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
    for (let i = 0; i <= 2; i++) { const v = max * i / 2, yy = Y(v);
      cctx.beginPath(); cctx.moveTo(padL, yy); cctx.lineTo(w - padR, yy); cctx.stroke();
      cctx.fillText(fmt(v), padL - 4, yy); }
    // 소제목 — 패널 위쪽 여백에
    cctx.textAlign = 'left'; cctx.textBaseline = 'bottom'; cctx.fillStyle = COL.ink;
    cctx.font = '700 10px "Noto Sans KR", system-ui, sans-serif';
    cctx.fillText(`${p.title} (${p.unit})`, padL, py0 - 3);
    // 기준선 (목표 p95)
    if (p.ref && p.ref <= max) {
      cctx.strokeStyle = COL.s_rej; cctx.setLineDash([3, 3]); cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(padL, Y(p.ref)); cctx.lineTo(w - padR, Y(p.ref)); cctx.stroke(); cctx.setLineDash([]);
      cctx.fillStyle = COL.s_rej; cctx.textAlign = 'right'; cctx.textBaseline = 'bottom';
      cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
      cctx.fillText(`${p.refName} ${p.ref}`, w - padR - 2, Y(p.ref) - 2);
    }
    // 버스터블 지속 기준선 — t계열은 이 선 위로 오래 있을 수 없다 (크레딧 소진 후 스로틀)
    if (p.baseline) for (const it of list) {
      if (!(it.baseline > 0 && it.baseline < 1)) continue;
      const yy = Y(it.baseline * 100);
      cctx.strokeStyle = CK(it); cctx.globalAlpha = it.sel ? .55 : .28; cctx.setLineDash([2, 4]); cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(padL, yy); cctx.lineTo(w - padR, yy); cctx.stroke();
      cctx.setLineDash([]);
      cctx.fillStyle = CK(it); cctx.textAlign = 'left'; cctx.textBaseline = 'bottom';
      cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
      cctx.fillText(`${it.type} 지속 ${Math.round(it.baseline * 100)}%`, padL + 3, yy - 2);
      cctx.globalAlpha = 1;
    }
    // 유입 (공통) — 회색 점선
    if (p.showIn) {
      cctx.strokeStyle = COL.s_in; cctx.setLineDash([4, 3]); cctx.lineWidth = 1.5; cctx.beginPath();
      let first = true;
      for (const d of anyH) { if (d.t < t0) continue; const x = X(d.t), yy = Y(d.in); first ? cctx.moveTo(x, yy) : cctx.lineTo(x, yy); first = false; }
      cctx.stroke(); cctx.setLineDash([]);
    }
    // 인스턴스별 실선 — 안 고른 것(검정)을 먼저 깔고, 고른 것(색)을 맨 위에 그린다
    for (const { it, i } of zOrder) {
      const H = hists[i]; if (!H.length) continue;
      cctx.strokeStyle = CK(it); cctx.globalAlpha = CA(it);
      cctx.lineWidth = it.sel ? 2.4 : 1.3; cctx.lineJoin = 'round'; cctx.beginPath();
      let first = true;
      for (const d of H) { if (d.t < t0) continue; const x = X(d.t), yy = Y(p.get(d)); first ? cctx.moveTo(x, yy) : cctx.lineTo(x, yy); first = false; }
      cctx.stroke(); cctx.globalAlpha = 1;
    }
    p.Y = Y; p.y0 = py0;
  });

  // 시나리오 단계 마커 (언제 무슨 일이 일어났나)
  if (opts.marks) for (const m of opts.marks) {
    if (m.t < t0 || m.t > tEnd) continue;
    const x = X(m.t);
    cctx.strokeStyle = COL.axis; cctx.setLineDash([2, 4]); cctx.lineWidth = 1;
    cctx.beginPath(); cctx.moveTo(x, padT); cctx.lineTo(x, h - padB); cctx.stroke(); cctx.setLineDash([]);
    cctx.fillStyle = COL.muted; cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
    cctx.textAlign = 'left'; cctx.textBaseline = 'bottom'; cctx.fillText(m.text, x + 2, h - padB - 1);
  }
  // x축
  cctx.fillStyle = COL.muted; cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
  cctx.textAlign = 'center'; cctx.textBaseline = 'top';
  const step = N <= 60 ? 10 : N <= 120 ? 20 : 60;
  for (let s = 0; s <= N; s += step) { const t = Math.floor(t0 / step) * step + s; if (t < 0 || t > tEnd) continue; cctx.fillText(`${Math.round(t)}s`, X(t), h - padB + 2); }

  // 크로스헤어 + 툴팁 — 그 시점의 인스턴스별 값을 한 번에
  const tip = $('cmpTip');
  if (CMPV.hoverX != null && CMPV.hoverX > padL) {
    const tt = t0 + (CMPV.hoverX - padL) / (w - padL - padR) * N;
    const at = (H) => H.length ? H.reduce((b, d) => Math.abs(d.t - tt) < Math.abs(b.t - tt) ? d : b) : null;
    const ref = at(anyH), x = X(ref.t);
    cctx.strokeStyle = COL.ink2; cctx.setLineDash([2, 3]); cctx.lineWidth = 1;
    cctx.beginPath(); cctx.moveTo(x, padT - 6); cctx.lineTo(x, h - padB); cctx.stroke(); cctx.setLineDash([]);
    for (const p of rows) for (const { it, i } of zOrder) { const d = at(hists[i]); if (!d) continue;
      cctx.globalAlpha = it.sel ? 1 : .55;
      cctx.fillStyle = CK(it); cctx.beginPath(); cctx.arc(x, p.Y(p.get(d)), it.sel ? 3.5 : 2.5, 0, 7); cctx.fill();
      cctx.strokeStyle = '#fff'; cctx.lineWidth = 1.2; cctx.stroke(); cctx.globalAlpha = 1; }
    tip.style.display = 'block';
    // 툴팁은 어차피 이름을 쓰므로, 여기서는 색이 아니라 "지금 고른 것"만 표시한다
    tip.innerHTML = `<div class="r"><b>t = ${ref.t.toFixed(0)}s</b><span>유입 ${ref.in}/s</span></div>`
      + list.map((it, i) => { const d = at(hists[i]); return d
        ? `<div class="r"><span><i style="background:${CK(it)};opacity:${it.sel ? 1 : .35}"></i>`
          + `<b${it.sel ? '' : ' style="font-weight:400"'}>${it.type}</b></span>`
          + `<span>CPU ${Math.round((d.cpU || 0) * 100)}% · p95 ${fmt(d.p95)}ms · 완료 ${d.out}/s · 실패 ${d.rej + d.to}/s</span></div>` : ''; }).join('');
    tip.style.left = Math.min(x + 12, w - tip.offsetWidth - 8) + 'px'; tip.style.top = '6px';
  } else tip.style.display = 'none';
}
cmpc.addEventListener('mousemove', (e) => { CMPV.hoverX = e.offsetX; });
cmpc.addEventListener('mouseleave', () => { CMPV.hoverX = null; });

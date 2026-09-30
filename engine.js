/* engine.js — 파트 1 · 진단
   구획 1~5: 모델 · 시뮬레이션 엔진 · 이론값/병목 판정 · 시나리오 · 렌더링
   밖으로 내보내는 계약: runHeadless(cfg, sec, warmup) · theory(cfg) · MODEL/BASE · SCENARIOS
   advisor.js 는 이것만 쓴다. 반환 모양만 지키면 엔진 내부는 자유롭게 바꿔도 된다. */
'use strict';
/* =====================================================================
 * 1. MODEL — 모델 파라미터 (UI에 바인딩되는 메인 인스턴스용)
 * ===================================================================== */
const MODEL = {
  cpuTimeMs: 5, dbTimeMs: 30, queueCap: 100, timeoutMs: 3000, threads: 50, conns: 10, rps: 100,
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
 * 2. createSim() — 시뮬레이션 엔진 (다중 인스턴스 가능: 메인 화면 + 추천 탐색 + 검증 스윕)
 *   요청 생애: spawn → queued → waitconn → db → cpu → done
 *                       ↘ rejected(큐 포화)   ↘ timeout(대기 초과) → (확률) 재시도 유입
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
    M, t: 0, reqs: [], fx: [], retryQ: [], nextId: 1, usedThreads: 0, usedConns: 0, lastSec: 0, history: [],
    win: null, onSecond: opts.onSecond || null,
    trace: null,   // 파일 trace 재생 상태 (startTrace). 켜져 있으면 포아송 도착 대신 이벤트 시각에 요청을 넣는다
  };
  const nCls = (M.mix && M.mix.length) || 0;
  const newWin = () => ({ done: 0, rej: 0, to: 0, retry: 0, wasted: 0, dbSum: 0, dbN: 0, lat: [],
    brk: { q: 0, wc: 0, db: 0, cpu: 0 },   // 완료 요청의 단계별 체류시간 합 (ms) — 지연 분해용
    cls: Array.from({ length: nCls }, () => ({ done: 0, lat: [] })),   // 작업 유형별 완료·지연
    thBusy: 0, coBusy: 0, ticks: 0, waitSum: 0, spawned: 0 });
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
             tq: 0, twc: 0, tdb: 0, x: -20, y: 0, tx: 0, ty: 0, thrSlot: null, dbSlot: null };
  }
  function finish(r, state) {
    if (r.state === 'waitconn' || r.state === 'db' || r.state === 'cpu') S.usedThreads--;
    if (r.state === 'db') S.usedConns--;
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
  function abandon(r) { r.abandoned = true; S.win.to++; clientFail(); if (M.cancelOnTimeout) { finish(r, 'timeout'); return true; } return false; }
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
        if (S.usedThreads < M.threads) { S.usedThreads++; r.tq = S.t - r.tState; r.state = 'waitconn'; r.tState = S.t; }
      }
      if (r.state === 'waitconn') {
        if (S.usedConns < M.conns) { S.usedConns++; r.twc = S.t - r.tState; r.state = 'db'; r.tState = S.t; r.tDone = S.t + expo(dbEff(r)); }
      }
      if (r.state === 'db' && S.t >= r.tDone) { S.usedConns--; r.tdb = S.t - r.tState; S.win.dbSum += r.tdb; S.win.dbN++; r.state = 'cpu'; r.tState = S.t; r.tDone = S.t + cpuBase(r); }
      if (r.state === 'cpu' && S.t >= r.tDone) { finish(r, 'done'); continue; }
      alive.push(r);
    }
    S.reqs = alive;
    // (c) 집계
    const w = S.win; w.ticks++; w.thBusy += S.usedThreads / M.threads; w.coBusy += S.usedConns / M.conns;
    let waiting = 0; for (const r of S.reqs) if (r.state === 'queued' || r.state === 'waitconn') waiting++;
    w.waitSum += waiting;
    const sec = Math.floor(S.t / 1000);
    if (sec !== S.lastSec) { S.lastSec = sec; roll(); }
  }
  function roll() {
    const w = S.win, k = Math.max(1, w.ticks);
    let q = 0, wc = 0; for (const r of S.reqs) { if (r.state === 'queued') q++; else if (r.state === 'waitconn') wc++; }
    const n = Math.max(1, w.done);
    const h = { t: S.t / 1000, in: w.spawned, out: w.done, rej: w.rej, to: w.to, retry: w.retry, wasted: w.wasted, dbMean: w.dbN ? w.dbSum / w.dbN : 0,
      brk: { q: w.brk.q / n, wc: w.brk.wc / n, db: w.brk.db / n, cpu: w.brk.cpu / n },
      p50: pct(w.lat, .5), p95: pct(w.lat, .95), p99: pct(w.lat, .99), lat: w.lat, thU: w.thBusy / k, coU: w.coBusy / k, q, wc, avgWait: w.waitSum / k,
      // 작업 유형별: 같은 서버인데 어떤 작업이 먼저 SLO를 깨는지 보려면 유형별 p95를 따로 봐야 한다
      cls: w.cls.map((c, i) => ({ name: (M.mix && M.mix[i]) ? M.mix[i].name : '', done: c.done, p50: pct(c.lat, .5), p95: pct(c.lat, .95) })),
      clsLat: w.cls.map(c => c.lat),
      rps: M.rps, dbTimeMs: M.dbTimeMs };
    S.history.push(h); while (S.history.length > M.historySec + 1) S.history.shift();
    S.win = newWin();
    if (S.onSecond) S.onSecond(h);
  }
  function reset() { S.t = 0; S.reqs = []; S.fx = []; S.retryQ = []; S.usedThreads = 0; S.usedConns = 0; S.history = []; S.lastSec = 0; S.win = newWin(); S.trace = null; }
  return { S, step, reset };
}

// 헤드리스 실행: cfg로 durationSec 동안 돌리고 warmupSec 이후 집계
function runHeadless(cfg, durationSec, warmupSec) {
  const M = Object.assign({}, MODEL, cfg, { dt: 4 });
  const sim = createSim(M);
  const lat = []; let inN = 0, done = 0, rej = 0, to = 0; const B = { q: 0, wc: 0, db: 0, cpu: 0 }; let bn = 0;
  const nC = (M.mixOn && M.mix) ? M.mix.length : 0, CL = Array.from({ length: nC }, () => []);
  let thU = 0, coU = 0, qSum = 0, samples = 0;
  sim.S.onSecond = (h) => { if (h.t > warmupSec) { lat.push(...h.lat); inN += h.in; done += h.out; rej += h.rej; to += h.to;
    thU += h.thU; coU += h.coU; qSum += h.q; samples++;
    for (let i = 0; i < nC; i++) if (h.clsLat && h.clsLat[i]) CL[i].push(...h.clsLat[i]);
    if (h.out) { for (const k in B) B[k] += h.brk[k] * h.out; bn += h.out; } } };
  for (let i = 0; i < durationSec * 1000 / M.dt; i++) sim.step(M.dt);
  const secs = durationSec - warmupSec, k = Math.max(1, samples);
  if (bn) for (const key in B) B[key] /= bn;
  return { p50: pct(lat, .5), p95: pct(lat, .95), p99: pct(lat, .99), errRate: inN ? (rej + to) / inN : 0,
    thr: done / secs, inRate: inN / secs, brk: B, thU: thU / k, coU: coU / k, qAvg: qSum / k,
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
  const capT = M.threads * muT * 1000, capD = M.conns * muD * 1000, cap = Math.min(capT, capD);
  const dbBottle = rhoD >= rhoT, c = dbBottle ? M.conns : M.threads, mu = dbBottle ? muD : muT, rho = dbBottle ? rhoD : rhoT;
  let wq = Infinity; if (rho < 1) wq = erlangC(c, lam / mu) / (c * mu - lam);
  return { rhoT, rhoD, cap, capT, capD, wq, dbBottle, dbEffMs: dbT, dbNomMs: e.db, cpuEffMs: e.cpu };
}
function detectBottleneck(S, M) {
  const h = S.history[S.history.length - 1]; if (!h) return { level: 'ok', title: '정상', desc: '데이터 수집 중' };
  const th = theory(M), errRate = (h.rej + h.to) / Math.max(1, h.in), rhoMax = Math.max(th.rhoT, th.rhoD);
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
  manual: { name: '수동 (슬라이더)', at: () => ({ rps: null }),
    explain: [{ t: 0, text: '슬라이더로 직접 실험. README 시연: 300rps → 더 올림 → 스레드 200(무효) → 커넥션 30(회복)' }] },
  steady: { name: '정상 부하 (80 rps)', at: () => ({ rps: 80 }),
    explain: [{ t: 0, text: 'ρ≈0.25. 대기 없이 흐른다. 이 상태의 스레드/커넥션 이용률을 기억해 두자.' }] },
  spike: { name: '스파이크 (100 → 400 rps)', period: 40, at: (t) => ({ rps: t > 15 && t < 25 ? 400 : 100 }),
    explain: [{ t: 0, text: '평시 100rps.' }, { t: 15, text: '<b>400rps 스파이크</b> — 커넥션(최대 333rps)이 먼저 막힌다. 스레드가 주황색으로 변한다.' },
      { t: 25, text: '스파이크 종료. 큐에 쌓인 요청이 빠지며 회복. 타임아웃(3s)보다 큐 소진이 빠르면 손실은 일부에 그친다.' }] },
  ramp: { name: '점증 (0 → 600 rps)', period: 80, at: (t) => ({ rps: t < 60 ? Math.round(t / 60 * 600) : 0 }),
    explain: [{ t: 0, text: '유입을 선형으로 올린다. 응답시간은 <b>선형으로 오르지 않는다</b>.' },
      { t: 25, text: 'ρ≈0.75 부근(250rps)부터 p95가 꺾이기 시작.' }, { t: 33, text: 'ρ→1 (333rps). 대기시간 폭발. 이게 M/M/c의 핵심 직관.' }, { t: 60, text: '유입 0. 잔여 큐 소진.' }] },
  // ── 장애 패턴 ──
  slowq: { name: '장애: 슬로우 쿼리', period: 60, params: { rps: 150 },
    at: (t) => ({ rps: 150, dbScale: t > 15 && t < 40 ? 5 : 1 }),   // 모든 작업 유형의 DB 시간을 5배로 (작업 구성을 켜도 동작)
    explain: [{ t: 0, text: '150rps, ρ_db≈0.45. 여유롭다.' },
      { t: 15, text: '<b>DB 처리시간 30 → 150ms</b> (인덱스 깨짐, 락 경합, 느린 디스크…). 유입은 그대로인데 커넥션이 100% 찬다.' },
      { t: 20, text: '스레드가 주황색으로 — 앱 서버 지표(CPU, 스레드)는 멀쩡해 보여서 <b>앱을 의심하기 쉽다</b>. 병목 판정기는 "부하 대비 설명 안 되는 커넥션 포화"로 슬로우 쿼리를 짚는다.' },
      { t: 40, text: 'DB 회복. 커넥션 풀을 늘렸다면 DB에 더 많은 느린 쿼리를 밀어넣어 더 악화됐을 수 있다.' }] },
  retrystorm: { name: '장애: 재시도 폭풍', period: 70, params: { retryProb: 0.9, timeoutMs: 1000, queueCap: 400 },
    at: (t) => ({ rps: t > 15 && t < 25 ? 450 : 300 }),
    explain: [{ t: 0, text: '300rps (ρ≈0.9), 큐 400, 타임아웃 1s, 클라이언트는 실패 시 90% 재시도. 평시엔 문제없다.' },
      { t: 15, text: '<b>450rps 스파이크</b> 10초. 큐가 차서 대기가 1s를 넘고 타임아웃 시작 → 재시도가 유입에 더해진다.' },
      { t: 20, text: '보라색 = <b>낭비</b>: 클라이언트는 이미 포기했는데 서버는 그 요청을 계속 처리 중(취소 전파 없음). 서버 용량 전부가 아무도 안 기다리는 일에 쓰인다.' },
      { t: 25, text: '스파이크가 끝나 300rps로 돌아왔는데도 <b>처리량 0</b>. 큐는 고아 요청으로 차 있고, 새 요청은 전부 타임아웃 → 또 재시도. 스스로 절대 회복하지 못한다 (metastable failure).' },
      { t: 40, text: '해법 실험: ① 「취소 전파」 체크 → 낭비가 사라지며 회복. ② 재시도 확률 0(=backoff/서킷브레이커) → 회복. ③ 큐를 100으로 줄이면 애초에 타임아웃 대신 즉시 거절되어 폭풍이 안 생긴다(fail fast).' }] },
  herd: { name: '장애: Thundering herd', period: 50, params: { queueCap: 100 },
    at: (t) => ({ rps: t < 10 ? 150 : t < 18 ? 0 : t < 24 ? 700 : 150 }),
    explain: [{ t: 0, text: '평시 150rps.' }, { t: 10, text: '<b>서버 재시작/배포</b> — 8초간 유입 0. 그동안 클라이언트 요청이 바깥에 쌓인다.' },
      { t: 18, text: '복구 순간 <b>700rps</b>가 몰린다. 큐(100)가 즉시 넘쳐 거절이 쏟아지고, 잡힌 요청도 대기 끝에 타임아웃.' },
      { t: 24, text: '유입이 평시로 돌아와도 큐 잔량 때문에 몇 초 더 느리다. 해법: 워밍업 중 점진 유입(램프), 큐를 짧게 유지해 빨리 실패.' }] },
  hiddenq: { name: '장애: 큐 지연 축적', period: 60, params: { queueCap: 1000, timeoutMs: 10000 },
    at: (t) => ({ rps: t > 10 && t < 40 ? 360 : 200 }),
    explain: [{ t: 0, text: '"큐를 크게, 타임아웃을 길게" — 안 죽게 만들었다고 믿는 설정. 큐 1000, 타임아웃 10s.' },
      { t: 10, text: '용량을 살짝 넘는 <b>360rps</b>. 에러율은 거의 0. 대시보드는 초록색.' },
      { t: 25, text: '하지만 p95가 수 초로 치솟는다. 사용자는 이미 떠났고, <b>에러율만 보는 알람은 울리지 않는다</b>. 이게 숨은 장애.' },
      { t: 40, text: '유입이 줄어도 큐를 다 비울 때까지 느리다. 해법: 큐를 짧게 + 타임아웃 짧게 → 빨리 실패하고 빨리 회복(fail fast).' }] },
};
let scenarioKey = 'manual', scenarioStart = 0;
function applyScenario(sim) {
  const sc = SCENARIOS[scenarioKey];
  const t = (sim.S.t - scenarioStart) / 1000, tt = sc.period ? t % sc.period : t;
  // 슬라이더 기준값으로 되돌린 뒤 시나리오 덮어쓰기
  Object.assign(MODEL, BASE);
  const cur = sc.at(tt);
  for (const k in cur) if (cur[k] != null) MODEL[k] = cur[k];
  // 파일 trace: 시나리오가 바뀌거나 scenarioStart 가 바뀌면(재시작) 포인터를 처음으로 되돌린다.
  // MODEL.rps 는 슬라이더 값 대신 최근 1초 실제 도착 수 — 이론값·병목 판정·표시가 실제 유입을 보게 한다
  if (sc.trace) {
    const tr = sim.S.trace;
    if (!tr || tr.data !== sc.trace || tr.origin !== scenarioStart) sim.S.trace = startTrace(sc.trace, scenarioStart);
    MODEL.rps = traceRecent(sim.S.trace, sim.S.t);
  } else if (sim.S.trace) sim.S.trace = null;
  return tt;
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
 * 5. 렌더링 — 단면도 + 타임라인 + 검증 차트
 * ===================================================================== */
const $ = (id) => document.getElementById(id);
const stage = $('stage'), sctx = stage.getContext('2d');
const tl = $('timeline'), tctx = tl.getContext('2d');
const vf = $('verify'), vctx = vf.getContext('2d');
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
//  자원마다 성질이 다르므로 그림도 다르게 쓴다.
//   스레드 · 커넥션 = 정해진 슬롯을 몇 개 쓰는가  → 도트 매트릭스
//   대기 큐        = 쌓이고 있는가                → 스파크라인(면적)
//   요청 수지      = 유입이 어디로 갈라졌는가      → 분기 흐름(생키)
//   지연           = 한 건의 시간이 어디서 나갔나  → 100% 띠 한 줄
const CMP = { ref: null, reco: null };
const INK = { line: '#e3e8ef', off: '#dbe2ea', lab: '#6b7a8c', ink: '#16202c', hot: '#b0201a', warn: '#a16207', accent: '#1f6feb' };
const SEG = { q: '#dfe5ec', wc: '#aab6c4', db: '#1f6feb', cpu: '#7d8ea3' };
// n개를 w×h 안에 가장 크게 배치하는 격자
function fitGrid(w, h, n) {
  let best = { cols: n, rows: 1, c: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols), c = Math.min(w / cols, h / rows);
    if (c > best.c) best = { cols, rows, c };
  }
  return best;
}
function dotMatrix(bx, by, bw, bh, n, used, col) {
  const g = fitGrid(bw, bh, n), cell = Math.min(g.c, 13);
  const d = Math.max(2, cell - Math.max(1.2, cell * 0.24));
  const ox = bx + (bw - g.cols * cell) / 2, oy = by + (bh - g.rows * cell) / 2;
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / g.cols), c = i % g.cols;
    sctx.fillStyle = i < used ? col : INK.off;
    if (d > 6) { roundRect(sctx, ox + c * cell, oy + r * cell, d, d, 1.5); sctx.fill(); }
    else sctx.fillRect(ox + c * cell, oy + r * cell, d, d);
  }
}
function cellBox(x, y, w, h, title) {
  sctx.fillStyle = '#fff'; roundRect(sctx, x, y, w, h, 4); sctx.fill();
  sctx.strokeStyle = COL.grid; sctx.lineWidth = 1; sctx.stroke();
  sctx.textBaseline = 'top'; sctx.textAlign = 'left';
  sctx.fillStyle = INK.ink; sctx.font = '700 10.5px "Noto Sans KR", system-ui, sans-serif';
  sctx.fillText(title, x + 8, y + 6);
}
function drawStage(sim) {
  const S = sim.S, M = S.M;
  const { w, h, dpr } = fitCanvas(stage);
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, w, h);
  const hh = S.history[S.history.length - 1] || { out: 0, rej: 0, to: 0, wasted: 0, in: 0, retry: 0, p50: 0, p95: 0, thU: 0, coU: 0, q: 0, wc: 0, brk: { q: 0, wc: 0, db: 0, cpu: 0 } };
  const th = theory(M);
  const pad = 8, gap = 6, lat = 26;                       // lat: 아래 지연 띠
  const cw = (w - pad * 2 - gap * 3) / 4, ch = h - pad * 2 - lat - 4;
  const y = pad, headH = 20, footH = 14;
  const X = (i) => pad + i * (cw + gap);
  const hot = (u) => u > .9 ? INK.hot : u > .75 ? INK.warn : INK.accent;

  /* 1. 스레드 — 슬롯 매트릭스 */
  {
    const x = X(0); cellBox(x, y, cw, ch, '스레드');
    const bx = x + 8, by = y + headH, bw = cw - 16, bh = ch - headH - footH - 4;
    const n = M.threads, used = S.usedThreads;
    dotMatrix(bx, by, bw, bh, n, used, hot(hh.thU));
    sctx.textBaseline = 'bottom'; sctx.textAlign = 'left'; sctx.font = '700 11px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillStyle = INK.ink; sctx.fillText(`${used} / ${n}`, bx, y + ch - 5);
    sctx.textAlign = 'right'; sctx.fillStyle = hot(hh.thU);
    sctx.fillText(`${Math.round(hh.thU * 100)}%`, x + cw - 8, y + ch - 5);
  }

  /* 2. 커넥션 — 슬롯 매트릭스 (개수가 적어 점이 크다) */
  {
    const x = X(1); cellBox(x, y, cw, ch, '커넥션');
    const bx = x + 8, by = y + headH, bw = cw - 16, bh = ch - headH - footH - 4;
    const n = M.conns, used = S.usedConns;
    dotMatrix(bx, by, bw, bh, n, used, hot(hh.coU));
    sctx.textBaseline = 'bottom'; sctx.textAlign = 'left'; sctx.font = '700 11px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillStyle = INK.ink; sctx.fillText(`${used} / ${n}`, bx, y + ch - 5);
    sctx.textAlign = 'right'; sctx.fillStyle = hot(hh.coU);
    sctx.fillText(`${Math.round(hh.coU * 100)}%`, x + cw - 8, y + ch - 5);
  }

  /* 3. 대기 큐 — 적체 추세 스파크라인 (큐는 "지금 값"보다 "쌓이는가"가 중요하다) */
  {
    const x = X(2); cellBox(x, y, cw, ch, '대기 큐');
    const bx = x + 8, by = y + headH, bw = cw - 16, bh = ch - headH - footH - 4;
    const H = S.history.slice(-40), u = hh.q / M.queueCap;
    sctx.strokeStyle = INK.line; sctx.lineWidth = 1;
    sctx.beginPath(); sctx.moveTo(bx, by + bh); sctx.lineTo(bx + bw, by + bh); sctx.stroke();
    if (H.length > 1) {
      const mq = Math.max(M.queueCap * 0.15, ...H.map(d => d.q));
      const px = (i) => bx + i / (H.length - 1) * bw, py = (v) => by + bh - Math.min(1, v / mq) * bh;
      sctx.beginPath(); sctx.moveTo(px(0), by + bh);
      H.forEach((d, i) => sctx.lineTo(px(i), py(d.q)));
      sctx.lineTo(px(H.length - 1), by + bh); sctx.closePath();
      sctx.fillStyle = u > .75 ? '#f6dedd' : '#e6eefc'; sctx.fill();
      sctx.beginPath(); H.forEach((d, i) => i ? sctx.lineTo(px(i), py(d.q)) : sctx.moveTo(px(i), py(d.q)));
      sctx.strokeStyle = hot(u); sctx.lineWidth = 1.5; sctx.stroke();
    }
    sctx.textBaseline = 'bottom'; sctx.textAlign = 'left'; sctx.font = '700 11px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillStyle = INK.ink; sctx.fillText(`${hh.q} / ${M.queueCap}`, bx, y + ch - 5);
    sctx.textAlign = 'right'; sctx.fillStyle = hot(u);
    sctx.fillText(`${Math.round(u * 100)}%`, x + cw - 8, y + ch - 5);
  }

  /* 4. 요청 수지 — 유입 한 줄기가 완료/실패/낭비로 갈라지는 흐름 */
  {
    const x = X(3); cellBox(x, y, cw, ch, '요청 수지');
    const bx = x + 8, by = y + headH, bw = cw - 16, bh = ch - headH - footH - 4;
    const raw = [['완료', hh.out, INK.accent], ['실패', hh.rej + hh.to, INK.hot], ['낭비', hh.wasted, SEG.wc]];
    const sum = Math.max(1, raw.reduce((a, p) => a + p[1], 0));
    const parts = raw.map(p => [p[0], p[1] / sum, p[2]]).filter(p => p[1] > 0.004);
    const stemW = 6, gapY = 3, H = bh - gapY * Math.max(0, parts.length - 1);
    sctx.fillStyle = INK.off; sctx.fillRect(bx, by, stemW, bh);     // 유입 기둥
    const rx = bx + 30, rw = Math.max(18, bw - 30 - 48);
    let ly = by, ry = by;
    for (const [nm, v, c] of parts) {
      const t = Math.max(1.5, v * H);
      sctx.fillStyle = c; sctx.globalAlpha = 0.9;
      sctx.beginPath();
      sctx.moveTo(bx + stemW, ly);
      sctx.bezierCurveTo(rx - 14, ly, rx - 24, ry, rx, ry);
      sctx.lineTo(rx + rw, ry); sctx.lineTo(rx + rw, ry + t); sctx.lineTo(rx, ry + t);
      sctx.bezierCurveTo(rx - 24, ry + t, rx - 14, ly + t, bx + stemW, ly + t);
      sctx.closePath(); sctx.fill(); sctx.globalAlpha = 1;
      sctx.textBaseline = 'middle'; sctx.textAlign = 'left';
      sctx.fillStyle = INK.lab; sctx.font = '9.5px "Noto Sans KR", system-ui, sans-serif';
      sctx.fillText(`${nm} ${Math.round(v * 100)}%`, rx + rw + 4, ry + t / 2);
      ly += t; ry += t + gapY;
    }
    sctx.textBaseline = 'bottom'; sctx.textAlign = 'left'; sctx.font = '700 11px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillStyle = INK.ink; sctx.fillText(`유입 ${hh.in}/s`, bx, y + ch - 5);
    if (hh.retry > 0) { sctx.textAlign = 'right'; sctx.fillStyle = INK.warn; sctx.font = '10px "Noto Sans KR", system-ui, sans-serif';
      sctx.fillText(`재시도 ${hh.retry}`, x + cw - 8, y + ch - 5); }
  }

  /* 5. 지연 분해 — 한 건의 시간이 어느 구간에서 나갔나 (전폭 띠 한 줄) */
  {
    const sy = y + ch + 4, sh = lat - 4, fullW = w - pad * 2, cy = sy + sh / 2;
    sctx.fillStyle = '#fff'; roundRect(sctx, pad, sy, fullW, sh, 4); sctx.fill();
    sctx.strokeStyle = COL.grid; sctx.lineWidth = 1; sctx.stroke();
    sctx.textBaseline = 'middle'; sctx.textAlign = 'left';
    sctx.fillStyle = INK.ink; sctx.font = '700 10.5px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillText('지연 분해', pad + 8, cy);
    const b = hh.brk, tot = b.q + b.wc + b.db + b.cpu;
    const bx = pad + 62, bw = Math.max(60, fullW - 62 - 236), bh = 11, by = cy - bh / 2;
    sctx.fillStyle = INK.line; sctx.fillRect(bx, by, bw, bh);
    let cx = bx;
    for (const [nm, k] of [['큐', 'q'], ['커넥션', 'wc'], ['DB', 'db'], ['CPU', 'cpu']]) {
      const fw = tot > 0 ? b[k] / tot * bw : 0; if (fw <= .5) continue;
      sctx.fillStyle = SEG[k]; sctx.fillRect(cx, by, Math.min(fw, bx + bw - cx), bh);
      if (fw > 34) { sctx.fillStyle = k === 'db' ? '#fff' : INK.ink; sctx.font = '700 9px "Noto Sans KR", system-ui, sans-serif';
        sctx.textAlign = 'center'; sctx.fillText(nm, cx + fw / 2, cy); sctx.textAlign = 'left'; }
      cx += fw;
    }
    sctx.textAlign = 'right'; sctx.fillStyle = INK.lab; sctx.font = '10px "Noto Sans KR", system-ui, sans-serif';
    sctx.fillText(`평균 ${Math.round(tot)}ms  ·  p95 ${Math.round(hh.p95)}/${$('sloP95').value}ms  ·  병목 ${th.dbBottle ? 'DB' : '앞단'}  ·  최대 ${th.cap.toFixed(0)}rps`, pad + fullW - 8, cy);
  }
}
function wrapText(c, text, x, y, maxW, lh) {
  const words = text.split(' '); let line = '', yy = y;
  for (const wd of words) { const t = line ? line + ' ' + wd : wd;
    if (c.measureText(t).width > maxW && line) { c.fillText(line, x, yy); line = wd; yy += lh; } else line = t; }
  if (line) c.fillText(line, x, yy);
}

// ── 타임라인: 처리량 / 응답시간 / 이용률·큐. 시나리오 단계 마커 포함 ──
const TL = { hoverX: null };
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function fmt(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v).toString(); }
function drawTimeline(sim) {
  const S = sim.S, M = S.M, H = S.history, N = M.historySec;
  const { w, h, dpr } = fitCanvas(tl); tctx.setTransform(dpr, 0, 0, dpr, 0, 0); tctx.clearRect(0, 0, w, h);
  const padL = 38, padR = 12, padT = 22, padB = 16, gapY = 14, ph = (h - padT - padB - gapY) / 2;
  const panels = [
    { y: padT, title: '처리량', series: [{ k: 'in', name: '유입', c: COL.s_in }, { k: 'out', name: '완료', c: COL.s_out }, { k: 'fail', name: '실패', c: COL.s_rej }, { k: 'retry', name: '재시도', c: COL.s_retry, dash: [3, 3] }] , unit: '/s' },
    { y: padT + ph + gapY, title: '응답시간', series: [{ k: 'p50', name: 'p50', c: COL.s_p50 }, { k: 'p95', name: 'p95', c: COL.s_p95 }], ref: M.timeoutMs, unit: ' ms' },
  ];
  const val = (d, k) => k === 'fail' ? d.rej + d.to : k === 'thUp' ? d.thU * 100 : k === 'coUp' ? d.coU * 100 : k === 'qp' ? d.q / M.queueCap * 100 : d[k];
  const t0 = H.length ? H[H.length - 1].t - N : 0, X = (t) => padL + (t - t0) / N * (w - padL - padR);
  tctx.font = '11px "Noto Sans KR", system-ui, sans-serif'; tctx.textBaseline = 'middle';
  for (const p of panels) {
    let max = p.fixedMax || 10; if (!p.fixedMax) { for (const s of p.series) for (const d of H) max = Math.max(max, val(d, s.k)); max = niceMax(max); }
    const Y = (v) => p.y + ph - Math.min(v, max) / max * ph;
    tctx.strokeStyle = COL.grid; tctx.lineWidth = 1; tctx.fillStyle = COL.muted; tctx.textAlign = 'right';
    tctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
    for (let i = 0; i <= 2; i++) { const v = max * i / 2, y = Y(v); tctx.beginPath(); tctx.moveTo(padL, y); tctx.lineTo(w - padR, y); tctx.stroke(); tctx.fillText(fmt(v), padL - 5, y); }
    tctx.textAlign = 'left'; tctx.textBaseline = 'bottom'; tctx.fillStyle = COL.ink; tctx.font = '700 10px "Noto Sans KR", system-ui, sans-serif'; tctx.fillText(p.title, padL, p.y - 4);
    let lx = padL + tctx.measureText(p.title).width + 12; tctx.font = '11px "Noto Sans KR", system-ui, sans-serif';
    for (const s of p.series) { tctx.strokeStyle = s.c; tctx.lineWidth = 2; tctx.setLineDash(s.dash || []); tctx.beginPath(); tctx.moveTo(lx, p.y - 8); tctx.lineTo(lx + 10, p.y - 8); tctx.stroke(); tctx.setLineDash([]); tctx.fillStyle = COL.ink2; tctx.fillText(s.name, lx + 13, p.y - 4); lx += 13 + tctx.measureText(s.name).width + 10; }
    tctx.textBaseline = 'middle';
    if (p.ref && p.ref <= max) { tctx.setLineDash([3, 3]); tctx.strokeStyle = COL.s_rej; tctx.lineWidth = 1; tctx.beginPath(); tctx.moveTo(padL, Y(p.ref)); tctx.lineTo(w - padR, Y(p.ref)); tctx.stroke(); tctx.setLineDash([]); tctx.fillStyle = COL.s_rej; tctx.textAlign = 'right'; tctx.fillText('타임아웃', w - padR - 2, Y(p.ref) - 7); tctx.textAlign = 'left'; }
    tctx.lineWidth = 2; tctx.lineJoin = 'round';
    for (const s of p.series) { tctx.strokeStyle = s.c; tctx.setLineDash(s.dash || []); tctx.beginPath(); H.forEach((d, i) => { const x = X(d.t), y = Y(val(d, s.k)); i ? tctx.lineTo(x, y) : tctx.moveTo(x, y); }); tctx.stroke(); tctx.setLineDash([]); }
    p.Y = Y;
  }
  // 시나리오 단계 마커
  const sc = SCENARIOS[scenarioKey];
  if ((sc.period || sc.file) && H.length) { const base = scenarioStart / 1000, tEnd = H[H.length - 1].t, reps = sc.period ? Infinity : 1;
    for (let k = 0; k < reps && base + k * (sc.period || 0) <= tEnd; k++) for (const st of sc.explain) { const t = base + k * (sc.period || 0) + st.t; if (t < t0 || t > tEnd) continue; const x = X(t);
      tctx.strokeStyle = COL.axis; tctx.setLineDash([2, 4]); tctx.beginPath(); tctx.moveTo(x, padT); tctx.lineTo(x, h - padB); tctx.stroke(); tctx.setLineDash([]);
      tctx.fillStyle = COL.muted; tctx.font = '10px "Noto Sans KR", system-ui, sans-serif'; tctx.textBaseline = 'bottom'; tctx.textAlign = 'left'; tctx.fillText(`▸${st.t}s`, x + 2, h - padB - 2); tctx.textBaseline = 'middle'; } }
  // x축
  tctx.fillStyle = COL.muted; tctx.font = '11px "Noto Sans KR", system-ui, sans-serif'; tctx.textAlign = 'center'; tctx.textBaseline = 'top';
  const step = N <= 60 ? 10 : N <= 120 ? 20 : 60;
  for (let s = 0; s <= N; s += step) { const t = t0 + s; if (t < 0) continue; tctx.fillText(`${Math.round(t)}s`, X(t), h - padB + 6); }
  // 크로스헤어 + 툴팁
  const tip = $('tooltip');
  if (TL.hoverX != null && H.length > 1) {
    const tt = t0 + (TL.hoverX - padL) / (w - padL - padR) * N; let best = H[0]; for (const d of H) if (Math.abs(d.t - tt) < Math.abs(best.t - tt)) best = d;
    const x = X(best.t);
    tctx.strokeStyle = COL.ink2; tctx.setLineDash([2, 3]); tctx.lineWidth = 1; tctx.beginPath(); tctx.moveTo(x, padT - 4); tctx.lineTo(x, h - padB); tctx.stroke(); tctx.setLineDash([]);
    for (const p of panels) for (const s of p.series) { tctx.fillStyle = s.c; tctx.beginPath(); tctx.arc(x, p.Y(val(best, s.k)), 3.5, 0, 7); tctx.fill(); tctx.strokeStyle = '#fff'; tctx.lineWidth = 1.5; tctx.stroke(); }
    tip.style.display = 'block';
    tip.innerHTML = `<div class="r"><b>t = ${best.t.toFixed(0)}s</b><span>설정 유입 ${best.rps}rps · DB ${Math.round(best.dbTimeMs)}ms</span></div>` +
      panels.flatMap(p => p.series.map(s => `<div class="r"><span><i style="background:${s.c}"></i>${s.name}</span><span>${fmt(val(best, s.k))}${p.unit}</span></div>`)).join('') +
      `<div class="r"><span>낭비(고아) / 큐 / 커넥션 대기</span><span>${best.wasted}/s · ${best.q} · ${best.wc}</span></div>`;
    const rect = tl.parentElement.getBoundingClientRect(); tip.style.left = Math.min(x + 12, rect.width - tip.offsetWidth - 8) + 'px'; tip.style.top = '40px';
  } else tip.style.display = 'none';
}
tl.addEventListener('mousemove', (e) => { TL.hoverX = e.offsetX; }); tl.addEventListener('mouseleave', () => { TL.hoverX = null; });
$('win').addEventListener('change', () => { MODEL.historySec = +$('win').value; });

// ── 검증 차트: x=rps, y=p95 — 실측 vs 시뮬 ──
const VERIFY = { real: [], sim: [], hoverX: null };
// 설정 후보 비교(D9)가 채우는 레이어. 엔진은 그리기만 하고 내용은 advisor.js 가 넣는다.
//   curves: [{ name, color, pts:[{rps,p50,p95,err}], knee }]   knee = 과부하 시작 rps (null이면 스윕 구간 내내 여유)
const CANDV = { curves: [], show: false, p95Target: 0, peak: 0 };
function drawVerify() {
  const { w, h, dpr } = fitCanvas(vf); vctx.setTransform(dpr, 0, 0, dpr, 0, 0); vctx.clearRect(0, 0, w, h);
  const padL = 44, padR = 12, padB = 26;
  const CV = CANDV.show ? CANDV.curves : [];
  const all = [...VERIFY.real, ...VERIFY.sim, ...CV.reduce((a, c) => a.concat(c.pts), [])];
  // 범례를 먼저 배치해 필요한 줄 수를 구하고, 그만큼 위 여백을 잡는다 (후보가 늘어도 겹치지 않는다)
  const legend = [];
  if (VERIFY.real.length) legend.push([`실측 ${VERIFY.real.length}점`, COL.s_real]);
  if (VERIFY.sim.length) legend.push([`시뮬 ${VERIFY.sim.length}점`, COL.s_sim]);
  for (const c of CV) legend.push([c.name, c.color]);
  vctx.font = '10.5px "Noto Sans KR", system-ui, sans-serif';
  const lay = []; let legendRows = 0, lgx = padL;
  for (const it of legend) {
    const tw = 12 + vctx.measureText(it[0]).width + 12;
    if (lgx + tw > w - padR && lgx > padL) { lgx = padL; legendRows++; }
    lay.push({ it, x: lgx, row: legendRows }); lgx += tw;
  }
  if (legend.length) legendRows++;
  const padT = 62 + legendRows * 15;   // 위쪽 44px 은 패널 제목 + #verifyBar 버튼 줄이 덮는다
  const maxX = niceMax(Math.max(100, ...all.map(d => d.rps))), maxY = niceMax(Math.max(100, ...all.map(d => d.p95)));
  const X = (v) => padL + v / maxX * (w - padL - padR), Y = (v) => padT + (h - padT - padB) - v / maxY * (h - padT - padB);
  vctx.font = '11px "Noto Sans KR", system-ui, sans-serif'; vctx.strokeStyle = COL.grid; vctx.fillStyle = COL.muted; vctx.lineWidth = 1;
  vctx.textAlign = 'right'; vctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) { const v = maxY * i / 4; vctx.beginPath(); vctx.moveTo(padL, Y(v)); vctx.lineTo(w - padR, Y(v)); vctx.stroke(); vctx.fillText(fmt(v), padL - 6, Y(v)); }
  vctx.textAlign = 'center'; vctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i++) { const v = maxX * i / 5; vctx.fillText(fmt(v) + ' rps', X(v), h - padB + 6); }
  vctx.textAlign = 'left'; vctx.textBaseline = 'bottom'; vctx.fillStyle = COL.ink2; vctx.font = '600 11px "Noto Sans KR", system-ui, sans-serif';
  vctx.fillText('p95 / 유입', padL, 56);
  vctx.font = '10.5px "Noto Sans KR", system-ui, sans-serif';
  for (const { it, x, row } of lay) {
    const y = 72 + row * 15;
    vctx.fillStyle = it[1]; vctx.fillRect(x, y - 9, 9, 9);
    vctx.fillStyle = COL.ink2; vctx.fillText(it[0], x + 12, y);
  }
  const line = (pts, c) => { if (!pts.length) return; const s = pts.slice().sort((a, b) => a.rps - b.rps); vctx.strokeStyle = c; vctx.lineWidth = 2; vctx.beginPath(); s.forEach((d, i) => i ? vctx.lineTo(X(d.rps), Y(d.p95)) : vctx.moveTo(X(d.rps), Y(d.p95))); vctx.stroke();
    for (const d of s) { vctx.fillStyle = c; vctx.beginPath(); vctx.arc(X(d.rps), Y(d.p95), 4, 0, 7); vctx.fill(); vctx.strokeStyle = COL.surface; vctx.lineWidth = 2; vctx.stroke(); } };
  line(VERIFY.real, COL.s_real); line(VERIFY.sim, COL.s_sim);
  // ── 후보 비교 레이어 ── 가로 점선 = 목표 p95(= 무너졌다고 보는 선), 세로 점선 = 그 선을 넘는 rps
  if (CV.length) {
    if (CANDV.peak > 0 && CANDV.peak <= maxX) {
      vctx.strokeStyle = COL.axis; vctx.setLineDash([2, 4]); vctx.lineWidth = 1;
      vctx.beginPath(); vctx.moveTo(X(CANDV.peak), padT); vctx.lineTo(X(CANDV.peak), h - padB); vctx.stroke(); vctx.setLineDash([]);
      vctx.fillStyle = COL.muted; vctx.textAlign = 'center'; vctx.textBaseline = 'top'; vctx.font = '10px "Noto Sans KR", system-ui, sans-serif';
      vctx.fillText(`피크 ${CANDV.peak}`, X(CANDV.peak), h - padB + 13);
    }
    if (CANDV.p95Target > 0 && CANDV.p95Target <= maxY) {
      vctx.strokeStyle = COL.axis; vctx.setLineDash([4, 3]); vctx.lineWidth = 1;
      vctx.beginPath(); vctx.moveTo(padL, Y(CANDV.p95Target)); vctx.lineTo(w - padR, Y(CANDV.p95Target)); vctx.stroke(); vctx.setLineDash([]);
      vctx.fillStyle = COL.muted; vctx.textAlign = 'left'; vctx.textBaseline = 'bottom'; vctx.font = '10px "Noto Sans KR", system-ui, sans-serif';
      vctx.fillText(`목표 p95 ${CANDV.p95Target}ms`, padL + 4, Y(CANDV.p95Target) - 3);
    }
    CV.forEach((c, i) => {
      line(c.pts, c.color);
      if (c.knee != null && c.knee <= maxX) {
        vctx.strokeStyle = c.color; vctx.setLineDash([3, 3]); vctx.lineWidth = 1.5;
        vctx.beginPath(); vctx.moveTo(X(c.knee), padT); vctx.lineTo(X(c.knee), h - padB); vctx.stroke(); vctx.setLineDash([]);
        // 과부하 지점이 가까우면 숫자가 겹친다 — 한 칸씩 내려 쓴다
        vctx.fillStyle = c.color; vctx.textAlign = 'center'; vctx.textBaseline = 'top'; vctx.font = '700 10px "Noto Sans KR", system-ui, sans-serif';
        vctx.fillText(String(c.knee), X(c.knee), padT + 2 + (i % 3) * 12);
      }
      // 이 설정이 지금 트래픽(피크)에서 서 있는 위치 — 네모 마커
      if (CANDV.peak > 0 && c.at) {
        const mx = X(CANDV.peak), my = Y(c.at.p95);
        vctx.fillStyle = c.color; vctx.fillRect(mx - 4, my - 4, 8, 8);
        vctx.strokeStyle = '#fff'; vctx.lineWidth = 1.5; vctx.strokeRect(mx - 4, my - 4, 8, 8);
      }
    });
    vctx.font = '11px "Noto Sans KR", system-ui, sans-serif';
  }
  if (!all.length) { vctx.fillStyle = COL.muted; vctx.textAlign = 'center'; vctx.textBaseline = 'middle'; vctx.fillText('후보를 비교하면 곡선이 그려집니다', w / 2, h / 2); }
  // 오차 요약
  if (VERIFY.real.length && VERIFY.sim.length) {
    let se = 0, n = 0; for (const r of VERIFY.real) { const s = VERIFY.sim.find(d => d.rps === r.rps); if (s && r.p95 > 0) { se += Math.abs(s.p95 - r.p95) / r.p95; n++; } }
    if (n) { vctx.fillStyle = COL.ink2; vctx.textAlign = 'right'; vctx.textBaseline = 'bottom'; vctx.fillText(`p95 평균 상대오차 ${(se / n * 100).toFixed(0)}% (${n}점)`, w - padR, 56); }
  }
  // 호버
  const tip = $('tooltip2');
  if (VERIFY.hoverX != null && all.length) {
    const rx = (VERIFY.hoverX - padL) / (w - padL - padR) * maxX;
    const near = (pts) => pts.length ? pts.reduce((b, d) => Math.abs(d.rps - rx) < Math.abs(b.rps - rx) ? d : b) : null;
    const r = near(VERIFY.real), s = near(VERIFY.sim);
    tip.style.display = 'block';
    tip.innerHTML = (r ? `<div class="r"><span><i style="background:${COL.s_real}"></i>실측 ${r.rps}rps</span><span>p50 ${fmt(r.p50)} · p95 ${fmt(r.p95)} ms · 실패 ${(r.err * 100).toFixed(1)}%</span></div>` : '') +
      (s ? `<div class="r"><span><i style="background:${COL.s_sim}"></i>시뮬 ${s.rps}rps</span><span>p50 ${fmt(s.p50)} · p95 ${fmt(s.p95)} ms · 실패 ${(s.err * 100).toFixed(1)}%</span></div>` : '') +
      CV.map(c => { const d = near(c.pts); return d ? `<div class="r"><span><i style="background:${c.color}"></i>${c.name} ${d.rps}rps</span><span>p95 ${fmt(d.p95)} ms · 실패 ${(d.err * 100).toFixed(1)}%</span></div>` : ''; }).join('');
    tip.style.left = Math.min(VERIFY.hoverX + 12, w - tip.offsetWidth - 8) + 'px'; tip.style.top = '28px';
  } else tip.style.display = 'none';
}
vf.addEventListener('mousemove', (e) => { VERIFY.hoverX = e.offsetX; }); vf.addEventListener('mouseleave', () => { VERIFY.hoverX = null; });

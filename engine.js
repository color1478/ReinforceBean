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

  function spawn(retry) {
    return { id: S.nextId++, state: 'queued', tSpawn: S.t, tState: S.t, tDone: 0, retry: !!retry, abandoned: false, cls: pickClass(),
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
  function step(dt) {
    S.t += dt;
    let queued = 0; for (const r of S.reqs) if (r.state === 'queued') queued++;
    // (a) 유입: 신규(포아송) + 재시도(예약)
    const n = poisson(M.rps * dt / 1000);
    for (let i = 0; i < n; i++) if (enqueue(spawn(false), queued)) queued++;
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
  function reset() { S.t = 0; S.reqs = []; S.fx = []; S.retryQ = []; S.usedThreads = 0; S.usedConns = 0; S.history = []; S.lastSec = 0; S.win = newWin(); }
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
  return tt;
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
  if (sc.period && H.length) { const base = scenarioStart / 1000, tEnd = H[H.length - 1].t;
    for (let k = 0; base + k * sc.period <= tEnd; k++) for (const st of sc.explain) { const t = base + k * sc.period + st.t; if (t < t0 || t > tEnd) continue; const x = X(t);
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

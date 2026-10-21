/* engine.js — 파트 1 · 진단
   구획 1~5: 모델 · 시뮬레이션 엔진 · 이론값/병목 판정 · 시나리오 · 렌더링
   밖으로 내보내는 계약: createSim(M) · runHeadless(cfg, sec, warmup) · theory(cfg) · MODEL/BASE
                        · SCENARIOS/applyScenario · drawStage(sim) · drawCompare(list, opts)
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

  function spawn(retry) {
    return { id: S.nextId++, state: 'queued', tSpawn: S.t, tState: S.t, tDone: 0, retry: !!retry, abandoned: false, cls: pickClass(),
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
  function reset() { S.t = 0; S.reqs = []; S.fx = []; S.retryQ = []; S.usedThreads = 0; S.usedConns = 0; S.usedCores = 0; S.history = []; S.lastSec = 0; S.win = newWin(); }
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
    return { level: 'bad', title: '슬로우 쿼리 → 커넥션 고갈', desc: `DB ${Math.round(nomDb)}ms → ${Math.round(h.dbMean)}ms · 커넥션 ${Math.round(h.coU * 100)}% 점유` };
  // 작업 구성 진단: 소수 비율의 무거운 작업이 DB 시간의 대부분을 먹는 경우 (같은 rps라도 구성이 다르면 병목이 다르다)
  if (M.mixOn && M.mix) {
    let tot = 0; const load = M.mix.map(m => { const l = m.share * m.dbTimeMs; tot += l; return l; });
    let hi = 0; for (let i = 1; i < load.length; i++) if (load[i] > load[hi]) hi = i;
    const heavy = M.mix[hi], loadShare = tot > 0 ? load[hi] / tot : 0;
    if (rhoMax > 0.7 && loadShare > 0.5 && heavy.share < 0.35)
      return { level: 'warn', title: `작업 구성 편중 — "${heavy.name}"`, desc: `요청의 ${Math.round(heavy.share * 100)}%가 DB 시간의 ${Math.round(loadShare * 100)}% 사용 · ρ ${rhoMax.toFixed(2)}` };
  }
  if (h.q > M.queueCap * 0.25 && errRate < 0.02 && h.p95 > 600)
    return { level: 'bad', title: '큐 지연 축적 (숨은 장애)', desc: `실패 ${(errRate * 100).toFixed(1)}% · 95% 응답 ${Math.round(h.p95)}ms · 큐 ${h.q}/${M.queueCap}` };
  if (retryShare > 0.25 && h.coU > 0.85)
    return { level: 'bad', title: '재시도 폭풍 (metastable)', desc: `유입의 ${(retryShare * 100).toFixed(0)}%가 재시도 · 낭비 ${h.wasted}/s` };
  if (M.cores && h.cpU > 0.9 && (h.cw || 0) >= 1)
    return { level: 'bad', title: `CPU 포화 — vCPU ${M.cores}개 부족`, desc: `코어 ${M.cores}개 100% · CPU 대기 ${h.cw}건 · 한계 ${Math.round(th.capC)}rps < 유입 ${M.rps}rps` };
  if (h.coU > 0.9 && h.wc >= Math.max(3, M.threads * 0.2))
    return { level: 'bad', title: 'DB 커넥션 병목', desc: `커넥션 대기 스레드 ${h.wc}개 · ρ_db ${th.rhoD.toFixed(2)}` };
  if (h.thU > 0.9 && h.q > 0)
    return { level: 'bad', title: '스레드 포화', desc: `스레드 ${Math.round(h.thU * 100)}% · 큐 ${h.q} · ρ_thread ${th.rhoT.toFixed(2)}` };
  if (errRate > 0.05)
    return { level: 'bad', title: '유입 과다', desc: `실패 ${(errRate * 100).toFixed(0)}% · 최대 ${th.cap.toFixed(0)}rps < 유입 ${M.rps}rps` };
  if (rhoMax > 0.75)
    return { level: 'warn', title: '임계 접근', desc: `ρ ${rhoMax.toFixed(2)} (${th.dbBottle ? 'DB 커넥션' : '스레드'})` };
  return { level: 'ok', title: '정상', desc: `ρ ${rhoMax.toFixed(2)} · 최대 ${th.cap.toFixed(0)}rps` };
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
// y축 0~100% 고정(눈금 0·50·100%), x축은 최근 N초. ref(버스터블 기준선)는 점선으로 깐다.
function microSpark(x, y, w, h, vals, col, ref) {
  const axL = 26, axB = 11;                                 // 축 라벨 자리 (왼쪽·아래)
  const gx = x + axL, gw = w - axL, gy = y, gh = h - axB;
  sctx.fillStyle = '#f4f7fa'; sctx.fillRect(gx, gy, gw, gh);
  // 가로 격자 + y 눈금
  sctx.lineWidth = 1;
  for (const [f, lb] of [[1, '100%'], [.5, '50'], [0, '0']]) {
    const yy = gy + gh - f * gh;
    sctx.strokeStyle = f > 0 ? INK.line : COL.axis;
    sctx.beginPath(); sctx.moveTo(gx, yy); sctx.lineTo(gx + gw, yy); sctx.stroke();
    txt(lb, gx - 3, Math.max(gy + 4, Math.min(yy, gy + gh - 3)), 'right', INK.lab, FONT('8px'));
  }
  // y축
  sctx.strokeStyle = COL.axis;
  sctx.beginPath(); sctx.moveTo(gx, gy); sctx.lineTo(gx, gy + gh); sctx.stroke();
  if (vals && vals.length > 1) {
    const px = (i) => gx + i / (vals.length - 1) * gw, py = (v) => gy + gh - Math.max(0, Math.min(1, v)) * gh;
    sctx.beginPath(); sctx.moveTo(px(0), gy + gh);
    vals.forEach((v, i) => sctx.lineTo(px(i), py(v)));
    sctx.lineTo(px(vals.length - 1), gy + gh); sctx.closePath();
    sctx.globalAlpha = .18; sctx.fillStyle = col; sctx.fill(); sctx.globalAlpha = 1;
    sctx.beginPath(); vals.forEach((v, i) => i ? sctx.lineTo(px(i), py(v)) : sctx.moveTo(px(i), py(v)));
    sctx.strokeStyle = col; sctx.lineWidth = 1.2; sctx.stroke();
  }
  if (ref != null && ref > 0 && ref < 1) {
    const ry = gy + gh - ref * gh;
    sctx.setLineDash([2, 2]); sctx.strokeStyle = INK.warn; sctx.lineWidth = 1;
    sctx.beginPath(); sctx.moveTo(gx, ry); sctx.lineTo(gx + gw, ry); sctx.stroke(); sctx.setLineDash([]);
  }
  // x 눈금 — 최근 N초 전 → 지금
  const span = vals && vals.length > 1 ? vals.length - 1 : 30;
  txt(`-${span}s`, gx, y + h - 4, 'left', INK.lab, FONT('8px'));
  txt('0s', gx + gw, y + h - 4, 'right', INK.lab, FONT('8px'));
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
  const nh = Math.max(72, Math.min(176, area * 0.72));      // 칸을 크게 — 안의 추세 그래프가 이 화면의 본문이다
  const cy = top + Math.max(nh / 2, area * 0.40);
  const sinkY = bot - 14;
  // 가로를 최대한 쓴다 — 띠(가지) 간격은 18px 만 남기고 나머지를 전부 칸 폭에 준다
  const nw = Math.max(104, Math.min(250, (w - pad * 2 - 46 - 18 * 5) / 4));
  const gap = Math.max(18, (w - pad * 2 - nw * 4 - 46) / 5);
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
    + `  ·  95% 응답 ${fmtMs(hh.p95)}  ·  병목 ${BN[th.bottle]}  ·  ρ ${(hh.in / Math.max(1, th.cap)).toFixed(2)}`,
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
  const padL = 40, padR = 74, padT = 40, padB = 14, gapY = 26;   // 오른쪽은 선 끝 이름 라벨 자리
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
  // dir: 값이 높은 쪽이 나쁜가 좋은가. badFrom/badRef: 이 선 위는 나쁜 영역(빨간 칠)
  const rows = [
    { title: 'CPU 이용률', unit: '%', fixedMax: 100, get: (d) => (d.cpU || 0) * 100, baseline: true, dir: 'bad', badFrom: 90 },
    { title: '95% 응답시간', unit: 'ms', get: (d) => d.p95, ref: opts.p95, refName: '목표', dir: 'bad', badRef: true },
    { title: '처리량', unit: '/s', get: (d) => d.out, showIn: true, dir: 'good' },
  ];
  const ph = (h - padT - padB - gapY * (rows.length - 1)) / rows.length;

  // ── 색 규칙 ──────────────────────────────────────────────────────────
  //  기본은 전부 제 색. 하나를 클릭해 강조하면 그것만 색을 지키고 나머지는 흑백(옅은 검정)으로 물러난다.
  const anySel = list.some(it => it.sel);
  const CK = (it) => (!anySel || it.sel) ? it.color : INK.ink;   // 선·점·기준선 색
  const CA = (it) => (!anySel || it.sel) ? 1 : 0.45;             // 흑백인 것은 옅게 뒤에
  const LW = (it) => it.sel ? 2.6 : anySel ? 1.3 : 2;
  const zOrder = list.map((it, i) => ({ it, i })).sort((a, b) => (a.it.sel ? 1 : 0) - (b.it.sel ? 1 : 0));

  // 범례 — 강조된 인스턴스는 굵게. 제목과 겹치지 않게 오른쪽 정렬.
  cctx.textBaseline = 'middle'; cctx.textAlign = 'left';
  const lab = list.map(it => `${it.type} (${it.vcpu}vCPU)`);
  cctx.font = '10.5px "Noto Sans KR", system-ui, sans-serif';
  const lw = lab.map(t => 12 + cctx.measureText(t).width + 14);
  let lx = Math.max(padL + 150, w - padR - lw.reduce((a, b) => a + b, 0) + 14);
  list.forEach((it, i) => {
    cctx.globalAlpha = CA(it); cctx.fillStyle = CK(it); cctx.fillRect(lx, 7, 9, 9); cctx.globalAlpha = 1;
    cctx.fillStyle = (!anySel || it.sel) ? COL.ink : COL.muted;
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
    // 패널 배경·테두리 — 세 지표를 칸으로 분리해 섞여 보이지 않게 한다
    cctx.fillStyle = COL.surface || '#fff';
    cctx.fillRect(padL, py0, w - padL - padR, ph);
    cctx.strokeStyle = COL.axis; cctx.lineWidth = 1;
    cctx.strokeRect(padL - .5, py0 - .5, w - padL - padR + 1, ph + 1);
    // 나쁜 영역 — 이 안으로 선이 들어가면 나쁘다 (CPU 90% 위 · 응답시간 목표 위)
    const badY = p.badFrom != null ? Y(p.badFrom)
      : (p.badRef && p.ref && p.ref <= max ? Y(p.ref) : null);
    if (badY != null) {
      cctx.fillStyle = 'rgba(176,32,26,.07)';
      cctx.fillRect(padL, py0, w - padL - padR, Math.max(0, badY - py0));
      if (p.badFrom != null) {
        cctx.strokeStyle = COL.s_rej; cctx.setLineDash([3, 3]); cctx.lineWidth = 1;
        cctx.beginPath(); cctx.moveTo(padL, badY); cctx.lineTo(w - padR, badY); cctx.stroke(); cctx.setLineDash([]);
        cctx.fillStyle = COL.s_rej; cctx.textAlign = 'right'; cctx.textBaseline = 'bottom';
        cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
        cctx.fillText(`위험 ${p.badFrom}%`, w - padR - 2, badY - 1);
      }
    }
    // 격자 + y 라벨
    cctx.strokeStyle = COL.grid; cctx.lineWidth = 1; cctx.fillStyle = COL.muted;
    cctx.textAlign = 'right'; cctx.textBaseline = 'middle'; cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
    for (let i = 0; i <= 2; i++) { const v = max * i / 2, yy = Y(v);
      if (i > 0 && i < 2) { cctx.beginPath(); cctx.moveTo(padL, yy); cctx.lineTo(w - padR, yy); cctx.stroke(); }
      cctx.fillText(fmt(v), padL - 4, yy); }
    // 소제목 — 강조 표식 + 굵게 + 방향(↑ 나쁨 / ↑ 좋음)
    cctx.fillStyle = INK.accent; cctx.fillRect(padL, py0 - 14, 3, 11);
    cctx.textAlign = 'left'; cctx.textBaseline = 'bottom'; cctx.fillStyle = COL.ink;
    cctx.font = '700 11px "Noto Sans KR", system-ui, sans-serif';
    const tt = `${['①', '②', '③'][ri] || ''} ${p.title} (${p.unit})`;
    cctx.fillText(tt, padL + 7, py0 - 4);
    if (p.dir) {
      const tw = cctx.measureText(tt).width;
      cctx.fillStyle = p.dir === 'bad' ? COL.s_rej : css('--accent-strong') || INK.accent;
      cctx.font = '700 9px "Noto Sans KR", system-ui, sans-serif';
      cctx.fillText(p.dir === 'bad' ? '↑ 나쁨' : '↑ 좋음', padL + 7 + tw + 8, py0 - 4);
    }
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
      cctx.strokeStyle = CK(it); cctx.globalAlpha = (!anySel || it.sel) ? .55 : .28; cctx.setLineDash([2, 4]); cctx.lineWidth = 1;
      cctx.beginPath(); cctx.moveTo(padL, yy); cctx.lineTo(w - padR, yy); cctx.stroke();
      cctx.setLineDash([]);
      cctx.fillStyle = CK(it); cctx.textAlign = 'left'; cctx.textBaseline = 'bottom';
      cctx.font = '9px "Noto Sans KR", system-ui, sans-serif';
      cctx.fillText(`${it.type} 지속 ${Math.round(it.baseline * 100)}%`, padL + 3, yy - 2);
      cctx.globalAlpha = 1;
    }
    // 유입 (공통) — 회색 점선. 완료 선이 이 선에 붙어 있어야 정상이다
    if (p.showIn) {
      cctx.strokeStyle = COL.s_in; cctx.setLineDash([4, 3]); cctx.lineWidth = 1.5; cctx.beginPath();
      let first = true, fx = 0, fy = 0;
      for (const d of anyH) { if (d.t < t0) continue; const x = X(d.t), yy = Y(d.in);
        if (first) { fx = x; fy = yy; cctx.moveTo(x, yy); } else cctx.lineTo(x, yy); first = false; }
      cctx.stroke(); cctx.setLineDash([]);
      cctx.fillStyle = COL.s_in; cctx.textAlign = 'left'; cctx.textBaseline = 'bottom';
      cctx.font = '700 9px "Noto Sans KR", system-ui, sans-serif';
      cctx.fillText('유입 = 목표', fx + 3, fy - 3);
    }
    // 인스턴스별 실선 — 안 고른 것을 먼저 깔고, 고른 것을 맨 위에. 색 + 선 끝 라벨로 구별한다
    for (const { it, i } of zOrder) {
      const H = hists[i]; if (!H.length) continue;
      cctx.strokeStyle = CK(it); cctx.globalAlpha = CA(it);
      cctx.lineWidth = LW(it); cctx.lineJoin = 'round'; cctx.beginPath();
      let first = true;
      for (const d of H) { if (d.t < t0) continue; const x = X(d.t), yy = Y(p.get(d)); first ? cctx.moveTo(x, yy) : cctx.lineTo(x, yy); first = false; }
      cctx.stroke(); cctx.globalAlpha = 1;
    }
    // 선 끝 이름 라벨 — 어느 선이 누구인지 끝에서 바로 읽는다 (겹치면 세로로 밀어낸다)
    const ends = [];
    for (const { it, i } of zOrder) {
      const H = hists[i]; if (!H.length) continue;
      const d = H[H.length - 1];
      ends.push({ it, x: X(d.t), py: Y(p.get(d)), ly: Y(p.get(d)) });
    }
    ends.sort((a, b) => a.ly - b.ly);
    for (let k = 1; k < ends.length; k++) if (ends[k].ly - ends[k - 1].ly < 10) ends[k].ly = ends[k - 1].ly + 10;
    cctx.textAlign = 'left'; cctx.textBaseline = 'middle';
    for (const e of ends) {
      cctx.globalAlpha = CA(e.it); cctx.fillStyle = CK(e.it);
      cctx.beginPath(); cctx.arc(e.x, e.py, e.it.sel ? 3 : 2.3, 0, 7); cctx.fill();
      cctx.font = `${e.it.sel || !anySel ? 700 : 400} 8.5px "Noto Sans KR", system-ui, sans-serif`;
      cctx.fillText(e.it.type, e.x + 5, e.ly);
      cctx.globalAlpha = 1;
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
      cctx.globalAlpha = (!anySel || it.sel) ? 1 : .55;
      cctx.fillStyle = CK(it); cctx.beginPath(); cctx.arc(x, p.Y(p.get(d)), it.sel ? 3.5 : anySel ? 2.5 : 3, 0, 7); cctx.fill();
      cctx.strokeStyle = '#fff'; cctx.lineWidth = 1.2; cctx.stroke(); cctx.globalAlpha = 1; }
    tip.style.display = 'block';
    tip.innerHTML = `<div class="r"><b>t = ${ref.t.toFixed(0)}s</b><span>유입 ${ref.in}/s</span></div>`
      + list.map((it, i) => { const d = at(hists[i]); return d
        ? `<div class="r"><span><i style="background:${CK(it)};opacity:${(!anySel || it.sel) ? 1 : .35}"></i>`
          + `<b${it.sel ? '' : ' style="font-weight:400"'}>${it.type}</b></span>`
          + `<span>CPU ${Math.round((d.cpU || 0) * 100)}% · 95% 응답 ${fmt(d.p95)}ms · 완료 ${d.out}/s · 실패 ${d.rej + d.to}/s</span></div>` : ''; }).join('');
    tip.style.left = Math.min(x + 12, w - tip.offsetWidth - 8) + 'px'; tip.style.top = '6px';
  } else tip.style.display = 'none';
}
cmpc.addEventListener('mousemove', (e) => { CMPV.hoverX = e.offsetX; });
cmpc.addEventListener('mouseleave', () => { CMPV.hoverX = null; });

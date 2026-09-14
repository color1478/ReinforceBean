/* advisor.js — 파트 2 · 판단
   구획 6~7c: SLO 최소 자원(D4) · 인프라 크기(D5) · 개선안 비교(D6)
              · 실측 검증(C2) · 보정·검증(D7) · 결과 저장(D8)
   engine.js 가 먼저 로드되어야 한다. 엔진 내부에는 손대지 않는다. */
'use strict';
/* =====================================================================
 * 6. SLO 기반 설정 추천 — Erlang C 1차 컷 → 헤드리스 시뮬로 확정 → 최소 비용
 * ===================================================================== */
// 값의 크기를 셀 배경 막대로 함께 보여준다. frac 0~1, tone 은 CSS 색.
function cellBar(frac, text, tone) {
  const w = Math.max(0, Math.min(1, frac)) * 100;
  return `<td style="background:linear-gradient(to right, ${tone} ${w.toFixed(0)}%, transparent ${w.toFixed(0)}%)">${text}</td>`;
}
const TONE_OK = 'var(--accent-soft)', TONE_BAD = 'var(--bad-soft)';
const GRID_T = [8, 16, 24, 32, 48, 64, 96, 128, 200], GRID_C = [2, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60];
// 슬라이더 기준 설정(시나리오가 덮어쓰기 전)을 그대로 담은 cfg — 추천·비교·스윕·보정이 모두 여기서 출발한다.
// 작업 구성(mix)과 부하 의존 계수(α)를 반드시 함께 넘겨야 한다. 안 그러면 "무엇을 처리하는 서버인지"가 빠진 추천이 나온다.
function baseCfg(extra) {
  return Object.assign({
    threads: BASE.threads, conns: BASE.conns, dbTimeMs: BASE.dbTimeMs, cpuTimeMs: MODEL.cpuTimeMs,
    queueCap: BASE.queueCap, timeoutMs: BASE.timeoutMs, retryProb: BASE.retryProb,
    mixOn: BASE.mixOn, mix: BASE.mix, dbLoadAlpha: BASE.dbLoadAlpha || 0, dbLoadGamma: BASE.dbLoadGamma == null ? 2 : BASE.dbLoadGamma, dbScale: 1,
  }, extra || {});
}
// 이 설정에서 기대되는 실효 DB 시간 (작업 구성 가중평균 × 배율)
const baseDbMs = (extra) => effTimes(baseCfg(extra)).db;
// 주어진 피크 rps에서 SLO(p95T, errT)를 만족하는 최소 비용(스레드 + 커넥션×cc) 조합 탐색.
// extra: 비교용으로 항상 실행할 후보 [{t,c,tag}]. onProgress(i, n, cand) 콜백.
async function searchBest(peak, p95T, errT, cc, extra = [], onProgress = null) {
  const base = baseCfg({ rps: peak });
  const cost = (t, c) => t + c * cc;
  const cands = extra.map(e => Object.assign({}, e));
  for (const t of GRID_T) for (const c of GRID_C) {                          // 격자 (Erlang C로 1차 컷)
    const th = theory(Object.assign({}, base, { threads: t, conns: c }));
    if (th.cap < peak * 1.02) continue;                                     // 용량 부족 → 실패 확정
    if (isFinite(th.wq) && th.wq > p95T) continue;                          // 이론 평균대기가 이미 목표 p95 초과
    cands.push({ t, c, tag: '' });
  }
  cands.sort((a, b) => cost(a.t, a.c) - cost(b.t, b.c));
  const results = []; let bestCost = Infinity;
  for (let i = 0; i < cands.length; i++) {
    const cd = cands[i];
    if (onProgress) { onProgress(i, cands.length, cd); if (i % 4 === 0) await new Promise(r => setTimeout(r, 0)); }   // 4개마다 한 번만 양보 (백그라운드 탭의 타이머 스로틀에 걸려 느려지지 않도록)
    if (!cd.tag && cost(cd.t, cd.c) > bestCost) continue;                   // 이미 찾은 최적보다 비싼 격자 후보는 스킵
    const r = runHeadless(Object.assign({}, base, { threads: cd.t, conns: cd.c }), 12, 4);
    const pass = r.p95 <= p95T && r.errRate <= errT;
    if (pass && !cd.tag) bestCost = Math.min(bestCost, cost(cd.t, cd.c));
    results.push(Object.assign({ pass, cost: cost(cd.t, cd.c) }, cd, r));
  }
  const passed = results.filter(r => r.pass && !r.tag).sort((a, b) => a.cost - b.cost || a.p95 - b.p95);
  return { best: passed[0] || null, passed, results };
}
async function recommend() {
  const peak = +$('sloRps').value, p95T = +$('sloP95').value, errT = +$('sloErr').value / 100, cc = +$('sloCost').value;
  const out = $('recoOut'), prog = $('recoProg'); const btn = $('btnRecommend'); btn.disabled = true; prog.style.display = 'block'; prog.value = 0;
  const { best, passed, results } = await searchBest(peak, p95T, errT, cc,
    [{ t: BASE.threads, c: BASE.conns, tag: '현재 설정' }, { t: 200, c: BASE.conns, tag: '스레드만 200 (흔한 오답)' }],
    (i, n, cd) => { prog.value = (i + 1) / n; out.innerHTML = `탐색 중… ${i + 1}/${n} (스레드 ${cd.t}, 커넥션 ${cd.c})`; });
  const cur = results.find(r => r.tag === '현재 설정'), trap = results.find(r => r.tag.startsWith('스레드만'));
  if (best) { LAST_RECO = { t: best.t, c: best.c, rps: peak, p95: best.p95, errRate: best.errRate, brk: best.brk, cost: best.cost };
    CMP.reco = { t: best.t, c: best.c, brk: best.brk }; }
  const maxCost = Math.max(1, ...results.map(r => r.cost));
  const row = (r, cls) => `<tr class="${cls} pick" data-t="${r.t}" data-c="${r.c}"><td>${r.tag || (r === best ? '추천' : '')}</td><td>${r.t}</td><td>${r.c}</td>`
    + cellBar(r.p95 / Math.max(1, p95T), fmt(r.p95), r.p95 <= p95T ? TONE_OK : TONE_BAD)
    + cellBar(r.errRate / Math.max(0.001, errT), (r.errRate * 100).toFixed(1) + '%', r.errRate <= errT ? TONE_OK : TONE_BAD)
    + cellBar(r.cost / maxCost, r.cost.toFixed(0), 'var(--surface-2)') + `</tr>`;
  let html = `<div style="margin-bottom:6px">피크 ${peak}rps에서 p95 ≤ ${p95T}ms, 실패 ≤ ${(errT * 100).toFixed(1)}%</div>`;
  html += `<table class="t"><tr><th></th><th>스레드</th><th>커넥션</th><th>p95</th><th>실패</th><th>비용</th></tr>`;
  if (cur) html += row(cur, cur.pass ? 'pass' : 'fail');
  if (trap) html += row(trap, trap.pass ? 'pass' : 'fail');
  if (best) html += row(best, 'best'); else html += `<tr><td colspan="6">SLO 만족 조합 없음 (실효 DB ${baseDbMs().toFixed(0)}ms)</td></tr>`;
  for (const r of passed.slice(1, 4)) html += row(r, 'pass');
  html += `</table>`;
  out.innerHTML = html; prog.style.display = 'none'; btn.disabled = false; markStep();
  out.querySelectorAll('tr.pick').forEach(tr => tr.addEventListener('click', () => { $('threads').value = tr.dataset.t; $('conns').value = tr.dataset.c; $('threads').dispatchEvent(new Event('input')); $('conns').dispatchEvent(new Event('input')); }));
}
$('btnRecommend').addEventListener('click', () => { openPanel(panelOf('recoOut')); recommend(); });

// 용량 계획표: 트래픽 단계별로 SLO를 만족하는 최소 자원 → "트래픽이 얼마일 때 자원이 얼마 필요한가"
async function capacityTable() {
  const p95T = +$('sloP95').value, errT = +$('sloErr').value / 100, cc = +$('sloCost').value, peak = +$('sloRps').value;
  const step = peak >= 800 ? 200 : 100, levels = []; for (let r = step; r <= Math.max(peak, step) * 1.5 && levels.length < 10; r += step) levels.push(r);
  const out = $('recoOut'), prog = $('recoProg'), btn = $('btnCapacity'); btn.disabled = true; prog.style.display = 'block';
  const rows = [];
  for (let i = 0; i < levels.length; i++) {
    const rps = levels[i]; prog.value = i / levels.length; out.innerHTML = `용량 계획표 계산 중… ${rps}rps (${i + 1}/${levels.length})`;
    const { best } = await searchBest(rps, p95T, errT, cc, [], (j, n) => { prog.value = (i + j / n) / levels.length; });
    rows.push({ rps, best });
  }
  let html = `<div style="margin-bottom:6px">SLO p95 ≤ ${p95T}ms, 실패 ≤ ${(errT * 100).toFixed(1)}% 를 만족하는 <b>최소 자원</b> (실효 DB ${baseDbMs().toFixed(0)}ms · ${BASE.mixOn ? '작업 구성 반영' : '단일 작업'} 기준)</div>`;
  html += `<table class="t"><tr><th>트래픽</th><th>스레드</th><th>커넥션</th><th>비용</th><th>예상 p95</th></tr>`;
  for (const { rps, best } of rows) html += best
    ? `<tr class="pass pick" data-t="${best.t}" data-c="${best.c}"><td>${rps} rps</td><td>${best.t}</td><td>${best.c}</td>`
      + cellBar(best.cost / Math.max(1, ...rows.filter(x => x.best).map(x => x.best.cost)), best.cost.toFixed(0), 'var(--surface-2)')
      + cellBar(best.p95 / Math.max(1, p95T), fmt(best.p95) + ' ms', TONE_OK) + `</tr>`
    : `<tr class="fail"><td>${rps} rps</td><td colspan="4">불가</td></tr>`;
  html += `</table><div class="note">현재 설정: 스레드 ${BASE.threads} / 커넥션 ${BASE.conns} (비용 ${(BASE.threads + BASE.conns * cc).toFixed(0)})</div>`;
  out.innerHTML = html; prog.style.display = 'none'; btn.disabled = false; markStep();
  out.querySelectorAll('tr.pick').forEach(tr => tr.addEventListener('click', () => { $('threads').value = tr.dataset.t; $('conns').value = tr.dataset.c; $('threads').dispatchEvent(new Event('input')); $('conns').dispatchEvent(new Event('input')); }));
}
$('btnCapacity').addEventListener('click', () => { openPanel(panelOf('recoOut')); capacityTable(); });


/* =====================================================================
 * 6b. 인프라 크기 추천 — 스레드/커넥션/rps → vCPU·메모리 추정 → 최소 EC2/RDS
 *   가정(모두 UI에서 조정 가능): 앱은 요청당 CPU ms 만큼만 CPU를 쓰고 나머지는 I/O 대기,
 *   DB는 커넥션당 활성 쿼리 1개가 코어를 (CPU 비율)만큼 점유. 목표 이용률로 나눠 여유 확보.
 *   가격: ap-northeast-2 온디맨드 USD/h 대략치 (2024~25 기준, 반드시 재확인)
 * ===================================================================== */
const EC2 = [ // 앱 서버 후보 (vCPU, GB, $/h)
  ['t3.small', 2, 2, 0.026], ['t3.medium', 2, 4, 0.052], ['t3.large', 2, 8, 0.104], ['c6i.large', 2, 4, 0.096],
  ['m6i.large', 2, 8, 0.118], ['c6i.xlarge', 4, 8, 0.192], ['m6i.xlarge', 4, 16, 0.236], ['c6i.2xlarge', 8, 16, 0.384],
  ['m6i.2xlarge', 8, 32, 0.472], ['c6i.4xlarge', 16, 32, 0.768], ['m6i.4xlarge', 16, 64, 0.944], ['c6i.8xlarge', 32, 64, 1.536] ];
const RDS = [ // RDS PostgreSQL 후보 (vCPU, GB, $/h)  max_connections ≈ GB×1024×1024×1024/9531392 (RDS PG 기본식)
  ['db.t3.medium', 2, 4, 0.082], ['db.t3.large', 2, 8, 0.164], ['db.m6i.large', 2, 8, 0.243], ['db.r6i.large', 2, 16, 0.318],
  ['db.m6i.xlarge', 4, 16, 0.486], ['db.r6i.xlarge', 4, 32, 0.636], ['db.m6i.2xlarge', 8, 32, 0.972], ['db.r6i.2xlarge', 8, 64, 1.272],
  ['db.m6i.4xlarge', 16, 64, 1.944], ['db.r6i.4xlarge', 16, 128, 2.544], ['db.m6i.8xlarge', 32, 128, 3.888] ];
let LAST_RECO = null;   // D4에서 마지막으로 찾은 최적 {t, c, rps}
// 카탈로그: 위 배열은 폴백. data/aws-*.json 을 받아두면 서울 리전 실가격으로 교체된다 (PRICE.src 에 출처 표시).
const PRICE = { ec2: EC2, rds: RDS, src: '내장 대략치 (fetch_public.js 로 실가격 교체 가능)' };
function sizeInfra(t, c, rps) {
  const cpuMs = +$('infCpu').value, dbShare = +$('infDbCpu').value, util = +$('infUtil').value / 100, memT = +$('infMemT').value;
  // 앱: CPU 코어 = rps × (요청당 CPU + 프레임워크 오버헤드 0.3ms) / 1000 / 목표이용률.  메모리 = 기본 1GB + 스레드×memT + 인플라이트 버퍼
  const appCores = rps * (cpuMs + 0.3) / 1000 / util;
  const appMemGB = (1024 + t * memT + rps * 0.2) / 1024;
  // DB: 활성 쿼리 c개가 각각 dbShare 코어. 메모리 = 커넥션당 ~10MB + 캐시 여유(작업셋 미지수 → 최소 4GB 권장)
  const dbCores = c * dbShare / util;
  const dbMemGB = Math.max(4, (c * 10 + 2048) / 1024);
  const pick = (cat, cores, mem) => cat.find(([, v, g]) => v >= Math.ceil(cores) && g >= mem) || null;
  return { appCores, appMemGB, dbCores, dbMemGB, app: pick(PRICE.ec2, appCores, appMemGB), db: pick(PRICE.rds, dbCores, dbMemGB), util };
}
function infraRecommend() {
  const t = LAST_RECO ? LAST_RECO.t : BASE.threads, c = LAST_RECO ? LAST_RECO.c : BASE.conns, rps = LAST_RECO ? LAST_RECO.rps : +$('sloRps').value;
  const r = sizeInfra(t, c, rps), out = $('infraOut');
  const money = (h) => `$${(h * 730).toFixed(0)}/월`;
  const html = [`<div class="kv"><span>피크 <b>${rps} rps</b></span><span>스레드 <b>${t}</b></span><span>커넥션 <b>${c}</b></span><span>${LAST_RECO ? 'D4 추천' : '현재 설정'}</span></div>`];
  html.push(`<table class="t"><tr><th>계층</th><th>인스턴스</th><th>사양</th><th>비용</th></tr>`);
  for (const [label, inst, cores, mem] of [['앱 (EC2)', r.app, r.appCores, r.appMemGB], ['DB (RDS PG)', r.db, r.dbCores, r.dbMemGB]])
    html.push(inst ? `<tr class="pass"><td>${label}</td><td><b>${inst[0]}</b></td><td>${inst[1]} vCPU / ${inst[2]} GB</td><td>${money(inst[3])}</td></tr>`
      : `<tr class="fail"><td>${label}</td><td colspan="3">카탈로그 초과 (${cores.toFixed(1)} vCPU) — 수평 확장 또는 읽기 복제본</td></tr>`);
  if (r.app && r.db) html.push(`<tr><td colspan="3"><b>합계</b></td><td><b>${money(total)}</b></td></tr>`);
  html.push(`</table>`);
  html.push(`<div class="note"><span class="est">추정</span> 가격 ${PRICE.src}`
    + (CALIB ? ` · 보정됨 (오차 ${(CALIB.errBefore * 100).toFixed(0)}%→${(CALIB.errAfter * 100).toFixed(0)}%)` : ' · 보정 전') + `</div>`);
  out.innerHTML = html.join(''); markStep();
}
$('btnInfra').addEventListener('click', () => { openPanel(panelOf('infraOut')); infraRecommend(); });

/* =====================================================================
 * 6c. 개선안 비교 (D6) — "서버를 늘릴 것인가, 설정을 고칠 것인가, 쿼리를 고칠 것인가"
 *   같은 피크 유입 · 같은 작업 구성에서 각 안을 헤드리스 시뮬로 돌려 성능과 비용을 나란히 놓는다.
 *   두 가지를 반드시 반영한다:
 *    ① 자원을 늘리면 병목이 옮겨간다 → 각 안의 「다음 병목」을 함께 표시.
 *    ② 커넥션만 늘리는 것 ≠ DB 증설. 같은 코어에 동시 쿼리를 더 밀어넣으면 경합(α)이 커져
 *       쿼리 자체가 느려진다. 그래서 "설정만으로는 안 되는" 구간이 생긴다.
 * ===================================================================== */
let LAST_CMP = null;
const fmtMs = (v) => v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms';   // fmt()는 1236 → "1.2k" 라서 단위를 붙이면 "1.2kms"가 된다
function planCost(costT, costC, rps) {
  const r = sizeInfra(costT, costC, rps);
  return { usd: ((r.app ? r.app[3] : 0) + (r.db ? r.db[3] : 0)) * 730, app: r.app, db: r.db, ok: !!(r.app && r.db) };
}
// 이 안을 적용했을 때 다음으로 한계에 닿는 자원
function nextBottleneck(cfg, res) {
  const th = theory(cfg);
  if (res.errRate > 0.02 && res.qAvg > cfg.queueCap * 0.4) return '큐 포화 (유입 > 용량)';
  if (Math.max(th.rhoT, th.rhoD) < 0.7) return '없음 (여유 있음)';
  return th.dbBottle ? 'DB 커넥션' : '워커 스레드';
}
function improvementPlans() {
  const t = BASE.threads, c = BASE.conns, q = BASE.queueCap, a = BASE.dbLoadAlpha || 0;
  const c2 = Math.max(c + 1, Math.round(c * 2)), t2 = Math.max(t + 1, Math.round(t * 2)), qs = Math.max(10, Math.round(q / 4));
  const P = [
    { name: '현재 구성', kind: 'base', cfg: {}, costT: t, costC: c,
      why: '기준선. 아래 모든 안을 똑같은 피크 유입·작업 구성·타임아웃에서 돌린 결과다.' },
    { name: `커넥션 ${c} → ${c2} (DB는 그대로)`, kind: 'cfg', cfg: { conns: c2, dbLoadAlpha: a * 2 }, costT: t, costC: c,
      why: `설정 한 줄. 돈은 안 든다. 다만 <b>같은 DB 코어에 동시 쿼리를 2배로 밀어넣으면</b> 경합이 커져 쿼리 자체가 느려진다 (α ${a.toFixed(1)} → ${(a * 2).toFixed(1)}). 효과가 없거나 오히려 나빠지면, 그것이 "설정으로는 안 되고 증설이 필요하다"는 신호다.` },
    { name: `스레드 ${t} → ${t2}`, kind: 'cfg', cfg: { threads: t2 }, costT: t2, costC: c,
      why: '병목이 DB 커넥션이면 아무 효과가 없다 — 늘어난 스레드는 커넥션을 기다리며 놀 뿐이다(② 지연 분해의 주황 구간이 길어진다). 병목이 앞단일 때만 듣는다.' },
    { name: `큐 ${q} → ${qs} + 타임아웃 단축 (빠른 실패)`, kind: 'cfg', cfg: { queueCap: qs, timeoutMs: Math.max(500, Math.min(BASE.timeoutMs, 1000)) }, costT: t, costC: c,
      why: '용량을 늘리는 게 아니라 <b>실패를 빨리 확정</b>한다. 처리량은 안 늘지만 성공한 요청의 p95가 짧아지고 고아 요청이 줄어 재시도 폭풍을 막는다. p95는 좋아지는데 실패율이 오르면 정상 — 어느 쪽을 택할지는 SLO가 정한다.' },
    { name: `DB 인스턴스 증설 (코어 2배 → 커넥션 ${c2})`, kind: 'scale', cfg: { conns: c2 }, costT: t, costC: c2,
      why: `코어가 늘었으므로 동시 쿼리를 2배로 늘려도 경합이 커지지 않는다(α 유지). 위의 「커넥션만 2배」와 성능 차이가 곧 <b>돈으로 사야 하는 부분</b>이다.` },
    { name: `앱 인스턴스 증설 (스레드 ${t2} + CPU 1.7배)`, kind: 'scale', cfg: { threads: t2, cpuTimeMs: MODEL.cpuTimeMs * 0.6 }, costT: t2, costC: c,
      why: '앱은 대부분 I/O 대기라 보통 여기서 얻는 게 적다. 그래도 비교에 넣는 이유는 "앱을 키우면 되겠지"가 가장 흔한 첫 대응이기 때문이다.' },
    { name: 'DB 시간 −30% (쿼리 개선 가정)', kind: 'query', cfg: { dbScale: 0.7 }, costT: t, costC: c,
      why: '인덱스·N+1 제거 등으로 쿼리가 30% 빨라졌다고 <b>가정</b>했을 때의 효과. 이 도구는 쿼리를 고쳐주지 않는다 — "고치면 얼마나 이득인지"를 자원 증설과 같은 저울에 올릴 뿐이다. 비용은 그대로다.' },
    { name: 'DB 시간 −50% (쿼리 개선 가정)', kind: 'query', cfg: { dbScale: 0.5 }, costT: t, costC: c,
      why: '같은 가정의 더 낙관적 버전. 여기서도 목표를 못 맞추면 문제는 쿼리가 아니라 <b>구조(용량)</b>다.' },
  ];
  if (BASE.mixOn) {
    const live = BASE.mix.map((m, i) => ({ m, i })).filter(x => x.m.share > 0);
    if (live.length) {
      // ① 캐시: DB 시간 총량(비율×처리시간)을 가장 많이 먹는 작업을 반으로 — 전체를 30% 줄이는 것보다 대개 싸다
      const load = live.reduce((a, b) => a.m.share * a.m.dbTimeMs >= b.m.share * b.m.dbTimeMs ? a : b);
      P.push({ name: `「${load.m.name}」만 DB −50% (캐시 가정)`, kind: 'query', costT: t, costC: c,
        cfg: { mix: BASE.mix.map((m, i) => i === load.i ? Object.assign({}, m, { dbTimeMs: Math.max(1, Math.round(m.dbTimeMs * 0.5)) }) : m) },
        why: `「${load.m.name}」(비율 ${Math.round(load.m.share * 100)}% × DB ${load.m.dbTimeMs}ms)이 DB 시간 총량에서 가장 큰 몫이다. 전체 쿼리를 30% 빠르게 하는 것보다 <b>이 하나를 캐시하는 편</b>이 보통 싸고 효과가 크다 — 작업 구성을 구분해야 보이는 선택지다.` });
      // ② 구성 변경: 요청 1건이 가장 무거운 작업의 비율을 절반으로, 그만큼을 가장 가벼운 작업으로 옮긴다 (총 유입은 그대로)
      const heavy = live.reduce((a, b) => a.m.dbTimeMs >= b.m.dbTimeMs ? a : b);
      const light = live.reduce((a, b) => a.m.dbTimeMs <= b.m.dbTimeMs ? a : b);
      if (heavy.i !== light.i) {
        const moved = heavy.m.share * 0.5;
        P.push({ name: `「${heavy.m.name}」 비율 ${Math.round(heavy.m.share * 100)}% → ${Math.round(heavy.m.share * 50)}%`, kind: 'query', costT: t, costC: c,
          cfg: { mix: BASE.mix.map((m, i) => i === heavy.i ? Object.assign({}, m, { share: m.share - moved })
                                          : i === light.i ? Object.assign({}, m, { share: m.share + moved }) : m) },
          why: `유입 총량은 그대로인데 가장 무거운 「${heavy.m.name}」(DB ${heavy.m.dbTimeMs}ms)의 <b>비율</b>만 절반으로 줄고 그만큼 「${light.m.name}」로 옮겨간 경우(검색 결과 캐시·기본 정렬 변경·페이지 개편 등). <b>같은 rps인데 구성이 달라지면 필요한 자원이 얼마나 달라지는지</b>를 보여주는 안이다.` });
      }
    }
  }
  return P;
}
async function comparePlans() {
  const peak = +$('sloRps').value, p95T = +$('sloP95').value, errT = +$('sloErr').value / 100;
  const out = $('cmpOut'), prog = $('cmpProg'), btn = $('btnCompare');
  btn.disabled = true; prog.style.display = 'block'; prog.value = 0;
  const plans = improvementPlans(), rows = [];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    prog.value = (i + 1) / plans.length; out.innerHTML = `비교 중… ${i + 1}/${plans.length} — ${p.name}`;
    await new Promise(r => setTimeout(r, 0));
    const cfg = baseCfg(Object.assign({ rps: peak }, p.cfg));
    const res = runHeadless(cfg, 12, 4);
    rows.push(Object.assign({}, p, { res, cfg, pass: res.p95 <= p95T && res.errRate <= errT,
      bottle: nextBottleneck(cfg, res), cost: planCost(p.costT, p.costC, peak) }));
  }
  const cur = rows[0], baseUsd = cur.cost.usd;
  // 목표를 만족하는 안 중 가장 싼 것 (동률이면 p95가 낮은 쪽)
  const winner = rows.slice(1).filter(r => r.pass).sort((a, b) => a.cost.usd - b.cost.usd || a.res.p95 - b.res.p95)[0] || null;
  LAST_CMP = { peak, p95T, errT, rows: rows.map(r => ({ name: r.name, kind: r.kind, pass: r.pass, p95: r.res.p95, p99: r.res.p99, err: r.res.errRate, thr: r.res.thr, bottle: r.bottle, usd: r.cost.usd })), winner: winner ? winner.name : null };
  const money = (u) => `$${Math.round(u)}/월`;
  const delta = (u) => { const d = u - baseUsd; return Math.abs(d) < 1 ? '비용 변화 없음' : (d > 0 ? `+${money(d)}` : `−${money(-d)}`); };
  const html = [`<div style="margin-bottom:8px">피크 <b>${peak} rps</b> · 목표 p95 ≤ ${p95T}ms · 실패 ≤ ${(errT * 100).toFixed(1)}%`
    + (BASE.mixOn ? ` · 작업 구성 <b>${BASE.mix.filter(m => m.share > 0).map(m => `${m.name} ${Math.round(m.share * 100)}%`).join(' / ')}</b>` : ' · 단일 작업') + `</div>`];
  for (const r of rows) {
    const cls = r === winner ? 'pick' : (r.pass ? 'pass' : 'fail');
    html.push(`<div class="plan ${cls}">`
      + `<div class="ph"><span><span class="tag ${r.kind}">${{ base: '기준', cfg: '설정', scale: '증설', query: '가정' }[r.kind]}</span>${r.name}</span>`
      + `<span style="color:${r.pass ? 'var(--blue)' : 'var(--red)'};white-space:nowrap">${r.pass ? '만족' : '미달'}</span></div>`
      + `<div class="pm">p95 <b>${fmtMs(r.res.p95)}</b> · p99 ${fmtMs(r.res.p99)} · 실패 ${(r.res.errRate * 100).toFixed(1)}% · ${r.cost.ok ? money(r.cost.usd) : '초과'}${r.kind === 'base' ? '' : ` (${delta(r.cost.usd)})`} · 병목 ${r.bottle}</div>`
      + `<div class="pw">${r.why}</div></div>`);
  }
  const notes = [];
  if (cur.pass) notes.push(`<b>현재 구성이 이미 목표를 만족한다.</b> 그래도 비교표를 보는 이유는 ① 더 싼 구성이 있는지 ② 트래픽이 더 늘면 무엇이 먼저 막히는지를 알기 위해서다 (현재 다음 병목: ${cur.bottle}).`);
  else if (winner) notes.push(`가장 싸게 목표를 만족하는 안은 <b>「${winner.name}」</b> — p95 ${fmtMs(cur.res.p95)} → ${fmtMs(winner.res.p95)}, ${money(baseUsd)} → ${money(winner.cost.usd)} (${delta(winner.cost.usd)}). 적용 후 병목은 <b>${winner.bottle}</b>로 옮겨간다.`);
  else notes.push(`<b>어느 안도 목표를 만족하지 못했다.</b> 단일 개선으로는 부족하다는 뜻 — D4로 스레드·커넥션을 함께 탐색하거나, 목표 p95를 완화하거나, 피크 자체를 낮춰야(캐시·비동기화) 한다.`);
  const cfgOnly = rows.filter(r => r.kind === 'cfg' && r.pass), scaleOnly = rows.filter(r => r.kind === 'scale' && r.pass);
  if (cfgOnly.length && !scaleOnly.length) notes.push('설정 변경만으로 목표에 도달했다 — <b>돈을 쓸 필요가 없는 상황</b>이다.');
  if (!cfgOnly.length && scaleOnly.length) notes.push('설정으로는 안 되고 <b>증설이 필요한 구간</b>이다. 자원이 실제로 모자란 것이지 설정이 잘못된 게 아니다.');
  if ((BASE.dbLoadAlpha || 0) === 0) notes.push('DB 경합 계수가 <b>α = 0</b>이라 「커넥션만 2배」와 「DB 증설」이 모델상 구분되지 않는다. <b>⑤ 실측 보정</b>을 돌리면 두 안이 갈린다 — 이것이 실측 보정이 필요한 이유다.');
  html.push(`<div class="note">${notes.join('<br><br>')}</div>`);
  html.push(`<div class="note hint">시뮬 12초(워밍업 4초) 기준이라 실행마다 수 % 흔들립니다. 비용은 <span class="est">추정</span>입니다.</div>`);
  out.innerHTML = html.join(''); prog.style.display = 'none'; btn.disabled = false; markStep();
}
$('btnCompare').addEventListener('click', () => { showCmpView('plans'); comparePlans(); });
function showCmpView(v) {
  $('candOut').style.display = v === 'plans' ? 'none' : '';
  $('cmpOut').style.display = v === 'plans' ? '' : 'none';
  $('cmpChips').style.visibility = v === 'plans' ? 'hidden' : '';
  $('candSay').style.display = v === 'plans' ? 'none' : '';
}

/* =====================================================================
 * 6d. 설정 후보 비교 (D9) — "같은 트래픽에서 어느 서버 설정이 나은가"
 *   서버 설정 한 벌을 '후보'로 저장해 두고, 같은 작업 구성(A3)·같은 트래픽에서
 *   rps를 올려가며 각 후보가 몇 rps에서 무너지는지를 나란히 놓는다.
 *    ① 과부하 시작 rps — p95가 목표를 넘거나 실패율이 허용치를 넘는 첫 지점 (구간 선형보간)
 *    ② 피크에서의 p95 · 실패율 · 병목 자원
 *    ③ 그 설정을 감당할 최소 EC2/RDS와 월 비용  ← "어떤 모델을 고를 것인가"의 답
 *   후보는 JSON으로 내보내고 다시 불러올 수 있다 (설정만 담는다 — 결과는 항상 다시 계산).
 * ===================================================================== */
const CAND_COL = ['#1f6feb', '#475569', '#0f766e', '#b45309', '#7c3aed', '#b0201a'];
const CAND = { list: [], seq: 0 };
let LAST_CAND = null;    // 마지막 비교 결과 (리포트·단계 표시에 쓴다)

// 현재 슬라이더 값 한 벌을 후보로 뜬다. 작업 구성(mix)은 후보에 넣지 않는다 —
// "같은 작업을 처리하는 서버들"을 비교해야 설정 차이가 드러나기 때문이다.
function candFromSliders(name) {
  return { id: ++CAND.seq, name: name || '', on: true,
    threads: BASE.threads, conns: BASE.conns, queueCap: BASE.queueCap, dbTimeMs: BASE.dbTimeMs,
    timeoutMs: BASE.timeoutMs, retryProb: BASE.retryProb,
    dbLoadAlpha: BASE.dbLoadAlpha || 0, dbLoadGamma: BASE.dbLoadGamma == null ? 2 : BASE.dbLoadGamma };
}
const candLabel = (c) => c.name || `T${c.threads}·C${c.conns}·Q${c.queueCap}`;
const candColor = (c) => CAND_COL[Math.max(0, CAND.list.indexOf(c)) % CAND_COL.length];
const candCfg = (c, rps) => baseCfg({ rps, threads: c.threads, conns: c.conns, queueCap: c.queueCap,
  dbTimeMs: c.dbTimeMs, timeoutMs: c.timeoutMs, retryProb: c.retryProb,
  dbLoadAlpha: c.dbLoadAlpha, dbLoadGamma: c.dbLoadGamma });

function renderCandList() {
  const el = $('candList');
  el.innerHTML = CAND.list.map((c) => `
    <div class="cand" data-id="${c.id}">
      <input type="checkbox" class="cOn" ${c.on ? 'checked' : ''}>
      <i class="cdot" style="background:${candColor(c)}"></i>
      <input type="text" class="cName" value="${candLabel(c).replace(/"/g, '&quot;')}">
      <span class="cspec" title="클릭하면 이 설정을 슬라이더에 적용">${c.threads}·${c.conns}·${c.queueCap}·${c.dbTimeMs}ms</span>
      <button class="cDel">×</button>
    </div>`).join('');
  const find = (e) => CAND.list.find(c => c.id === +e.target.closest('.cand').dataset.id);
  el.querySelectorAll('.cOn').forEach(b => b.addEventListener('change', (e) => { find(e).on = e.target.checked; syncCandCurves(); if (LAST_CAND) renderCandTable(LAST_CAND); }));
  el.querySelectorAll('.cName').forEach(b => b.addEventListener('input', (e) => { find(e).name = e.target.value; }));
  el.querySelectorAll('.cspec').forEach(b => b.addEventListener('click', (e) => candToSliders(find(e))));
  el.querySelectorAll('.cDel').forEach(b => b.addEventListener('click', (e) => { const c = find(e); CAND.list.splice(CAND.list.indexOf(c), 1); renderCandList(); }));
  renderCandTicks();
}
// 후보를 슬라이더로 되돌린다 → 타임라인(C)에서 이 설정이 실제로 어떻게 도는지 볼 수 있다
function candToSliders(c) {
  const M = { threads: ['threads', 1], conns: ['conns', 1], queueCap: ['qcap', 1], dbTimeMs: ['dbt', 1],
    timeoutMs: ['to', 1], retryProb: ['retry', 100], dbLoadAlpha: ['alpha', 1], dbLoadGamma: ['gamma', 1] };
  for (const k in M) { const [id, mul] = M[k]; $(id).value = c[k] * mul; $(id).dispatchEvent(new Event('input')); }
  main.reset();
  $('candMsg').textContent = `「${candLabel(c)}」 적용됨 — 타임라인에서 확인하세요`;
}
$('btnCandAdd').addEventListener('click', () => { CAND.list.push(candFromSliders()); renderCandList(); markStep(); });
$('btnCandExport').addEventListener('click', () => {
  if (!CAND.list.length) return alert('내보낼 후보가 없습니다');
  const payload = { v: 1, savedAt: new Date().toISOString(),
    workload: { mixOn: BASE.mixOn, mix: BASE.mix.map(m => ({ name: m.name, share: m.share, dbTimeMs: m.dbTimeMs, cpuTimeMs: m.cpuTimeMs })) },
    slo: { peakRps: +$('sloRps').value, p95Ms: +$('sloP95').value, errPct: +$('sloErr').value },
    candidates: CAND.list.map(c => { const d = Object.assign({}, c); delete d.id; delete d.on; d.name = candLabel(c); return d; }) };
  download('reinforcebean-configs.json', JSON.stringify(payload, null, 2), 'application/json');
});
$('btnCandImport').addEventListener('click', () => $('candFile').click());
$('candFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  f.text().then(t => {
    let p; try { p = JSON.parse(t); } catch (err) { return alert('JSON을 읽지 못했습니다: ' + err.message); }
    const arr = Array.isArray(p) ? p : (p.candidates || []);
    if (!arr.length) return alert('candidates 배열이 비어 있습니다');
    for (const c of arr) CAND.list.push(Object.assign(candFromSliders(c.name), c, { id: ++CAND.seq, on: true }));
    if (p.workload && p.workload.mix) {   // 같은 작업 구성에서 비교해야 의미가 있으므로 함께 복원한다
      p.workload.mix.forEach((m, i) => { if (BASE.mix[i]) Object.assign(BASE.mix[i], m); });
      BASE.mixOn = !!p.workload.mixOn; $('mixOn').checked = BASE.mixOn; renderMixRows(); syncMix();
    }
    if (p.slo) { $('sloRps').value = p.slo.peakRps; $('sloP95').value = p.slo.p95Ms; $('sloErr').value = p.slo.errPct; }
    renderCandList(); $('candMsg').textContent = `${arr.length}개 후보를 불러왔습니다`;
  });
  e.target.value = '';
});
// 기본 후보 3벌 — 처음 온 사람이 바로 비교를 눌러볼 수 있게
$('btnCandPreset').addEventListener('click', () => {
  const base = candFromSliders('기준 (현재 설정)');
  CAND.list.push(base);
  CAND.list.push(Object.assign({}, base, { id: ++CAND.seq, name: '커넥션 2배', conns: base.conns * 2 }));
  CAND.list.push(Object.assign({}, base, { id: ++CAND.seq, name: '스레드 2배', threads: Math.min(200, base.threads * 2) }));
  renderCandList(); markStep();
});

// 과부하 시작 rps — SLO를 처음 깨는 지점. 구간 안에서 선형보간해 "선"을 한 숫자로 만든다.
function candKnee(pts, p95T, errT) {
  const bad = (d) => d.p95 > p95T || d.err > errT;
  for (let i = 0; i < pts.length; i++) {
    if (!bad(pts[i])) continue;
    if (i === 0) return pts[0].rps;
    const a = pts[i - 1], b = pts[i];
    if (b.p95 > p95T && a.p95 <= p95T && b.p95 > a.p95)
      return Math.round(a.rps + (b.rps - a.rps) * (p95T - a.p95) / (b.p95 - a.p95));
    return b.rps;
  }
  return null;   // 스윕 전 구간에서 SLO 만족
}

async function compareCands() {
  const on = CAND.list.filter(c => c.on);
  if (!on.length) return alert('비교할 후보를 하나 이상 선택하세요');
  const peak = +$('sloRps').value, p95T = +$('sloP95').value, errT = +$('sloErr').value / 100;
  const levels = [];
  for (let f = 2; f <= 18; f += 2) { const v = Math.max(10, Math.round(peak * f / 10 / 10) * 10); if (levels[levels.length - 1] !== v) levels.push(v); }
  const btn = $('btnCandCmp'), prog = $('candProg'), out = $('candOut');
  btn.disabled = true; prog.style.display = ''; prog.value = 0;
  CANDV.curves = []; CANDV.show = true; CANDV.p95Target = p95T;
  const results = []; let step = 0; const total = on.length * levels.length;
  try {
    for (const c of on) {
      const pts = [], color = candColor(c);
      for (const rps of levels) {
        out.style.padding = '10px'; out.innerHTML = `<div class="note">「${candLabel(c)}」 ${rps} rps 시뮬레이션 중…</div>`;
        prog.value = ++step / total;
        await new Promise(r => setTimeout(r, 0));
        const r = runHeadless(candCfg(c, rps), 8, 3);
        pts.push({ rps, p50: r.p50, p95: r.p95, err: r.errRate, thU: r.thU, coU: r.coU });
      }
      const knee = candKnee(pts, p95T, errT);
      const at = pts.reduce((b, d) => Math.abs(d.rps - peak) < Math.abs(b.rps - peak) ? d : b);
      const th = theory(candCfg(c, peak));
      const inf = sizeInfra(c.threads, c.conns, peak);
      const cost = (inf.app ? inf.app[3] : 0) + (inf.db ? inf.db[3] : 0);
      results.push({ c, color, pts, knee, at, th, inf, cost, ok: at.p95 <= p95T && at.err <= errT });
      CANDV.curves.push({ name: candLabel(c), color, pts, knee });
    }
    LAST_CAND = { peak, p95T, errT, levels, results };
    syncCandCurves(); renderCandTable(LAST_CAND);
  } finally { btn.disabled = false; prog.style.display = 'none'; markStep(); }
}

// ── 표 렌더링 ─────────────────────────────────────────────────────────
//  CDA 비교 표와 같은 구조: 첫 행이 기준, 왼쪽은 입력 파라미터, 오른쪽은 결과 지표.
//  결과 칸은 나쁠수록 빨강이 진해지고, 기준 대비 증감이 작은 글씨로 붙는다.
const CAND_FILTER = { mode: 'all' };
const hm = (a) => a > 0.02 ? `background:rgba(176,32,26,${(a * 0.55).toFixed(3)})` : '';
function dlt(v, base, lowerIsBetter) {
  if (base == null || v == null || !isFinite(base) || base === 0) return '';
  const d = (v - base) / Math.abs(base) * 100;
  if (Math.abs(d) < 0.5) return `<span class="dlt eq">=</span>`;
  const bad = lowerIsBetter ? d > 0 : d < 0;
  return `<span class="dlt ${bad ? 'up' : 'dn'}">${d > 0 ? '+' : ''}${d.toFixed(0)}%</span>`;
}
function candVisible(r) {
  const m = CAND_FILTER.mode;
  return m === 'all' ? true : m === 'pass' ? r.ok : m === 'fail' ? !r.ok : r.c.on;
}
function renderCandTable(R) {
  const out = $('candOut'), money = (h) => Math.round(h * 730);
  const maxRps = R.levels[R.levels.length - 1];
  const base = R.results[0] || null;
  const best = R.results.filter(r => r.ok).sort((a, b) => a.cost - b.cost)[0] || null;
  const rows = R.results.filter(candVisible);
  const H = [];
  H.push('<table class="ctab"><thead><tr>'
    + '<th class="name">후보</th><th>스레드</th><th>커넥션</th><th>큐</th><th>DB</th><th>α</th>'
    + '<th class="sep" title="p95가 목표를 넘거나 실패율이 허용치를 넘는 첫 rps">과부하 시작</th>'
    + '<th>피크 p95</th><th>피크 실패</th><th>병목</th>'
    + '<th class="sep">앱 vCPU</th><th>DB vCPU</th><th>인스턴스</th><th>$/월</th><th>판정</th>'
    + '</tr></thead><tbody>');
  for (const r of rows) {
    const i = R.results.indexOf(r), isBase = i === 0;
    const knee = r.knee == null ? maxRps : r.knee;
    const kneeTxt = r.knee == null ? `&gt; ${maxRps}` : `${r.knee}`;
    // 농도: 피크를 못 버틸수록(과부하 시작이 피크보다 낮을수록) 진하다
    const kneeA = Math.max(0, Math.min(1, (R.peak * 1.3 - knee) / (R.peak * 1.3)));
    const p95A = Math.max(0, Math.min(1, (r.at.p95 - R.p95T * 0.4) / (R.p95T * 1.6)));
    const errA = Math.min(1, r.at.err / Math.max(0.01, R.errT * 4));
    const costA = base ? Math.max(0, Math.min(1, (r.cost - base.cost) / Math.max(0.001, base.cost))) : 0;
    H.push(`<tr class="${isBase ? 'base ' : ''}${r === best ? 'best ' : ''}${r.c.on ? '' : 'off'}" data-i="${i}">`
      + `<td class="name"><span class="tagH" title="비교·차트에 포함">${isBase ? '기' : '<input type="checkbox" class="rOn" style="width:9px;height:9px;margin:0" ' + (r.c.on ? 'checked' : '') + '>'}</span>`
      + `<i class="cdot" style="background:${r.color}"></i>${candLabel(r.c)}</td>`
      + `<td>${r.c.threads}</td><td>${r.c.conns}</td><td>${r.c.queueCap}</td><td>${r.c.dbTimeMs}ms</td><td>${r.c.dbLoadAlpha.toFixed(2)}</td>`
      + `<td class="sep knee big" style="${hm(kneeA)}">${kneeTxt} rps${isBase ? '' : dlt(knee, base ? (base.knee == null ? maxRps : base.knee) : null, false)}</td>`
      + `<td style="${hm(p95A)}">${Math.round(r.at.p95)} ms${isBase ? '' : dlt(r.at.p95, base.at.p95, true)}</td>`
      + `<td style="${hm(errA)}">${(r.at.err * 100).toFixed(1)}%</td>`
      + `<td>${r.th.dbBottle ? 'DB 커넥션' : '스레드/큐'}</td>`
      + `<td class="sep">${r.inf.appCores.toFixed(1)}</td><td>${r.inf.dbCores.toFixed(1)}</td>`
      + `<td style="text-align:left">${r.inf.app && r.inf.db ? `${r.inf.app[0]} + ${r.inf.db[0]}` : '카탈로그 초과'}</td>`
      + `<td class="cost big" style="${hm(costA)}">${r.inf.app && r.inf.db ? '$' + money(r.cost) : '–'}${isBase || !base ? '' : dlt(r.cost, base.cost, true)}</td>`
      + `<td><span class="pill ${r.ok ? 'ok' : 'no'}">${r.ok ? '만족' : '미달'}</span></td></tr>`);
  }
  H.push('</tbody></table>');
  if (!rows.length) H.push('<div class="note" style="padding:10px">이 필터에 해당하는 후보가 없습니다.</div>');
  out.innerHTML = H.join('');
  out.style.padding = '0';
  // 행 클릭 → 그 설정을 슬라이더에 적용 (C 타임라인에서 실제로 돌아가는 모습을 본다)
  out.querySelectorAll('tbody tr').forEach(tr => {
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('rOn')) return;
      candToSliders(R.results[+tr.dataset.i].c);
    });
  });
  out.querySelectorAll('.rOn').forEach(cb => cb.addEventListener('change', (e) => {
    e.stopPropagation();
    R.results[+e.target.closest('tr').dataset.i].c.on = e.target.checked;
    syncCandCurves(); renderCandList(); renderCandTable(R);
  }));
  $('cmpCount').textContent = `${CAND.list.length}벌`;
  $('candSay').innerHTML = candSay(R, best);
}
// 결론 — 라벨·값 나열 한 줄.
function candSay(R, best) {
  if (!best) return `<b style="color:var(--bad)">SLO 만족 후보 없음</b> · 피크 ${R.peak}rps`;
  const inst = best.inf.app && best.inf.db ? `${best.inf.app[0]} + ${best.inf.db[0]}` : '카탈로그 초과';
  const P = (k, x) => `<span style="color:var(--muted)">${k}</span> <b>${x}</b>`;
  return [P('추천', candLabel(best.c)), P('과부하', best.knee == null ? '구간 밖' : best.knee + ' rps'),
    P('피크 p95', Math.round(best.at.p95) + ' ms'), P('인스턴스', inst), P('비용', '$' + Math.round(best.cost * 730) + '/월'),
    `<span class="est">추정</span>${CALIB ? '' : ' · 보정 전'}`].join(' <span style="color:var(--border-strong)">|</span> ');
}
// 체크 상태에 맞춰 C2 곡선과 D9b 산점도를 다시 채운다
function syncCandCurves() {
  if (!LAST_CAND) return;
  const on = LAST_CAND.results.filter(r => r.c.on);
  CANDV.curves = on.map(r => ({ name: candLabel(r.c), color: r.color, pts: r.pts, knee: r.knee, at: r.at }));
  CANDV.show = CANDV.curves.length > 0;
  CANDV.p95Target = LAST_CAND.p95T;
  CANDV.peak = LAST_CAND.peak;
}
// ── 슬라이더 아래 후보 위치 눈금 — "지금 이 값이 다른 후보 대비 어디쯤인가" ──
const TICK_OF = { threads: 'threads', conns: 'conns', qcap: 'queueCap', dbt: 'dbTimeMs' };
function renderCandTicks() {
  for (const id in TICK_OF) {
    const el = $(id); if (!el) continue;
    let box = el.parentNode.querySelector('.ticks');
    if (!box) { box = document.createElement('div'); box.className = 'ticks'; el.parentNode.insertBefore(box, el.nextSibling); }
    const mn = +el.min, mx = +el.max, key = TICK_OF[id];
    box.innerHTML = CAND.list.map(c => {
      const p = Math.max(0, Math.min(100, (c[key] - mn) / (mx - mn) * 100));
      return `<i style="left:${p}%;background:${candColor(c)}" title="${candLabel(c)} — ${c[key]}"></i>`;
    }).join('');
  }
}
$('cmpChips').addEventListener('click', (e) => {
  const b = e.target.closest('.chip'); if (!b) return;
  CAND_FILTER.mode = b.dataset.filter;
  $('cmpChips').querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
  if (LAST_CAND) renderCandTable(LAST_CAND);
});
$('btnCandCmp').addEventListener('click', () => { showCmpView('cand'); compareCands(); });
$('btnCandClear').addEventListener('click', () => {
  CANDV.curves = []; CANDV.show = false; CANDV.peak = 0;
  $('candMsg').textContent = '차트에서 후보 곡선을 숨겼습니다';
});
renderCandList();

/* =====================================================================
 * 7. 실측 검증 — CSV 불러오기 / 같은 rps로 시뮬 스윕 / 내보내기
 * ===================================================================== */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  const head = lines[0].toLowerCase().split(',').map(s => s.trim()); const idx = (k) => head.indexOf(k);
  const rows = []; for (const l of lines.slice(1)) { const c = l.split(','); if (c.length < 3) continue;
    rows.push({ rps: +c[idx('rps')], p50: +c[idx('p50')] || 0, p95: +c[idx('p95')], p99: idx('p99') >= 0 ? +c[idx('p99')] || 0 : 0, err: +(c[idx('err_rate')] ?? 0) || 0 }); }
  return rows.filter(r => isFinite(r.rps) && isFinite(r.p95));
}
$('btnLoadCsv').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { VERIFY.real = parseCsv(t); $('verifyMsg').textContent = `실측 ${VERIFY.real.length}점 로드 (${f.name})`;
    applyAutoSplit(false);   // 불러오자마자 보정/검증 구간을 잡아 준다
    const near = VERIFY.real.reduce((b, d) => Math.abs(d.rps - MODEL.rps) < Math.abs(b.rps - MODEL.rps) ? d : b);
    CMP.ref = { name: `실측 ${near.rps}rps`, p50: near.p50 };   // ② 지연 분해에 실측 막대 추가
  }); });
$('btnSweep').addEventListener('click', async () => {
  const levels = VERIFY.real.length ? VERIFY.real.map(r => r.rps) : [50, 100, 150, 200, 250, 300, 330, 360, 400];
  VERIFY.sim = []; const btn = $('btnSweep'); btn.disabled = true;
  for (const rps of levels) { $('verifyMsg').textContent = `시뮬 스윕 ${rps}rps…`; await new Promise(r => setTimeout(r, 0));
    const r = runHeadless(baseCfg({ rps, retryProb: 0, cpuTimeMs: 0 }), 15, 5);   // cpu 0 = 검증 서버 기본값과 동일
    VERIFY.sim.push({ rps, p50: r.p50, p95: r.p95, err: r.errRate }); }
  $('verifyMsg').textContent = `시뮬 스윕 완료 (스레드 ${BASE.threads}, 커넥션 ${BASE.conns}, 실효 DB ${baseDbMs().toFixed(0)}ms, α=${(BASE.dbLoadAlpha||0).toFixed(2)}, γ=${BASE.dbLoadGamma}) — 실제 서버도 같은 값으로 띄웠는지 확인`; btn.disabled = false;
});
$('btnExportSweep').addEventListener('click', () => {
  if (!VERIFY.sim.length) return alert('먼저 시뮬 스윕을 실행하세요');
  const csv = 'rps,p50,p95,err_rate\n' + VERIFY.sim.map(r => `${r.rps},${r.p50.toFixed(1)},${r.p95.toFixed(1)},${r.err.toFixed(4)}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `reinforcebean_sim_t${BASE.threads}_c${BASE.conns}_db${baseDbMs().toFixed(0)}.csv`; a.click();
});
// (탭 없음: 타임라인과 검증 차트를 항상 함께 표시)

/* =====================================================================
 * 7b. 모델 보정 · 예측 검증 (D7)
 *   실측 CSV의 *일부* rps로만 파라미터를 맞추고(fit), 맞추는 데 쓰지 않은 rps(holdout)에서
 *   예측이 실제로 맞는지 확인한다. 보정에 쓴 점에서 잘 맞는 건 당연하므로 증거가 되지 못한다.
 *
 *   맞추는 파라미터는 두 개뿐이다 (물리적 의미가 있는 것만):
 *     dbScale — 명목 DB 시간 대비 실제 배율 (단독 벤치마크는 부하 아래서 거짓말을 한다)
 *     α       — 부하 의존 계수. 커넥션이 전부 붐빌 때 쿼리가 (1+α)배 느려진다
 * ===================================================================== */
let CALIB = null;
const parseLevels = (s) => String(s).split(/[,\s]+/).map(Number).filter(v => isFinite(v) && v > 0);
const relErr = (a, b) => Math.abs(a - b) / Math.max(1, b);
// 검증 서버와 같은 조건으로 맞춘 cfg (앱 CPU 0, 재시도 없음 — load.js/server.js 기본값)
const verifyCfg = (extra) => baseCfg(Object.assign({ retryProb: 0, cpuTimeMs: 0 }, extra));
const GAMMAS = [1, 2, 4, 6, 8, 12, 16, 24];

// 보정/검증 구간 자동 분할.
//   맞출 파라미터가 3개(기본 시간·감속률 α·시작점 γ)이므로, 서로 다른 상태의 점들이 필요하다:
//     한산한 점 2개 → 기본 DB 시간 (경합이 없어야 순수하게 잰다)
//     무릎 직전    → γ(언제부터 느려지나). 여기가 빠지면 γ가 제멋대로 잡힌다
//     가장 높은 점 → α와 용량 한계
//   나머지는 전부 holdout 으로 돌려 예측력을 검증한다.
function autoSplit() {
  const R = VERIFY.real.slice().filter(d => d.p95 > 0).sort((a, b) => a.rps - b.rps);
  if (R.length < 3) return null;
  const kneeIdx = R.findIndex(d => d.err > 0.02);
  const preKnee = kneeIdx > 0 ? R[kneeIdx - 1] : R[Math.max(0, Math.floor(R.length * 0.6))];
  const low = R.slice(0, Math.min(2, R.length));
  const fit = [...new Set([...low.map(d => d.rps), preKnee.rps, R[R.length - 1].rps])];
  const hold = R.filter(d => !fit.includes(d.rps)).map(d => d.rps);
  return { fit, hold, knee: kneeIdx > 0 ? R[kneeIdx].rps : null };
}
function applyAutoSplit(silent) {
  const a = autoSplit();
  if (!a) { if (!silent) $('calibOut').innerHTML = '먼저 실측 CSV를 불러오세요.'; return null; }
  $('fitLv').value = a.fit.join(','); $('hodLv').value = a.hold.join(',');
  if (!silent) $('calibOut').innerHTML = `보정 <b>${a.fit.join(', ')}</b> rps`
    + (a.knee ? ` · 무릎 <b>${a.knee} rps</b>` : '')
    + ` · 검증 <b>${a.hold.join(', ')}</b> rps`;
  return a;
}
$('btnAutoSplit').addEventListener('click', () => applyAutoSplit(false));

// 파라미터마다 "그것이 드러나는 구간"에서 따로 잰다. 한 격자에서 셋을 동시에 맞추면
// scale과 γ가 서로를 상쇄해(느린 쿼리 + 늦은 감속 ≈ 빠른 쿼리 + 이른 감속) 실행할 때마다 값이 튄다.
//
//   dbScale ← 한산한 구간.  경합이 없으므로 p95가 서비스 시간에 거의 비례한다 → 비율로 직접 수렴시킨다.
//   γ       ← 무릎 구간.    "언제부터 느려지나"는 커넥션이 차기 시작하는 구간에서만 관측된다.
//   α       ← 서버가 직접 측정 (전 커넥션 동시 실행 감속률). 부하 곡선에서 추정할 수도 있지만 덜 정확하다.
const relScore = (r, p) => relErr(r.p95, p.p95) + 2 * Math.abs(r.errRate - p.err);
const simP95 = (rps, scale, alpha, gamma, rep, dur, warm) => {
  let t = 0; for (let k = 0; k < rep; k++) t += runHeadless(verifyCfg({ rps, dbScale: scale, dbLoadAlpha: alpha, dbLoadGamma: gamma }), dur, warm).p95;
  return t / rep;
};
// ① 한산한 점들의 실측 p95 / 시뮬 p95 비율로 배율을 수렴시킨다 (저부하 시뮬은 1~3ms라 반복이 사실상 무료)
function fitScale(lowPts) {
  let s = 1;
  for (let it = 0; it < 4; it++) {
    let ratio = 0;
    for (const p of lowPts) ratio += (p.p95 / Math.max(1, simP95(p.rps, s, 0, 1, 10, 25, 5))) / lowPts.length;
    s *= ratio;
  }
  return Math.min(4, Math.max(0.2, +s.toFixed(3)));
}
// ② 배율·α를 고정하고 γ만 (α 추정 모드면 α와 함께) 무릎 구간에서 찾는다
function fitShape(kneePts, scale, alphas) {
  let best = null; const all = [];
  for (const a of alphas) for (const g of GAMMAS) {
    let e = 0;
    for (const p of kneePts) for (let k = 0; k < 3; k++) e += relScore(runHeadless(verifyCfg({ rps: p.rps, dbScale: scale, dbLoadAlpha: a, dbLoadGamma: g }), 15, 4), p) / 3;
    e /= Math.max(1, kneePts.length);
    all.push({ alpha: a, gamma: g, err: e });
    if (!best || e < best.err) best = { alpha: a, gamma: g, err: e };
  }
  return { best, all };
}

async function calibrate() {
  const out = $('calibOut'), prog = $('calibProg'), btn = $('btnCalib');
  if (!VERIFY.real.length) { out.innerHTML = '먼저 실측 CSV를 불러오세요 (위 「실측 CSV」). 서버가 없으면 <code>validation/sample_result.csv</code> 로도 됩니다.'; return; }
  const fitL = parseLevels($('fitLv').value), hodL = parseLevels($('hodLv').value);
  const near = (lv) => lv.map(v => VERIFY.real.reduce((b, d) => Math.abs(d.rps - v) < Math.abs(b.rps - v) ? d : b, VERIFY.real[0]))
                         .filter((d, i, a) => a.indexOf(d) === i && d.p95 > 0);
  const fitP = near(fitL), hodP = near(hodL).filter(d => !fitP.includes(d));
  if (!fitP.length) { out.innerHTML = '보정에 쓸 rps가 실측 데이터에 없습니다.'; return; }
  const fixAlpha = !$('fitAlpha').checked, srvAlpha = Math.max(0, +$('calibAlpha').value || 0);
  btn.disabled = true; prog.style.display = 'block'; prog.value = 0;

  // 보정 점을 "한산" / "무릎 이후"로 나눈다 — 실측 p95가 최저치의 1.5배를 넘으면 이미 줄을 서고 있는 것
  const floor = Math.min(...VERIFY.real.filter(d => d.p95 > 0).map(d => d.p95));
  let lowPts = fitP.filter(d => d.p95 <= floor * 1.5 && d.err < 0.02);
  let kneePts = fitP.filter(d => !lowPts.includes(d));
  if (!lowPts.length) lowPts = [fitP.reduce((a, b) => a.rps < b.rps ? a : b)];
  if (!kneePts.length) kneePts = [fitP.reduce((a, b) => a.rps > b.rps ? a : b)];

  out.innerHTML = `① 한산 구간(${lowPts.map(p => p.rps).join(', ')} rps)에서 기본 DB 시간을 재는 중…`;
  await new Promise(r => setTimeout(r, 0));
  const scale = fitScale(lowPts);
  prog.value = 0.4;

  out.innerHTML = `② 무릎 구간(${kneePts.map(p => p.rps).join(', ')} rps)에서 ${fixAlpha ? '느려지기 시작하는 지점' : '감속률과 시작점'}을 찾는 중…`;
  await new Promise(r => setTimeout(r, 0));
  const shape = fitShape(kneePts, scale, fixAlpha ? [srvAlpha] : [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1.0]);
  const fine = { scale, alpha: shape.best.alpha, gamma: shape.best.gamma, err: shape.best.err };
  const tied = shape.all.filter(x => x.err <= fine.err * 1.25 + 0.03);
  const aLo = Math.min(...tied.map(x => x.alpha)), aHi = Math.max(...tied.map(x => x.alpha));
  const gLo = Math.min(...tied.map(x => x.gamma)), gHi = Math.max(...tied.map(x => x.gamma));
  const fitRho = Math.max(...fitP.map(p => { const t = theory(verifyCfg({ rps: p.rps })); return Math.max(t.rhoT, t.rhoD); }));
  prog.value = 0.7;

  // ── holdout 검증: 보정 전(경합 무시) vs 보정 후. 무릎 근처는 한 번만 재면 편차가 크므로 5회 평균 ──
  out.innerHTML = `③ 보정에 쓰지 않은 ${hodP.length}개 rps에서 예측을 검증하는 중…`;
  await new Promise(r => setTimeout(r, 0));
  const nomDb = baseDbMs(), rows = [];
  let eBefore = 0, eAfter = 0;
  for (const p of hodP) {
    const b = simP95(p.rps, 1, 0, 1, 5, 15, 5), a = simP95(p.rps, scale, fine.alpha, fine.gamma, 5, 15, 5);
    eBefore += relErr(b, p.p95); eAfter += relErr(a, p.p95);
    rows.push({ rps: p.rps, real: p.p95, before: b, after: a });
  }
  const nH = Math.max(1, hodP.length); eBefore /= nH; eAfter /= nH;
  CALIB = { scale, alpha: fine.alpha, gamma: fine.gamma, alphaLo: aLo, alphaHi: aHi, gammaLo: gLo, gammaHi: gHi,
            alphaFixed: fixAlpha, fitErr: fine.err, fitRps: fitP.map(p => p.rps), lowRps: lowPts.map(p => p.rps), kneeRps: kneePts.map(p => p.rps),
            holdRps: hodP.map(p => p.rps), errBefore: eBefore, errAfter: eAfter, dbNom: nomDb, dbCal: nomDb * scale, rows };

  const html = [`<div style="margin-bottom:6px"><b>보정 결과</b><br>`
    + `한산할 때 DB 시간 <b>${(nomDb * scale).toFixed(0)} ms</b> <span style="color:var(--muted)">(설정 ${nomDb.toFixed(0)}ms × ${scale.toFixed(2)} — ${lowPts.map(p => p.rps).join('/')} rps에서)</span><br>`
    + `커넥션이 꽉 찼을 때 <b>${(nomDb * scale * (1 + fine.alpha)).toFixed(0)} ms</b> <span style="color:var(--muted)">(α ${fine.alpha.toFixed(2)}${fixAlpha ? ' — 서버 직접 측정값' : `, 구분 안 되는 범위 ${aLo.toFixed(2)}~${aHi.toFixed(2)}`})</span><br>`
    + `느려지기 시작하는 지점 <b>γ = ${fine.gamma}</b> <span style="color:var(--muted)">(${kneePts.map(p => p.rps).join('/')} rps에서${gLo !== gHi ? `, 범위 ${gLo}~${gHi}` : ''})</span></div>`];
  const occ = (u) => `${Math.round(u * 100)}% → <b>${(nomDb * scale * (1 + fine.alpha * Math.pow(u, fine.gamma))).toFixed(0)}ms</b>`;
  html.push(`<div class="note" style="margin-top:0"><b>커넥션 점유율별 쿼리 시간</b><br>${occ(0.25)} · ${occ(0.5)} · ${occ(0.8)} · ${occ(0.95)} · ${occ(1)}</div>`);
  if (!hodP.length) html.push(`<div style="color:var(--red)">검증용 rps 없음</div>`);
  else {
    html.push(`<table class="t"><tr><th>rps (미보정 구간)</th><th>실측 p95</th><th>보정 전</th><th>보정 후</th></tr>`);
    for (const r of rows) {
      const eb = relErr(r.before, r.real), ea = relErr(r.after, r.real);
      html.push(`<tr><td>${r.rps}</td><td>${Math.round(r.real)} ms</td>`
        + cellBar(eb / 0.5, `<span style="color:var(--muted)">${Math.round(r.before)} <small>(${(eb * 100).toFixed(0)}%)</small></span>`, TONE_BAD)
        + cellBar(ea / 0.5, `<b>${Math.round(r.after)}</b> <small>(${(ea * 100).toFixed(0)}%)</small>`, ea < eb ? TONE_OK : TONE_BAD) + `</tr>`);
    }
    html.push(`</table>`);
    const better = eAfter < eBefore;
    html.push(`<div class="note" style="color:${better ? 'var(--ink)' : 'var(--red)'}"><b>holdout 평균 상대오차 ${(eBefore * 100).toFixed(0)}% → ${(eAfter * 100).toFixed(0)}%</b></div>`);
  }
  if (fitRho < 0.75 || kneePts.every(p => p.err < 0.01)) html.push(`<div class="note" style="color:var(--orange)">보정 구간 한산 (최대 ρ ≈ ${fitRho.toFixed(2)}) — α·γ 미결정</div>`);
  if (!fixAlpha && aHi - aLo > 0.3) html.push(`<div class="note" style="color:var(--orange)">α ${aLo.toFixed(2)}~${aHi.toFixed(2)} 구분 불가</div>`);
  html.push(`<div class="row" style="margin-top:6px"><button class="primary" id="btnApplyCalib">보정값 적용</button><button id="btnCalibSweep">보정값으로 C2 스윕</button></div>`);
  out.innerHTML = html.join(''); prog.style.display = 'none'; btn.disabled = false;
  $('btnApplyCalib').addEventListener('click', () => { applyCalib(); markStep(); });
  $('btnCalibSweep').addEventListener('click', () => { applyCalib(); markStep(); $('btnSweep').click(); });
  markStep();
}
// 보정값을 실제 슬라이더/작업 구성에 반영 — 이후 D4·D6·D5가 전부 보정된 값으로 계산된다
function applyCalib() {
  if (!CALIB) return;
  $('alpha').value = CALIB.alpha.toFixed(2); $('alpha').dispatchEvent(new Event('input'));
  $('gamma').value = CALIB.gamma; $('gamma').dispatchEvent(new Event('input'));
  if (BASE.mixOn) { BASE.mix.forEach(m => { m.dbTimeMs = Math.max(1, Math.round(m.dbTimeMs * CALIB.scale)); }); renderMixRows(); syncMix(); }
  else { $('dbt').value = Math.max(5, Math.round(BASE.dbTimeMs * CALIB.scale)); $('dbt').dispatchEvent(new Event('input')); }
  CALIB.scale = 1;   // 이미 반영했으므로 두 번 적용되지 않도록
  $('verifyMsg').textContent = '보정값 적용됨 — D4/D6/D5가 이 값으로 다시 계산됩니다';
}
$('btnCalib').addEventListener('click', () => { openPanel(panelOf('calibOut')); calibrate(); });
$('btnLoadCsv2').addEventListener('click', () => $('csvFile').click());

/* =====================================================================
 * 7c. 결과 저장 (D8) — 조건 → 비교 → 검증 → 추천을 한 파일로
 *   "무엇을 가정했고 무엇을 실측했으며 어디까지가 추정인가"를 반드시 함께 남긴다.
 *   이게 없으면 며칠 뒤의 자신도, 발표를 듣는 사람도 숫자를 믿을 근거가 없다.
 * ===================================================================== */
function reportData() {
  const th = theory(baseCfg({ rps: +$('sloRps').value })), b = detectBottleneck(main.S, MODEL);
  const t = LAST_RECO ? LAST_RECO.t : BASE.threads, c = LAST_RECO ? LAST_RECO.c : BASE.conns, peak = LAST_RECO ? LAST_RECO.rps : +$('sloRps').value;
  const inf = sizeInfra(t, c, peak);
  return {
    generatedAt: new Date().toISOString(),
    조건: {
      피크유입rps: peak,
      피크출처: DATA.cur ? `${DATA.cur.name} 곡선 피크/평균 ${DATA.cur.peakToMean}배 × 평균 ${$('avgRps').value}rps` : '직접 입력',
      작업구성: BASE.mixOn ? BASE.mix.filter(m => m.share > 0).map(m => ({ 작업: m.name, 비율: +(m.share * 100).toFixed(0), DBms: m.dbTimeMs, 앱CPUms: m.cpuTimeMs })) : '단일 평균 작업',
      실효DBms: +th.dbNomMs.toFixed(1), 부하의존α: BASE.dbLoadAlpha || 0, 부하의존γ: BASE.dbLoadGamma, 이부하에서실효DBms: +th.dbEffMs.toFixed(1),
      서버설정: { 스레드: BASE.threads, 커넥션: BASE.conns, 큐: BASE.queueCap, 타임아웃ms: BASE.timeoutMs, 재시도확률: BASE.retryProb, 취소전파: !!BASE.cancelOnTimeout },
      SLO: { p95ms: +$('sloP95').value, 실패율: +$('sloErr').value / 100 },
    },
    현재병목: { 판정: b.title, 설명: b.desc.replace(/<[^>]+>/g, ''), ρ스레드: +th.rhoT.toFixed(2), ρDB: +th.rhoD.toFixed(2), 이론최대rps: Math.round(th.cap) },
    설정후보비교_D9: LAST_CAND ? {
      피크rps: LAST_CAND.peak, 목표p95ms: LAST_CAND.p95T, 허용실패율: LAST_CAND.errT, 스윕rps: LAST_CAND.levels,
      후보: LAST_CAND.results.map(r => ({
        이름: candLabel(r.c), 스레드: r.c.threads, 커넥션: r.c.conns, 큐: r.c.queueCap, DBms: r.c.dbTimeMs,
        과부하시작rps: r.knee, 피크p95ms: Math.round(r.at.p95), 피크실패율: +r.at.err.toFixed(4),
        병목: r.th.dbBottle ? 'DB 커넥션' : '스레드/큐', SLO만족: r.ok,
        인스턴스: r.inf.app && r.inf.db ? `${r.inf.app[0]} + ${r.inf.db[0]}` : null, usd월: Math.round(r.cost * 730),
        곡선: r.pts.map(p => ({ rps: p.rps, p95: Math.round(p.p95), err: +p.err.toFixed(4) })),
      })),
    } : null,
    추천설정_D4: LAST_RECO ? { 스레드: LAST_RECO.t, 커넥션: LAST_RECO.c, 예상p95ms: Math.round(LAST_RECO.p95), 예상실패율: +LAST_RECO.errRate.toFixed(4) } : null,
    개선안비교_D6: LAST_CMP,
    보정검증_D7: CALIB ? { 보정에쓴rps: CALIB.fitRps, 검증rps: CALIB.holdRps, DB명목ms: +CALIB.dbNom.toFixed(1), DB보정ms: +CALIB.dbCal.toFixed(1), α: CALIB.alpha,
      α: CALIB.alpha, γ: CALIB.gamma, α고정_서버실측: CALIB.alphaFixed,
      holdout오차_보정전: +(CALIB.errBefore * 100).toFixed(1), holdout오차_보정후: +(CALIB.errAfter * 100).toFixed(1), 점별: CALIB.rows } : null,
    인프라추천_D5_추정: { 앱: inf.app ? { 인스턴스: inf.app[0], vCPU: inf.app[1], GB: inf.app[2], usd월: Math.round(inf.app[3] * 730) } : null,
      DB: inf.db ? { 인스턴스: inf.db[0], vCPU: inf.db[1], GB: inf.db[2], usd월: Math.round(inf.db[3] * 730) } : null,
      필요vCPU: { 앱: +inf.appCores.toFixed(2), DB: +inf.dbCores.toFixed(2) }, 가격출처: PRICE.src },
    한계: [
      '인스턴스 추천은 모델 기반 추정값이며 해당 EC2/RDS에서 직접 측정하지 않았다 (CPU 세대·아키텍처·EBS/네트워크 미반영).',
      '보정 파라미터는 측정에 사용한 로컬 검증 서버에 대한 값이다.',
      'DB 시간 감소 항목은 쿼리 개선 효과를 가정한 what-if이며, 이 도구가 쿼리를 고쳐주지는 않는다.',
      'IOPS·Multi-AZ·읽기 복제본·오토스케일링은 고려하지 않는다.',
    ],
  };
}
function reportMarkdown() {
  const d = reportData(), L = [];
  const pct1 = (v) => (v * 100).toFixed(1) + '%';
  L.push(`# ReinforceBean 용량 계획 리포트`, ``, `생성: ${d.generatedAt}`, ``);
  L.push(`## 1. 서비스 조건`, ``);
  L.push(`- 피크 유입: **${d.조건.피크유입rps} rps** (${d.조건.피크출처})`);
  L.push(Array.isArray(d.조건.작업구성)
    ? `- 작업 구성: ${d.조건.작업구성.map(m => `${m.작업} ${m.비율}% (DB ${m.DBms}ms)`).join(' · ')}`
    : `- 작업 구성: 단일 평균 작업 (유형 구분 꺼짐)`);
  L.push(`- 실효 DB 시간: ${d.조건.실효DBms} ms · 부하 의존 α = ${d.조건.부하의존α}, γ = ${d.조건.부하의존γ} → 이 부하에서 실효 ${d.조건.이부하에서실효DBms} ms`);
  const s = d.조건.서버설정;
  L.push(`- 서버 설정: 스레드 ${s.스레드} / 커넥션 ${s.커넥션} / 큐 ${s.큐} / 타임아웃 ${s.타임아웃ms}ms / 재시도 ${pct1(s.재시도확률)} / 취소 전파 ${s.취소전파 ? '켬' : '끔'}`);
  L.push(`- SLO: p95 ≤ ${d.조건.SLO.p95ms}ms, 실패 ≤ ${pct1(d.조건.SLO.실패율)}`, ``);
  L.push(`## 2. 현재 병목`, ``, `**${d.현재병목.판정}** — ${d.현재병목.설명}`, ``,
    `이론 ρ: 스레드 ${d.현재병목.ρ스레드} · DB ${d.현재병목.ρDB} · 이론 최대 ${d.현재병목.이론최대rps} rps`, ``);
  L.push(`## 3. 설정 후보 비교 — 어느 설정이 나은가 (D9)`, ``);
  if (d.설정후보비교_D9) {
    const K = d.설정후보비교_D9;
    L.push(`같은 트래픽(피크 ${K.피크rps} rps)·같은 작업 구성에서 각 설정이 몇 rps에서 SLO(p95 ≤ ${K.목표p95ms}ms, 실패 ≤ ${pct1(K.허용실패율)})를 깨는가.`, ``);
    L.push(`| 후보 | 설정 | 과부하 시작 | 피크 p95 | 피크 실패 | 병목 | 인스턴스(추정) | 월 비용 |`, `|---|---|---|---|---|---|---|---|`);
    for (const r of K.후보)
      L.push(`| ${r.이름} | T${r.스레드}·C${r.커넥션}·Q${r.큐} | ${r.과부하시작rps == null ? '구간 밖' : r.과부하시작rps + ' rps'} | ${r.피크p95ms}ms | ${pct1(r.피크실패율)} | ${r.병목} | ${r.인스턴스 || '카탈로그 초과'} | $${r.usd월} |`);
    const ok = K.후보.filter(r => r.SLO만족).sort((x, y) => x.usd월 - y.usd월)[0];
    L.push(``, ok ? `**결론: 「${ok.이름}」** — 피크 ${K.피크rps}rps를 SLO 안에서 버티는 것 중 가장 싸다 (과부하 시작 ${ok.과부하시작rps == null ? '스윕 구간 밖' : ok.과부하시작rps + ' rps'} · ${ok.인스턴스 || '카탈로그 초과'} · $${ok.usd월}/월).`
      : `**결론: 어느 후보도 피크 ${K.피크rps}rps에서 SLO를 만족하지 못한다.**`, ``);
  } else L.push(`_아직 실행하지 않음 (D9 「같은 트래픽에서 비교」)_`, ``);
  L.push(`## 4. SLO 기반 최소 자원 (D4)`, ``);
  L.push(d.추천설정_D4 ? `스레드 **${d.추천설정_D4.스레드}** / 커넥션 **${d.추천설정_D4.커넥션}** — 시뮬 p95 ${d.추천설정_D4.예상p95ms}ms, 실패 ${pct1(d.추천설정_D4.예상실패율)}` : `_아직 실행하지 않음 (D4 「최소 자원 찾기」)_`, ``);
  L.push(`## 5. 개선안 비교 — 증설 vs 설정 (D6)`, ``);
  if (d.개선안비교_D6) {
    L.push(`피크 ${d.개선안비교_D6.peak} rps · 목표 p95 ≤ ${d.개선안비교_D6.p95T}ms`, ``);
    L.push(`| 종류 | 개선안 | p95 | p99 | 실패 | 다음 병목 | 월 비용(추정) | 판정 |`, `|---|---|---|---|---|---|---|---|`);
    const KN = { base: '기준', cfg: '설정', scale: '증설', query: '가정' };
    for (const r of d.개선안비교_D6.rows)
      L.push(`| ${KN[r.kind]} | ${r.name} | ${Math.round(r.p95)}ms | ${Math.round(r.p99)}ms | ${pct1(r.err)} | ${r.bottle} | $${Math.round(r.usd)} | ${r.pass ? '만족' : '미달'} |`);
    L.push(``, d.개선안비교_D6.winner ? `가장 싸게 목표를 만족: **${d.개선안비교_D6.winner}**` : `목표를 만족하는 단일 개선안 없음`, ``);
  } else L.push(`_아직 실행하지 않음 (D6 「같은 조건에서 비교」)_`, ``);
  L.push(`## 6. 실측 보정 · 예측 검증 (D7)`, ``);
  if (d.보정검증_D7) {
    const c = d.보정검증_D7;
    L.push(`- 보정에 쓴 rps: ${c.보정에쓴rps.join(', ')} → DB ${c.DB명목ms}ms → **${c.DB보정ms}ms**, α = **${c.α}**${c.α고정_서버실측 ? ' (서버 직접 측정값 고정)' : ' (추정)'}, γ = **${c.γ}**`);
    L.push(`- 검증(보정 미사용) rps: ${c.검증rps.join(', ')}`);
    L.push(`- **holdout 평균 상대오차: ${c.holdout오차_보정전}% → ${c.holdout오차_보정후}%**`, ``);
    L.push(`| rps | 실측 p95 | 보정 전 | 보정 후 |`, `|---|---|---|---|`);
    for (const r of c.점별) L.push(`| ${r.rps} | ${Math.round(r.real)}ms | ${Math.round(r.before)}ms | ${Math.round(r.after)}ms |`);
    L.push(``);
  } else L.push(`_아직 실행하지 않음 (D7 「보정 + 검증」)_`, ``);
  L.push(`## 7. 인프라 추천 (D5) — 추정값`, ``);
  const I = d.인프라추천_D5_추정;
  L.push(`| 계층 | 인스턴스 | 사양 | 월 비용 |`, `|---|---|---|---|`);
  L.push(`| 앱 (EC2) | ${I.앱 ? I.앱.인스턴스 : '카탈로그 초과'} | ${I.앱 ? `${I.앱.vCPU} vCPU / ${I.앱.GB} GB` : `필요 ${I.필요vCPU.앱} vCPU`} | ${I.앱 ? '$' + I.앱.usd월 : '-'} |`);
  L.push(`| DB (RDS) | ${I.DB ? I.DB.인스턴스 : '카탈로그 초과'} | ${I.DB ? `${I.DB.vCPU} vCPU / ${I.DB.GB} GB` : `필요 ${I.필요vCPU.DB} vCPU`} | ${I.DB ? '$' + I.DB.usd월 : '-'} |`);
  L.push(``, `가격 출처: ${I.가격출처}`, ``);
  L.push(`## 8. 가정과 한계`, ``, ...d.한계.map(x => `- ${x}`), ``);
  return L.join('\n');
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
}
$('btnReport').addEventListener('click', () => {
  download(`reinforcebean_report_${+$('sloRps').value}rps.md`, reportMarkdown(), 'text/markdown');
  REPORT_SAVED = true; markStep();
  const missing = [!LAST_RECO && 'D4 최소 자원', !LAST_CMP && 'D6 개선안 비교', !CALIB && 'D7 보정·검증'].filter(Boolean);
  $('reportOut').innerHTML = `저장됨` + (missing.length ? ` · <b>미실행: ${missing.join(' · ')}</b>` : '');
});
$('btnReportJson').addEventListener('click', () => download(`reinforcebean_report_${+$('sloRps').value}rps.json`, JSON.stringify(reportData(), null, 2), 'application/json'));

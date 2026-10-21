/* advisor.js — 파트 2 · 비교와 근거
   구획 6: EC2 인스턴스 카탈로그 → 인스턴스별 서버 능력 환산 → 실시간 비교 표 (이 화면의 결론)
   구획 7: 실측 보정 (모델을 믿을 근거) · 리포트 저장
   engine.js 가 먼저 로드되어야 한다. 엔진 내부에는 손대지 않는다. */
'use strict';

/* =====================================================================
 * 6. EC2 인스턴스 카탈로그 → 서버 능력
 *   인스턴스가 서버에 주는 영향은 두 가지다.
 *     vCPU  → CPU 슬롯 개수. 요청당 CPU 시간 × 유입이 코어 수를 넘으면 여기서 줄을 선다.
 *     메모리 → 띄울 수 있는 스레드 수의 상한. 설정값이 아무리 커도 메모리가 없으면 못 띄운다.
 *   t 계열(버스터블)은 vCPU 를 '지속적으로' 다 쓸 수 없다 — 기준 이용률만이 상시 보장분이다.
 * ===================================================================== */
// 앱 서버 후보 (type, vCPU, GB, $/h). data/aws-ec2-seoul.json 을 받아두면 서울 리전 실가격으로 교체된다.
const EC2 = [
  ['t3.micro', 2, 1, 0.013], ['t3.small', 2, 2, 0.026], ['t3.medium', 2, 4, 0.052], ['t3.large', 2, 8, 0.104],
  ['c6i.large', 2, 4, 0.096], ['m6i.large', 2, 8, 0.118], ['c6i.xlarge', 4, 8, 0.192], ['m6i.xlarge', 4, 16, 0.236],
  ['c6i.2xlarge', 8, 16, 0.384], ['m6i.2xlarge', 8, 32, 0.472], ['c6i.4xlarge', 16, 32, 0.768], ['m6i.8xlarge', 32, 128, 1.888],
];
const PRICE = { ec2: EC2, src: '내장 대략치 (fetch_public.js 로 실가격 교체 가능)' };
// AWS 문서의 버스터블 기준 이용률(vCPU 당). 이 선 위로 오래 있으면 크레딧이 떨어져 스로틀된다.
const T_BASELINE = { nano: .05, micro: .10, small: .20, medium: .20, large: .30, xlarge: .40, '2xlarge': .40 };
const MEM_PER_THREAD_MB = 8;     // 스레드 스택 + 요청당 버퍼 대략치
const MEM_RESERVE = 0.4;         // OS·런타임·힙 기본이 먹는 비율
function instBaseline(type) {
  const p = type.split('.');
  if (!/^t[2-4]/.test(p[0])) return 1;
  return T_BASELINE[p[1]] || .4;
}
const instThreadCap = (gb) => Math.max(1, Math.floor(gb * 1024 * (1 - MEM_RESERVE) / MEM_PER_THREAD_MB));

const INST_COL = ['#1f6feb', '#b45309', '#0f766e', '#7c3aed', '#b0201a', '#475569'];
const INST = { list: [], sel: 0, seq: 0, hl: false };   // hl: 사용자가 클릭으로 하나를 강조한 상태 (차트의 나머지는 흑백)
// 클릭 선택 — 같은 것을 다시 누르면 강조 해제 (전부 제 색으로)
function instPick(i) {
  if (INST.hl && INST.sel === i) INST.hl = false;
  else { INST.sel = i; INST.hl = true; }
}
const MONTH = 730;   // 시간 → 월 환산

// 인스턴스 한 대 = 자기 모델 파라미터(M) + 자기 시뮬레이션. 같은 트래픽을 동시에 먹인다.
function addInstance(type) {
  if (INST.list.length >= 4) return alert('한 번에 4대까지 비교합니다');
  const row = PRICE.ec2.find(r => r[0] === type); if (!row) return;
  if (INST.list.some(i => i.type === type)) return;
  const M = Object.assign({}, MODEL);
  const it = { id: ++INST.seq, type, vcpu: row[1], gb: row[2], usd: row[3],
    baseline: instBaseline(type), threadCap: instThreadCap(row[2]),
    color: INST_COL[INST.list.length % INST_COL.length], M, sim: createSim(M) };
  it.sim.S.t = CLOCK.t; it.sim.S.lastSec = Math.floor(CLOCK.t / 1000);   // 도중에 추가해도 시간축이 맞게
  INST.list.push(it);
  recolor(); renderInstList();
}
function recolor() { INST.list.forEach((it, i) => { it.color = INST_COL[i % INST_COL.length]; }); }
const instSel = () => INST.list[Math.min(INST.sel, INST.list.length - 1)] || null;

function renderInstList() {
  const el = $('instList');
  el.innerHTML = INST.list.map((it, i) => `
    <div class="inst${i === INST.sel ? ' on' : ''}" data-i="${i}">
      <i class="cdot" style="background:${it.color}"></i>
      <b>${it.type}</b>
      <span class="spec">${it.vcpu} vCPU · ${it.gb}GB · 스레드 ≤${it.threadCap}${it.baseline < 1 ? ` · 지속 ${Math.round(it.baseline * 100)}%` : ''}</span>
      <span class="money">$${Math.round(it.usd * MONTH)}</span>
      <button class="del" title="제거">×</button>
    </div>`).join('') || '<div class="none">비교할 인스턴스를 추가하세요</div>';
  el.querySelectorAll('.inst').forEach(d => d.addEventListener('click', (e) => {
    const i = +d.dataset.i;
    if (e.target.classList.contains('del')) { INST.list.splice(i, 1); if (INST.sel >= INST.list.length) INST.sel = Math.max(0, INST.list.length - 1); recolor(); }
    else instPick(i);
    renderInstList();
  }));
}
function fillCatalog() {
  const sel = $('instPick');
  sel.innerHTML = PRICE.ec2.map(r => `<option value="${r[0]}">${r[0]} — ${r[1]}vCPU / ${r[2]}GB / $${Math.round(r[3] * MONTH)}</option>`).join('');
}
// 실가격을 받은 뒤 이미 담아둔 인스턴스의 사양·가격도 갱신한다
function refreshCatalog() {
  fillCatalog();
  for (const it of INST.list) {
    const row = PRICE.ec2.find(r => r[0] === it.type); if (!row) continue;
    it.vcpu = row[1]; it.gb = row[2]; it.usd = row[3]; it.threadCap = instThreadCap(row[2]);
  }
  renderInstList();
}
$('instAdd').addEventListener('click', () => addInstance($('instPick').value));
$('instPreset').addEventListener('click', () => {
  INST.list.length = 0; INST.sel = 0;
  for (const t of ['t3.medium', 'c6i.xlarge', 'c6i.2xlarge']) if (PRICE.ec2.some(r => r[0] === t)) addInstance(t);
  if (!INST.list.length) PRICE.ec2.slice(0, 3).forEach(r => addInstance(r[0]));
});

/* ── 6b. 인스턴스 비교 리스트 (가운데 오른쪽) + 추천 (오른쪽 패널) ───────────
   최근 10초 평균으로 판정한다. 1초 값 하나는 튀어서 "만족/미달"이 깜빡인다.
   시간에 따른 변화는 아래 실시간 비교 차트가 맡으므로 여기서는 「지금」만 본다.
   대신 지금 값만 늘어놓지 않고 두 가지를 같이 둔다.
     ① 여유   — 이론 최대 rps 대비 지금 유입 (ρ). 여유가 없으면 지금 통과해도 곧 깨진다
     ② 돈 대비 — $/월 만으로는 못 고른다. 실제로 처리한 100rps 당 얼마인지까지 본다  */
function instStats(it) {
  const H = it.sim.S.history.slice(-10);
  if (!H.length) return null;
  const avg = (f) => H.reduce((a, d) => a + f(d), 0) / H.length;
  const inRate = avg(d => d.in) || 1;
  const th = theory(it.M);
  const out = avg(d => d.out);
  return { cpU: avg(d => d.cpU || 0), thU: avg(d => d.thU), coU: avg(d => d.coU),
    p95: avg(d => d.p95), out, fail: avg(d => d.rej + d.to),
    errRate: avg(d => d.rej + d.to) / inRate, q: H[H.length - 1].q,
    inRate, cap: th.cap, bottle: th.bottle,
    rho: th.cap > 0 ? inRate / th.cap : 9,                        // 1 을 넘으면 유입이 능력을 넘어섰다
    usdMonth: it.usd * MONTH,
    usdPer100: out > 1 ? it.usd * MONTH / (out / 100) : null,     // 실제로 처리한 100rps 당 월 비용
  };
}
// 설정 시나리오 표와 같은 인셀 차트 — 셀이 칠해진 길이가 곧 그 값의 크기다.
//   결과 칸(95% 응답·처리량·실패)은 목표·유입 대비, 자원 칸(CPU·스레드·커넥션)은 이용률 그대로.
function renderInstTable() {
  const p95T = +$('sloP95').value, errT = +$('sloErr').value / 100;
  const rows = INST.list.map(it => ({ it, s: instStats(it) })).filter(r => r.s);
  if (!rows.length) { $('instTable').innerHTML = '<div class="none">측정 중…</div>'; return; }
  const W = (f) => `<i class="fill" style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></i>`;
  const usdMax = Math.max(1, ...rows.map(r => r.s.usdMonth));
  const util = (v, sep) => `<td class="cell${sep ? ' sep' : ''}${v > .9 ? ' hot' : v > .75 ? ' warm' : ''}">`
    + `${W(v)}<b>${Math.round(v * 100)}%</b></td>`;
  const H = [`<table class="stab"><thead><tr><th class="l">인스턴스</th>`
    + `<th>95% 응답</th><th>처리량</th><th>실패</th>`
    + `<th class="sep">CPU</th><th>스레드</th><th>커넥션</th><th>여유</th>`
    + `<th class="sep">$/월</th><th>판정</th></tr></thead><tbody>`];
  for (const { it, s } of rows) {
    const ok = s.p95 <= p95T && s.errRate <= errT;
    const burst = it.baseline < 1 && s.cpU > it.baseline;
    const slack = Math.max(0, 1 - s.rho);       // 이론 최대 대비 남은 여유
    const i = INST.list.indexOf(it), sel = it === instSel();
    H.push(`<tr class="${sel ? 'now' : ''}" data-i="${i}"`
      + ` title="${it.type} · ${it.vcpu}vCPU / ${it.gb}GB · 스레드 상한 ${it.threadCap}">`
      + `<td class="l name"><i class="cdot" style="background:${it.color}"></i> ${it.type}`
      + (burst ? ' <span class="pill warn">버스트</span>' : '') + `</td>`
      + `<td class="cell${s.p95 > p95T ? ' hot' : ' d'}" title="목표 ${p95T}ms">`
      + `${W(s.p95 / Math.max(1, p95T))}<b>${fmt(s.p95)}ms</b></td>`
      + `<td class="cell d" title="유입 ${s.inRate.toFixed(0)}rps 중 완료 ${s.out.toFixed(0)}/s">`
      + `${W(s.out / Math.max(1, s.inRate))}<b>${fmt(s.out)}</b></td>`
      + `<td class="cell${s.errRate > errT ? ' hot' : s.errRate > 0.001 ? ' warm' : ' zero'}" title="허용 ${(errT * 100).toFixed(1)}%">`
      + `${W(s.errRate / Math.max(.001, errT))}<b>${(s.errRate * 100).toFixed(1)}%</b></td>`
      + util(s.cpU, true) + util(s.thU) + util(s.coU)
      + `<td class="cell${slack <= .1 ? ' hot' : slack <= .3 ? ' warm' : ' d'}" title="이론 최대 ${s.cap.toFixed(0)}rps">${W(slack)}<b>${Math.round(slack * 100)}%</b></td>`
      + `<td class="cell sep" title="100rps당 ${s.usdPer100 == null ? '—' : '$' + Math.round(s.usdPer100)}">`
      + `${W(s.usdMonth / usdMax * 0.92)}<b>$${Math.round(s.usdMonth)}</b></td>`
      + `<td><span class="pill ${ok ? 'ok' : 'no'}">${ok ? '만족' : '미달'}</span></td></tr>`);
  }
  H.push('</tbody></table>');
  $('instTable').innerHTML = H.join('');
  $('instTable').querySelectorAll('tbody tr').forEach(tr => tr.addEventListener('click', () => { instPick(+tr.dataset.i); renderInstList(); }));
}

/* ── 6c. 추천 — 목표를 만족하는 것 중 가장 싼 인스턴스 + 수치 근거 + 더 싼 것의 탈락 이유 ── */
function failWhy(s, p95T, errT) {
  if (s.p95 > p95T) return `95% 응답 ${Math.round(s.p95)}ms > ${p95T}ms`;
  if (s.errRate > errT) return `실패 ${(s.errRate * 100).toFixed(1)}% > ${(errT * 100).toFixed(1)}%`;
  return '';
}
function renderAdvice() {
  const el = $('advice'); if (!el) return;
  const p95T = +$('sloP95').value, errT = +$('sloErr').value / 100;
  const rows = INST.list.map(it => ({ it, s: instStats(it) })).filter(r => r.s)
    .sort((a, b) => a.it.usd - b.it.usd);
  if (!rows.length) { el.className = ''; el.innerHTML = '<div class="none">측정 중…</div>'; return; }
  const pick = rows.find(r => r.s.p95 <= p95T && r.s.errRate <= errT);
  if (!pick) {
    el.className = 'bad';
    el.innerHTML = `<div class="head"><b>만족하는 인스턴스 없음</b>`
      + `<span class="sub">유입 ${rows[0].s.inRate.toFixed(0)}rps</span></div>`
      + rows.map(r => `<div class="alt"><b>${r.it.type}</b> $${Math.round(r.s.usdMonth)}/월`
        + `<span class="r">${failWhy(r.s, p95T, errT)}</span></div>`).join('');
    return;
  }
  const s = pick.s;
  const burst = pick.it.baseline < 1 && s.cpU > pick.it.baseline;
  const cheaper = rows.filter(r => r.it.usd < pick.it.usd);
  el.className = '';
  el.innerHTML = `<div class="head"><b>${pick.it.type}</b>`
    + `<span class="sub">${pick.it.vcpu} vCPU · ${pick.it.gb}GB</span>`
    + (burst ? ' <span class="pill warn">버스트 의존</span>' : '')
    + `<span class="cost">$${Math.round(s.usdMonth)}<span style="font-size:9px;color:var(--muted)">/월</span></span></div>`
    + `<div class="why">95% 응답 <b>${Math.round(s.p95)}ms</b> ≤ ${p95T}ms`
    + ` · 실패 <b>${(s.errRate * 100).toFixed(1)}%</b> ≤ ${(errT * 100).toFixed(1)}%`
    + ` · 여유 <b>${Math.round(Math.max(0, 1 - s.rho) * 100)}%</b> (최대 ${s.cap.toFixed(0)}rps)</div>`
    + cheaper.map(r => `<div class="alt"><b>${r.it.type}</b> $${Math.round(r.s.usdMonth)}/월`
      + `<span class="r">${failWhy(r.s, p95T, errT)}</span></div>`).join('');
}

/* =====================================================================
 * 7. 실측 보정 — 모델을 믿을 근거
 *   validation/ 의 실제 서버(같은 구조: 큐 → 스레드 → 커넥션 풀)에서 잰 CSV 중
 *   *일부* rps 로만 파라미터를 맞추고, 맞추는 데 쓰지 않은 rps 에서 예측이 맞는지 본다.
 *   맞추는 것은 물리적 의미가 있는 두 개뿐이다.
 *     dbScale — 명목 DB 시간 대비 실제 배율 (단독 벤치마크는 부하 아래서 거짓말을 한다)
 *     γ       — 커넥션이 차오를 때 느려지기 시작하는 지점 (α 는 서버가 직접 잰 값으로 고정)
 * ===================================================================== */
const VERIFY = { real: [], src: '' };
let CALIB = null;
const ALPHA_MEASURED = 0.39;   // validation/server.js 가 부팅 때 직접 재는 "전 커넥션 동시 실행 감속률"
const GAMMAS = [1, 2, 4, 6, 8, 12, 16, 24];
const relErr = (a, b) => Math.abs(a - b) / Math.max(1, b);
// 서버 없이 열어도 보정이 돌아가도록 내장한 실측값 (validation/ 에서 잰 것. 파일이 있으면 그쪽이 우선)
const SAMPLE_CSV = `rps,p50,p95,p99,err_rate,thr
50,25.0,101.0,144.0,0.0000,55.0
100,22.0,93.0,147.0,0.0000,103.0
150,23.0,98.0,143.0,0.0000,155.0
200,30.0,115.0,170.0,0.0000,196.0
250,42.0,129.0,176.0,0.0000,250.0
300,525.0,654.0,715.0,0.1120,266.0
330,588.0,696.0,753.0,0.2500,249.0
360,610.0,746.0,814.0,0.3270,242.0
400,613.0,728.0,791.0,0.3950,242.0`;

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  const head = lines[0].toLowerCase().split(',').map(s => s.trim()); const idx = (k) => head.indexOf(k);
  const rows = [];
  for (const l of lines.slice(1)) { const c = l.split(','); if (c.length < 3) continue;
    rows.push({ rps: +c[idx('rps')], p50: +c[idx('p50')] || 0, p95: +c[idx('p95')], err: +(c[idx('err_rate')] ?? 0) || 0 }); }
  return rows.filter(r => isFinite(r.rps) && isFinite(r.p95));
}
// 보정용 cfg — 실측 CSV 를 만든 검증 서버(validation/server.js)의 설정 그대로.
// 화면의 슬라이더 값이 아니라 *측정할 때의 설정*으로 맞춰야 한다. 다른 설정으로 맞추면
// 맞출 수 없는 오차를 DB 파라미터에 떠넘기게 된다. (직접 만든 CSV 도 이 설정으로 재야 한다)
const VERIFY_SERVER = { threads: 50, conns: 10, queueCap: 100, timeoutMs: 3000, dbTimeMs: 30 };
const verifyCfg = (extra) => Object.assign({
  threads: VERIFY_SERVER.threads, conns: VERIFY_SERVER.conns, dbTimeMs: VERIFY_SERVER.dbTimeMs,
  queueCap: VERIFY_SERVER.queueCap, timeoutMs: VERIFY_SERVER.timeoutMs,
  cpuTimeMs: 0, retryProb: 0, cores: null, mixOn: false,
  dbLoadAlpha: 0, dbLoadGamma: 2, dbScale: 1,
}, extra || {});
const nomDbMs = () => VERIFY_SERVER.dbTimeMs;

// 보정/검증 구간 자동 분할: 한산한 점 2개(기본 시간) + 무릎 직전·최고점(γ) 으로 맞추고 나머지는 전부 검증용
function autoSplit() {
  const R = VERIFY.real.slice().filter(d => d.p95 > 0).sort((a, b) => a.rps - b.rps);
  if (R.length < 3) return null;
  const kneeIdx = R.findIndex(d => d.err > 0.02);
  const preKnee = kneeIdx > 0 ? R[kneeIdx - 1] : R[Math.max(0, Math.floor(R.length * 0.6))];
  const fitRps = [...new Set([...R.slice(0, 2).map(d => d.rps), preKnee.rps, R[R.length - 1].rps])];
  return { fit: R.filter(d => fitRps.includes(d.rps)), hold: R.filter(d => !fitRps.includes(d.rps)) };
}
const simP95 = (rps, scale, alpha, gamma, rep, dur, warm) => {
  let t = 0; for (let k = 0; k < rep; k++) t += runHeadless(verifyCfg({ rps, dbScale: scale, dbLoadAlpha: alpha, dbLoadGamma: gamma }), dur, warm).p95;
  return t / rep;
};
// ① 한산한 점에서 실측/시뮬 비율로 DB 시간 배율을 수렴시킨다 (경합이 없어 순수한 서비스 시간이 드러난다)
function fitScale(lowPts) {
  let s = 1;
  for (let it = 0; it < 4; it++) {
    let ratio = 0;
    for (const p of lowPts) ratio += (p.p95 / Math.max(1, simP95(p.rps, s, 0, 1, 10, 25, 5))) / lowPts.length;
    s *= ratio;
  }
  return Math.min(4, Math.max(0.2, +s.toFixed(3)));
}
// ② 배율·α 를 고정하고 γ(언제부터 느려지나)만 무릎 구간에서 찾는다
function fitGamma(kneePts, scale) {
  let best = null;
  for (const g of GAMMAS) {
    let e = 0;
    for (const p of kneePts) for (let k = 0; k < 3; k++) {
      const r = runHeadless(verifyCfg({ rps: p.rps, dbScale: scale, dbLoadAlpha: ALPHA_MEASURED, dbLoadGamma: g }), 15, 4);
      e += (relErr(r.p95, p.p95) + 2 * Math.abs(r.errRate - p.err)) / 3;
    }
    e /= Math.max(1, kneePts.length);
    if (!best || e < best.err) best = { gamma: g, err: e };
  }
  return best;
}
async function loadRealCsv() {
  try { const r = await fetch('validation/result.csv'); if (r.ok) { VERIFY.real = parseCsv(await r.text()); VERIFY.src = 'validation/result.csv'; return; } }
  catch (e) { /* file:// 로 열면 fetch 가 막힌다 — 내장 샘플을 쓴다 */ }
  VERIFY.real = parseCsv(SAMPLE_CSV); VERIFY.src = '내장 샘플';
}
async function calibrate() {
  const out = $('calibOut'), btn = $('btnCalib');
  btn.disabled = true;
  try {
    if (!VERIFY.real.length) { out.innerHTML = '실측값을 읽는 중…'; await loadRealCsv(); }
    const sp = autoSplit();
    if (!sp) { out.innerHTML = '실측 점이 3개 미만입니다.'; return; }
    const floor = Math.min(...VERIFY.real.filter(d => d.p95 > 0).map(d => d.p95));
    let lowPts = sp.fit.filter(d => d.p95 <= floor * 1.5 && d.err < 0.02);
    let kneePts = sp.fit.filter(d => !lowPts.includes(d));
    if (!lowPts.length) lowPts = [sp.fit[0]];
    if (!kneePts.length) kneePts = [sp.fit[sp.fit.length - 1]];

    out.innerHTML = `① 한산 구간(${lowPts.map(p => p.rps).join(', ')} rps)에서 DB 시간을 재는 중…`;
    await new Promise(r => setTimeout(r, 0));
    const scale = fitScale(lowPts);

    out.innerHTML = `② 무릎 구간(${kneePts.map(p => p.rps).join(', ')} rps)에서 느려지는 지점을 찾는 중…`;
    await new Promise(r => setTimeout(r, 0));
    const g = fitGamma(kneePts, scale);

    out.innerHTML = `③ 보정에 쓰지 않은 ${sp.hold.length}개 rps 에서 예측을 검증하는 중…`;
    await new Promise(r => setTimeout(r, 0));
    const nom = nomDbMs(), rows = []; let eB = 0, eA = 0;
    for (const p of sp.hold) {
      const b = simP95(p.rps, 1, 0, 1, 5, 15, 5), a = simP95(p.rps, scale, ALPHA_MEASURED, g.gamma, 5, 15, 5);
      eB += relErr(b, p.p95); eA += relErr(a, p.p95);
      rows.push({ rps: p.rps, real: p.p95, before: b, after: a });
    }
    const n = Math.max(1, sp.hold.length); eB /= n; eA /= n;
    CALIB = { scale, alpha: ALPHA_MEASURED, gamma: g.gamma, dbNom: nom, dbCal: nom * scale,
      fitRps: sp.fit.map(p => p.rps), holdRps: sp.hold.map(p => p.rps), errBefore: eB, errAfter: eA, rows, src: VERIFY.src };

    const H = [`<div class="kv"><span>실측 <b>${VERIFY.real.length}점</b> (${VERIFY.src})</span>`
      + `<span>보정 <b>${CALIB.fitRps.join(', ')}</b> rps</span><span>검증 <b>${CALIB.holdRps.join(', ')}</b> rps</span></div>`];
    H.push(`<table class="t"><tr><th>rps (보정 미사용)</th><th>실측 95% 응답</th><th>보정 전</th><th>보정 후</th></tr>`);
    for (const r of rows) {
      const b = relErr(r.before, r.real), a = relErr(r.after, r.real);
      H.push(`<tr><td>${r.rps}</td><td>${Math.round(r.real)} ms</td>`
        + `<td style="color:var(--muted)">${Math.round(r.before)} <small>(${(b * 100).toFixed(0)}%)</small></td>`
        + `<td style="color:${a < b ? 'var(--ink)' : 'var(--bad)'}"><b>${Math.round(r.after)}</b> <small>(${(a * 100).toFixed(0)}%)</small></td></tr>`);
    }
    H.push(`</table>`);
    H.push(`<div class="note"><b>holdout 평균 오차 ${(eB * 100).toFixed(0)}% → ${(eA * 100).toFixed(0)}%</b>`
      + ` · DB ${nom.toFixed(0)}ms → <b>${(nom * scale).toFixed(0)}ms</b> (커넥션 만석 ${(nom * scale * (1 + ALPHA_MEASURED)).toFixed(0)}ms, γ=${g.gamma})</div>`);
    H.push(`<div class="row" style="margin-top:5px"><button class="primary" id="btnApplyCalib">보정값 적용 → 비교에 반영</button></div>`);
    out.innerHTML = H.join('');
    $('btnApplyCalib').addEventListener('click', applyCalib);
  } finally { btn.disabled = false; }
}
// 보정값을 실제 슬라이더/BASE 에 반영 — 이후 인스턴스 비교가 전부 보정된 모델로 돌아간다
function applyCalib() {
  if (!CALIB) return;
  BASE.dbLoadAlpha = CALIB.alpha; BASE.dbLoadGamma = CALIB.gamma;
  $('dbt').value = Math.max(5, Math.round(BASE.dbTimeMs * CALIB.scale));
  $('dbt').dispatchEvent(new Event('input'));
  CALIB.applied = true; CALIB.scale = 1;   // 두 번 적용되지 않도록
  $('calibState').textContent = `보정됨 (α ${CALIB.alpha} · γ ${CALIB.gamma} · holdout 오차 ${(CALIB.errAfter * 100).toFixed(0)}%)`;
  resetAll();
}
$('btnCalib').addEventListener('click', calibrate);
$('btnCsv').addEventListener('click', () => $('csvFile').click());
$('csvFile').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  f.text().then(t => { VERIFY.real = parseCsv(t); VERIFY.src = f.name; calibrate(); });
  e.target.value = '';
});

/* =====================================================================
 * 7b. 리포트 저장 — 무엇을 가정했고 어디까지가 추정인가를 함께 남긴다
 * ===================================================================== */
function reportMarkdown() {
  const p95T = +$('sloP95').value, errT = +$('sloErr').value;
  const L = [`# Preflight — EC2 인스턴스 비교`, ``, `생성: ${new Date().toISOString()}`, ``];
  L.push(`## 부하 조건`, ``,
    `- 유입: ${MODEL.rps} rps (시나리오 ${SCENARIOS[scenarioKey].name})`,
    `- 서버 설정: 스레드 ${BASE.threads} / DB 커넥션 ${BASE.conns} / 대기 큐 ${BASE.queueCap} / 타임아웃 ${BASE.timeoutMs}ms`,
    `- 작업: DB ${BASE.dbTimeMs}ms + 앱 CPU ${MODEL.cpuTimeMs}ms per 요청`,
    `- 목표: 95% 응답시간 ≤ ${p95T}ms · 실패 ≤ ${errT}%`, ``);
  L.push(`## 인스턴스 비교 (현재 시점)`, ``,
    `| 인스턴스 | vCPU | 메모리 | 스레드 상한 | CPU | 스레드 | 커넥션 | 95% 응답 | 완료 | 실패 | $/월 | 판정 |`,
    `|---|---|---|---|---|---|---|---|---|---|---|---|`);
  const sorted = INST.list.slice().sort((a, b) => a.usd - b.usd);
  let pick = null;
  for (const it of sorted) {
    const s = instStats(it); if (!s) continue;
    const ok = s.p95 <= p95T && s.errRate <= errT * 0.01;
    if (ok && !pick) pick = { it, s };
    L.push(`| ${it.type} | ${it.vcpu} | ${it.gb}GB | ${it.threadCap} | ${Math.round(s.cpU * 100)}% | ${Math.round(s.thU * 100)}% | ${Math.round(s.coU * 100)}%`
      + ` | ${Math.round(s.p95)}ms | ${Math.round(s.out)}/s | ${(s.errRate * 100).toFixed(1)}% | $${Math.round(it.usd * MONTH)} | ${ok ? '만족' : '미달'} |`);
  }
  L.push(``, `가격 출처: ${PRICE.src}`, ``);
  L.push(`## 최종 추천`, ``);
  L.push(pick
    ? `**${pick.it.type}** ($${Math.round(pick.s.usdMonth)}/월) — 목표를 만족하는 것 중 가장 싸다. `
      + `95% 응답 ${Math.round(pick.s.p95)}ms ≤ ${p95T}ms · 실패 ${(pick.s.errRate * 100).toFixed(1)}% ≤ ${errT}% · 여유 ${Math.round(Math.max(0, 1 - pick.s.rho) * 100)}%`
    : `만족하는 인스턴스 없음`, ``);
  L.push(`## 모델 보정`, ``);
  L.push(CALIB
    ? `- 실측 ${VERIFY.real.length}점 (${CALIB.src}) 중 ${CALIB.fitRps.join(', ')} rps 로만 보정, ${CALIB.holdRps.join(', ')} rps 로 검증\n`
      + `- **holdout 평균 상대오차 ${(CALIB.errBefore * 100).toFixed(0)}% → ${(CALIB.errAfter * 100).toFixed(0)}%**\n`
      + `- DB ${CALIB.dbNom.toFixed(0)}ms → ${CALIB.dbCal.toFixed(0)}ms · α=${CALIB.alpha} · γ=${CALIB.gamma}`
    : `_보정하지 않음_`, ``);
  return L.join('\n');
}
$('btnReport').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([reportMarkdown()], { type: 'text/markdown' }));
  a.download = `preflight_${MODEL.rps}rps.md`; a.click();
});

fillCatalog();

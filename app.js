/* app.js — 공동
   구획 7d~9: 단계 안내·원클릭 예제 · UI 바인딩·메인 루프 · 공개 데이터 로딩
   engine.js → advisor.js → app.js 순서로 로드된다. 둘 다 쓰는 유일한 파일이므로 변경은 합의 후에. */
'use strict';
/* =====================================================================
 * 7d. 단계 안내 + 원클릭 예제 실행
 *   이 도구는 패널이 많다. "지금 뭘 눌러야 하는가"를 항상 한 줄로 보여주고,
 *   처음 온 사람은 버튼 하나로 전체 흐름을 끝까지 볼 수 있어야 한다.
 * ===================================================================== */
// 각 단계의 완료 판정 — 결과가 실제로 만들어졌는지로 본다 (버튼을 눌렀는지가 아니라)
let TOUCHED_INPUT = false;
document.getElementById('left').addEventListener('input', () => { TOUCHED_INPUT = true; }, true);
document.getElementById('left').addEventListener('change', () => { TOUCHED_INPUT = true; }, true);
const STEP_DONE = {
  cond:  () => TOUCHED_INPUT || BASE.mixOn || !!DATA.cur,
  diag:  () => main.S.history.length > 3,
  cand:  () => !!LAST_CAND,
  reco:  () => !!LAST_RECO,
  cmp:   () => !!LAST_CMP,
  calib: () => !!CALIB,
  infra: () => $('infraOut').querySelector('table') != null,
  save:  () => REPORT_SAVED,
};
let REPORT_SAVED = false;
function markStep() {
  const btns = [...document.querySelectorAll('#steps .step')];
  let firstUndone = -1;
  btns.forEach((b, i) => {
    const done = !!(STEP_DONE[b.dataset.key] && STEP_DONE[b.dataset.key]());
    b.classList.toggle('done', done);
    b.classList.remove('now');
    if (!done && firstUndone < 0) firstUndone = i;
  });
  if (firstUndone >= 0) btns[firstUndone].classList.add('now');
  // 접힌 패널 제목에도 완료 여부를 표시해 둔다 (열어보지 않아도 알 수 있게)
  const PANEL_OF = { reco: 'recoOut', cmp: 'cmpOut', calib: 'calibOut', infra: 'infraOut', save: 'reportOut' };
  for (const key in PANEL_OF) {
    const el = $(PANEL_OF[key]); if (!el) continue;
    const h2 = (el.closest('.panel') || el).querySelector('h2'); if (!h2) continue;
    let tick = h2.querySelector('.tick');
    const done = !!(STEP_DONE[key] && STEP_DONE[key]());
    if (done && !tick) { tick = document.createElement('span'); tick.className = 'tick'; tick.textContent = '완료'; h2.insertBefore(tick, h2.lastElementChild); }
    else if (!done && tick) tick.remove();
  }
  // 지금 눌러야 할 버튼에 「← 다음」 표시 (한 번에 하나만)
  const NEXT_BTN = { cand: 'btnCandCmp', reco: 'btnRecommend', cmp: 'btnCompare', calib: 'btnCalib', infra: 'btnInfra', save: 'btnReport' };
  document.querySelectorAll('button.next').forEach(b => b.classList.remove('next'));
  if (firstUndone >= 0) { const id = NEXT_BTN[btns[firstUndone].dataset.key]; if (id && $(id)) $(id).classList.add('next'); }
}
// D 열은 전부 펼쳐 둔다 — 열고 닫는 대신 필요한 것이 항상 보이게.
function openPanel(target) { if (target) target.scrollIntoView({ block: 'nearest' }); }
const panelOf = (id) => { const el = $(id); return el ? el.closest('.panel') : null; };
document.querySelectorAll('#steps .step').forEach(b => b.addEventListener('click', () => {
  const el = $(b.dataset.go); if (!el) return;
  const box = el.closest('.panel') || el;
  box.scrollIntoView({ block: 'nearest' });
  box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
}));
openPanel(panelOf('recoOut'));   // 처음엔 ③ 최소 자원을 열어 둔다

// 서버 없이 열어도 예제가 돌아가도록 내장한 실측 결과 (validation/ 에서 잰 값. 파일이 있으면 그쪽을 우선 사용)
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

async function runDemo() {
  const log = $('demoLog'), btn = $('btnDemo');
  btn.disabled = true;
  const say = (h) => { log.innerHTML = h; };
  const pause = () => new Promise(r => setTimeout(r, 350));
  try {
    // ── 0. 조건: 검증 서버와 같은 설정으로 맞춘다 ──
    say('<b>0/6</b> 예제 조건을 맞추는 중… (검증 서버와 같은 스레드 50 · 커넥션 10 · DB 30ms)');
    for (const [id, v] of [['threads', 50], ['conns', 10], ['qcap', 100], ['dbt', 30], ['to', 3000], ['alpha', 0], ['gamma', 2]]) {
      $(id).value = v; $(id).dispatchEvent(new Event('input'));
    }
    if ($('mixOn').checked) { $('mixOn').checked = false; $('mixOn').dispatchEvent(new Event('change')); }
    TOUCHED_INPUT = true; main.paused = false; markStep();
    await pause();

    // ── 1. 실측 데이터 ──
    say('<b>1/6</b> 실측 데이터를 불러오는 중…');
    let text = SAMPLE_CSV, src = '내장 샘플';
    try { const r = await fetch('validation/result.csv'); if (r.ok) { text = await r.text(); src = 'validation/result.csv'; } }
    catch (e) { /* file:// 이면 내장 샘플을 쓴다 */ }
    VERIFY.real = parseCsv(text);
    $('verifyMsg').textContent = `실측 ${VERIFY.real.length}점 (${src})`;
    const knee = VERIFY.real.find(d => d.err > 0.03);
    say(`<b>1/6</b> 실측 ${VERIFY.real.length}점 로드 (${src}).<br>`
      + (knee ? `실패가 <b>${knee.rps} rps</b>부터 나기 시작합니다 — 여기가 이 서버의 한계입니다.` : ''));
    markStep(); await pause();

    // ── 2. 보정 + holdout 검증 ──
    openPanel(panelOf('calibOut'));
    const sp = applyAutoSplit(true);
    say(`<b>2/6</b> 모델 보정 중… <span style="color:var(--muted)">${sp ? sp.fit.join(', ') + ' rps로만 맞추고 나머지 ' + sp.hold.length + '점으로 검증합니다' : ''} (15~25초)</span>`);
    $('fitAlpha').checked = false;
    await calibrate();
    if (CALIB) {
      const good = CALIB.errAfter < CALIB.errBefore;
      say(`<b>2/6 완료</b> — 보정에 쓰지 않은 rps에서 오차 <b>${(CALIB.errBefore * 100).toFixed(0)}% → ${(CALIB.errAfter * 100).toFixed(0)}%</b>.<br>`
        + (good ? '파라미터를 꿰맞춘 게 아니라 <b>모델이 실제로 맞는다</b>는 뜻입니다. ⑤ 패널의 표를 보세요.'
                : '보정이 오히려 나빠졌습니다 — ⑤ 패널의 경고를 확인하세요.'));
      applyCalib();
    }
    await pause();

    // ── 3. 최소 자원 ──
    const peak = knee ? Math.round(knee.rps * 0.9 / 10) * 10 : 250;
    $('sloRps').value = peak; $('sloP95').value = 300;
    openPanel(panelOf('recoOut'));
    say(`<b>3/6</b> 피크 <b>${peak} rps</b>에서 목표 p95 300ms를 만족하는 <b>최소 자원</b>을 찾는 중…`);
    await recommend();
    say(LAST_RECO
      ? `<b>3/6 완료</b> — 스레드 <b>${LAST_RECO.t}</b> / 커넥션 <b>${LAST_RECO.c}</b> (p95 ${Math.round(LAST_RECO.p95)}ms).<br>커넥션은 트래픽에 비례해 늘지만 스레드는 훨씬 적게 필요합니다 — 병목이 DB이기 때문입니다.`
      : `<b>3/6</b> 이 조건에서는 SLO를 만족하는 조합이 없습니다. ④ 비교에서 무엇을 바꿔야 하는지 보세요.`);
    await pause();

    // ── 4. 설정 후보 비교: 같은 트래픽에서 어느 설정이 나은가 ──
    $('cmpWrap').classList.remove('flash'); void $('cmpWrap').offsetWidth; $('cmpWrap').classList.add('flash');
    CAND.list.length = 0; $('btnCandPreset').click();
    if (LAST_RECO) { CAND.list.push(Object.assign(candFromSliders('D4 추천안'), { threads: LAST_RECO.t, conns: LAST_RECO.c })); renderCandList(); }
    say(`<b>4/6</b> 같은 트래픽(피크 <b>${peak} rps</b>)에서 <b>설정 후보 ${CAND.list.length}벌</b>이 각각 몇 rps에서 무너지는지 재는 중… (10~20초)`);
    await compareCands();
    if (LAST_CAND) {
      const bc = LAST_CAND.results.filter(r => r.ok).sort((x, y) => x.cost - y.cost)[0];
      say(`<b>4/6 완료</b> — ` + (bc
        ? `<b>「${candLabel(bc.c)}」</b>가 피크를 버티는 후보 중 가장 쌉니다 — 과부하 시작 <b>${bc.knee == null ? '스윕 구간 밖' : bc.knee + ' rps'}</b>`
          + (bc.inf.app && bc.inf.db ? ` · ${bc.inf.app[0]} + ${bc.inf.db[0]} $${Math.round(bc.cost * 730)}/월` : ' · 카탈로그 초과')
        : '어느 후보도 피크를 버티지 못합니다 — 커넥션이나 쿼리 시간을 손봐야 합니다.')
        + `<br>오른쪽 아래 <b>C2 차트</b>에 후보별 곡선이 겹쳐 그려집니다 — <b>세로 점선이 각 후보의 과부하 시작점</b>입니다.`);
    }
    await pause();

    // ── 5. 개선안 비교 ──
    openPanel(panelOf('cmpOut'));
    say(`<b>5/6</b> 같은 조건에서 <b>증설 · 설정 · 쿼리 개선</b>을 비교하는 중… (10~15초)`);
    await comparePlans();
    if (LAST_CMP) {
      const cfgOk = LAST_CMP.rows.filter(r => r.kind === 'cfg' && r.pass).length;
      const scOk = LAST_CMP.rows.filter(r => r.kind === 'scale' && r.pass).length;
      say(`<b>5/6 완료</b> — ${LAST_CMP.winner ? `가장 싼 해법은 <b>「${LAST_CMP.winner}」</b>.` : '단일 개선으로는 목표를 못 맞춥니다.'}<br>`
        + (cfgOk && !scOk ? '설정만 바꿔도 되는 상황입니다 — <b>돈을 쓸 필요가 없습니다.</b>'
          : !cfgOk && scOk ? '설정으로는 안 되고 <b>증설이 필요한 구간</b>입니다.'
          : '④ 패널에서 각 안의 <b>다음 병목</b>을 함께 보세요 — 자원을 늘리면 병목은 사라지지 않고 옮겨갑니다.'));
    }
    await pause();

    // ── 5. 인프라 + 저장 ──
    openPanel(panelOf('infraOut'));
    say('<b>6/6</b> 필요한 EC2 / RDS를 고르는 중…');
    infraRecommend();
    say(`<b>완료</b> — 보정 · 후보 비교 · 최소 자원 · 개선안 · 인프라 추천`);
  } catch (e) {
    say(`실행 중 문제가 생겼습니다: ${e.message}`);
  } finally { btn.disabled = false; markStep(); }
}
$('btnDemo').addEventListener('click', runDemo);

/* =====================================================================
 * 8. UI 바인딩 + 메인 루프
 * ===================================================================== */
const main = createSim(MODEL, { visual: false, onSecond: () => updateStats() });
const bind = (id, key, scale = 1) => { const el = $(id), out = $(id + 'Val');
  const apply = () => { BASE[key] = +el.value * scale; out.textContent = el.value; }; el.addEventListener('input', apply); apply(); };
bind('threads', 'threads'); bind('conns', 'conns'); bind('qcap', 'queueCap'); bind('dbt', 'dbTimeMs'); bind('to', 'timeoutMs'); bind('retry', 'retryProb', 0.01);
bind('alpha', 'dbLoadAlpha'); bind('gamma', 'dbLoadGamma');
// 슬라이더마다 조절 가능한 범위를 아래에 작게 표시한다 (값만 보고는 여유가 얼마인지 모른다)
function addRanges(root) {
  root.querySelectorAll('input[type=range]').forEach(el => {
    if (el.nextElementSibling && el.nextElementSibling.classList.contains('rng')) return;
    const d = document.createElement('div'); d.className = 'rng';
    d.innerHTML = `<span>${el.min}</span><span>${el.max}</span>`;
    el.parentNode.insertBefore(d, el.nextSibling);
  });
}
addRanges($('left'));
$('cancel').addEventListener('change', () => { BASE.cancelOnTimeout = $('cancel').checked; }); BASE.cancelOnTimeout = false;
BASE.dbScale = 1;

/* ── A3 작업 구성: 유형별 비율 × 처리시간 → BASE.mix (엔진이 요청마다 유형을 뽑아 쓴다) ── */
BASE.mixOn = false;
BASE.mix = MODEL.mix.map(m => Object.assign({}, m));
function renderMixRows() {
  $('mixRows').innerHTML = BASE.mix.map((m, i) => `
    <div class="mixrow" data-i="${i}">
      <label>${m.name} <b class="msv">${Math.round(m.share * 100)}%</b></label>
      <input type="range" class="ms" min="0" max="100" step="5" value="${Math.round(m.share * 100)}">
      <div class="mtimes">DB <input type="number" class="md" value="${m.dbTimeMs}" min="1" step="5"> ms · 앱 CPU <input type="number" class="mc" value="${m.cpuTimeMs}" min="0" step="1"> ms</div>
    </div>`).join('');
  addRanges($('mixRows'));
  $('mixRows').querySelectorAll('.mixrow').forEach(row => {
    const i = +row.dataset.i;
    row.querySelector('.ms').addEventListener('input', (e) => { BASE.mix[i].share = +e.target.value / 100; row.querySelector('.msv').textContent = e.target.value + '%'; syncMix(); });
    row.querySelector('.md').addEventListener('input', (e) => { BASE.mix[i].dbTimeMs = Math.max(1, +e.target.value || 1); syncMix(); });
    row.querySelector('.mc').addEventListener('input', (e) => { BASE.mix[i].cpuTimeMs = Math.max(0, +e.target.value || 0); syncMix(); });
  });
}
function syncMix() {
  const on = BASE.mixOn;
  $('mixRows').querySelectorAll('.mixrow').forEach(r => r.classList.toggle('off', !on));
  $('ctlDbt').classList.toggle('disabled', on);
  if (!on) { $('mixInfo').innerHTML = ''; return; }
  const tot = BASE.mix.reduce((s, m) => s + m.share, 0);
  if (tot <= 0) { $('mixInfo').innerHTML = '모든 비율이 0'; return; }
  const e = effTimes({ mixOn: true, mix: BASE.mix, dbTimeMs: BASE.dbTimeMs, cpuTimeMs: MODEL.cpuTimeMs, dbScale: 1 });
  const shares = BASE.mix.filter(m => m.share > 0).map(m => `${m.name} ${Math.round(m.share / tot * 100)}%`).join(' · ');
  const loadTot = BASE.mix.reduce((s, m) => s + m.share * m.dbTimeMs, 0);
  const heavy = BASE.mix.map(m => ({ m, load: m.share * m.dbTimeMs })).sort((a, b) => b.load - a.load)[0];
  $('mixInfo').innerHTML = `실효 DB <b>${e.db.toFixed(1)}ms</b> · 이론 최대 <b>${Math.round(BASE.conns / e.db * 1000)} rps</b>`
    + ` · 「${heavy.m.name}」이 DB 시간의 ${Math.round(heavy.load / loadTot * 100)}%`;
}
$('mixOn').addEventListener('change', () => { BASE.mixOn = $('mixOn').checked; syncMix(); });
document.querySelectorAll('[data-mix]').forEach(b => b.addEventListener('click', () => {
  const parts = b.dataset.mix.split(':').map(Number);
  BASE.mix.forEach((m, i) => { m.share = (parts[i] || 0) / 100; });
  if (!BASE.mixOn) { BASE.mixOn = true; $('mixOn').checked = true; }
  renderMixRows(); syncMix();
}));
renderMixRows(); syncMix();
const rpsEl = $('rps'); const applyRps = () => { BASE.rps = +rpsEl.value; $('rpsVal').textContent = rpsEl.value; }; rpsEl.addEventListener('input', applyRps); applyRps();
const scSel = $('scenario'); for (const k in SCENARIOS) { const o = document.createElement('option'); o.value = k; o.textContent = SCENARIOS[k].name; scSel.appendChild(o); }
const SLIDER_OF = { threads: ['threads', 1], conns: ['conns', 1], queueCap: ['qcap', 1], dbTimeMs: ['dbt', 1], timeoutMs: ['to', 1], retryProb: ['retry', 100], rps: ['rps', 1],
  dbLoadAlpha: ['alpha', 1], dbLoadGamma: ['gamma', 1] };
const CHECK_OF = { cancelOnTimeout: 'cancel', mixOn: 'mixOn' };
scSel.addEventListener('change', () => {
  scenarioKey = scSel.value; scenarioStart = main.S.t; $('ctlRps').classList.toggle('disabled', scenarioKey !== 'manual');
  const p = SCENARIOS[scenarioKey].params || {};   // 시나리오 초기 파라미터를 슬라이더에 1회 반영 (이후 사용자가 바꿀 수 있음)
  for (const k in p) {
    if (SLIDER_OF[k]) { const [id, mul] = SLIDER_OF[k]; $(id).value = p[k] * mul; $(id).dispatchEvent(new Event('input')); }
    else if (CHECK_OF[k]) { $(CHECK_OF[k]).checked = !!p[k]; $(CHECK_OF[k]).dispatchEvent(new Event('change')); }
  }
  renderExplain(0);
});
// 간결 모드가 기본. 설정은 브라우저에 기억된다
$('prose').checked = localStorage.getItem('reinforcebean.prose') === '1';
const syncProse = () => { document.body.classList.toggle('lean', !$('prose').checked); localStorage.setItem('reinforcebean.prose', $('prose').checked ? '1' : '0'); };
$('prose').addEventListener('change', syncProse); syncProse();
$('btnPause').addEventListener('click', () => { main.paused = !main.paused; $('btnPause').textContent = main.paused ? '재생' : '일시정지'; });
$('btnReset').addEventListener('click', () => { main.reset(); scenarioStart = 0; PB_KEY = ''; updateStats(); });
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset; if (p === 'baseline') { $('threads').value = 50; $('conns').value = 10; } if (p === 'moreThreads') $('threads').value = 200; if (p === 'moreConns') $('conns').value = 30;
  $('threads').dispatchEvent(new Event('input')); $('conns').dispatchEvent(new Event('input')); }));
document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|BUTTON/.test(e.target.tagName)) { e.preventDefault(); $('btnPause').click(); } });

// 재생 바 — 지금 시나리오의 어느 국면인지. 마커는 해설 단계(explain)의 시각.
let PB_KEY = '';
function drawPlaybar() {
  const sc = SCENARIOS[scenarioKey];
  const span = sc.period || sc.spanSec || Math.max(30, (sc.explain[sc.explain.length - 1].t || 0) + 20);
  const el = (main.S.t - scenarioStart) / 1000;
  const tt = sc.spanSec && !sc.period ? Math.min(el, span) : el % span;   // 반복하지 않는 파일 시나리오는 끝에서 멈춘다
  if (PB_KEY !== scenarioKey) {                      // 시나리오가 바뀔 때만 마커를 다시 그린다
    PB_KEY = scenarioKey; $('scName').textContent = sc.name;
    $('scMarks').innerHTML = sc.explain.map(e => `<i style="left:${Math.min(100, (e.t || 0) / span * 100)}%" title="${e.text.replace(/<[^>]+>/g, '').slice(0, 40)}"></i>`).join('');
  }
  $('scFill').style.width = (tt / span * 100).toFixed(1) + '%';
  $('scPos').textContent = `${tt.toFixed(0)}s / ${Math.round(span)}s`;
}

let lastExplainIdx = -1;
function renderExplain(tt) {
  if (!$('explain')) return;
  const sc = SCENARIOS[scenarioKey]; let idx = 0; sc.explain.forEach((s, i) => { if (tt >= s.t) idx = i; });
  if (idx === lastExplainIdx && $('explain').dataset.sc === scenarioKey) return;
  lastExplainIdx = idx; $('explain').dataset.sc = scenarioKey;
  $('explain').innerHTML = sc.explain.map((s, i) => `<div class="step${i === idx ? ' now' : ''}">${sc.period || s.t ? `<b>${s.t}s</b> · ` : ''}${s.text}</div>`).join('') +
    (sc.period ? `<div class="note">${sc.period}초 주기로 반복</div>` : '');
  const now = $('explain').querySelector('.now'); if (now) now.scrollIntoView({ block: 'nearest' });
}
function updateStats() {
  const S = main.S, h = S.history[S.history.length - 1], th = theory(MODEL);
  const put = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  if (h) { put('mThr', h.out); put('mP95', Math.round(h.p95)); put('mP99', Math.round(h.p99 || 0));
    put('mThU', Math.round(h.thU * 100)); put('mCoU', Math.round(h.coU * 100));
    put('mErr', h.rej + h.to); put('mRetry', `${h.retry} / ${h.wasted}`); put('tWqM', (h.avgWait / (h.out || 1) * 1000).toFixed(0) + ' ms'); }
  // 작업 유형별 p95 — 평균 하나로는 "어떤 작업이 먼저 SLO를 깨는가"가 안 보인다
  const cs = $('clsStats');
  if (MODEL.mixOn && h && h.cls) {
    const sloP95 = +$('sloP95').value;
    const rows = h.cls.map((c, i) => MODEL.mix[i] && MODEL.mix[i].share > 0
      ? `<tr><td>${c.name}</td><td>${Math.round(MODEL.mix[i].share * 100)}%</td><td>${c.done}/s</td><td style="color:${c.p95 > sloP95 ? 'var(--red)' : 'var(--ink)'};font-weight:${c.p95 > sloP95 ? 700 : 400}">${c.p95 ? Math.round(c.p95) + ' ms' : '–'}</td></tr>` : '').join('');
    cs.innerHTML = `<div class="note" style="margin:8px 0 4px">작업 유형별 (목표 p95 ${sloP95}ms)</div><table class="t"><tr><th>작업</th><th>비율</th><th>완료</th><th>p95</th></tr>${rows}</table>`;
  } else cs.innerHTML = '';
  put('tRhoT', th.rhoT.toFixed(2)); put('tRhoD', th.rhoD.toFixed(2));
  put('tDbEff', th.dbEffMs.toFixed(1) + ' ms');
  put('tCap', th.cap.toFixed(0)); put('tWq', isFinite(th.wq) ? th.wq.toFixed(0) + ' ms' : '∞');
  const b = detectBottleneck(S, MODEL), el = $('bottleneck'); el.dataset.level = b.level; el.querySelector('.t').textContent = b.title;
}
let last = performance.now(), acc = 0;
function frame(now) {
  let real = Math.min(100, now - last); last = now;
  if (!main.paused) {
    const tt = applyScenario(main);
    // trace 재생 중에는 applyScenario 가 MODEL.rps 를 최근 1초 실제 도착 수로 채운다
    if (scenarioKey !== 'manual') { $('rpsVal').textContent = Math.round(MODEL.rps); rpsEl.value = MODEL.rps; }
    renderExplain(tt);
    acc += real; while (acc >= MODEL.dt) { main.step(MODEL.dt); acc -= MODEL.dt; }
  }
  $('simClock').textContent = (main.S.t / 1000).toFixed(1) + 's';
  drawPlaybar();
  drawStage(main); drawTimeline(main); drawVerify();
  requestAnimationFrame(frame);
}
/* =====================================================================
 * 9. 공개 실측 데이터 — data/ 의 실제 트래픽 곡선을 시나리오로 재생
 *   validation/fetch_public.js 가 Wikimedia 등에서 받아 정규화해 둔 파일을 읽는다.
 *   절대 요청량이 아니라 *모양*(상대값 0~1)을 쓰고, 사용자가 정한 평균 유입으로 스케일한다.
 * ===================================================================== */
const DATA = { list: [], cur: null };
async function loadDatasetIndex() {
  try {
    const list = await (await fetch('data/index.json')).json();
    DATA.list = list;
    const sel = $('dataset');
    for (const d of list.filter(d => d.kind === 'traffic')) { const o = document.createElement('option'); o.value = d.id; o.textContent = `${d.name} (peak/평균 ${d.peakToMean}배)`; sel.appendChild(o); }
    // 가격표: 있으면 D5 카탈로그 교체
    const loaded = [];
    for (const meta of list.filter(d => d.kind === 'pricing')) {
      const p = await (await fetch('data/' + meta.file)).json();
      PRICE[p.tier] = p.items.map(i => [i.type, i.vcpu, i.gb, i.usdHour]).sort((a, b) => a[3] - b[3]);
      loaded.push(`${p.tier.toUpperCase()} ${p.items.length}종`);
    }
    if (loaded.length) PRICE.src = `${loaded.join(' · ')} — ap-northeast-2 실가격 (fetch_public.js)`;
    // 외부 지연 곡선: C2 검증 차트에 참고선으로
    const lat = list.find(d => d.kind === 'latency');
    if (lat) {
      const p = await (await fetch('data/' + lat.file)).json();
      VERIFY.ext = p;
      // rps 규모가 우리와 자릿수가 달라 C2에 겹치지 않는다. 대신 "무릎이 실제로 관측된다"는 외부 증거로 D3에 싣는다.
      const pts = p.points, a = pts[pts.length - 3], b = pts[pts.length - 1];
      if ($('extEvidence')) $('extEvidence').innerHTML = `<b>외부 실측 증거</b> — ${p.source}<br>`
        + `동시성 ${a.concurrency}→${b.concurrency} 에서 처리량은 ${fmt(a.rps)}→${fmt(b.rps)} rps (<b>+${Math.round((b.rps / a.rps - 1) * 100)}%</b>) 로 포화인데, `
        + `평균 지연은 ${a.avgMs}→${b.avgMs} ms (<b>${(b.avgMs / a.avgMs).toFixed(1)}배</b>). `
        + `자원을 더 밀어넣어도 처리량은 늘지 않고 지연만 오르는 ρ→1 무릎이 실제 측정에서도 그대로 나타난다.`;
    }
    $('dsInfo').innerHTML = `공개 데이터 ${list.length}개` + (loaded.length ? ` · 실가격 ${loaded.join(' / ')}` : '');
  } catch (e) {
    $('dsInfo').innerHTML = `데이터 없음 — <code>node validation/fetch_public.js</code> 실행 후 <code>python -m http.server</code> 로 열어야 합니다.`;
  }
}
async function selectDataset(id) {
  if (!id) { DATA.cur = null; CMP.ref = null; if (scenarioKey === 'realtraffic') { scenarioKey = 'manual'; $('scenario').value = 'manual'; } return; }
  const meta = DATA.list.find(d => d.id === id);
  const d = await (await fetch('data/' + meta.file)).json();
  DATA.cur = d;
  // 24시간(또는 일주일)을 화면 시간으로 압축: 점 하나당 5초
  const span = d.points.length * 5;
  SCENARIOS.realtraffic = {
    name: '' + d.name, period: span, params: {},
    at: (t) => { const i = Math.min(d.points.length - 1, Math.floor(t / 5)), nx = Math.min(d.points.length - 1, i + 1), f = (t / 5) - i;
      const rel = d.points[i].rel * (1 - f) + d.points[nx].rel * f;
      return { rps: Math.round(rel * DATA.peak) }; },
    explain: [
      { t: 0, text: `<b>${d.name}</b> — ${d.note || ''}` },
      { t: 5, text: `실제 관측된 트래픽 모양이다. 피크는 평균의 <b>${d.peakToMean}배</b>. 용량은 평균이 아니라 <b>피크</b>에 맞춰야 한다.` },
      { t: Math.round(span * .4), text: '피크 구간 — 여기서 실패가 나면 그 설정은 부적합. D4에서 이 피크로 최소 자원을 찾을 것.' },
      { t: Math.round(span * .75), text: `저점 구간 — 피크에 맞춘 자원은 이 시간 동안 놀고 있다. 이것이 용량 계획의 비용이다 (이용률 ${Math.round(100 / d.peakToMean)}%).` },
    ],
    dataset: d,
  };
  applyAvgRps();
  $('scenario').value = 'realtraffic';
  if (![...$('scenario').options].some(o => o.value === 'realtraffic')) { const o = document.createElement('option'); o.value = 'realtraffic'; o.textContent = SCENARIOS.realtraffic.name; $('scenario').appendChild(o); }
  else [...$('scenario').options].find(o => o.value === 'realtraffic').textContent = SCENARIOS.realtraffic.name;
  $('scenario').value = 'realtraffic';
  scenarioKey = 'realtraffic'; scenarioStart = main.S.t; $('ctlRps').classList.add('disabled'); renderExplain(0);
  $('dsInfo').innerHTML = `<b>${d.name}</b> · 피크/평균 ${d.peakToMean}배 → <b>피크 ${DATA.peak} rps</b><br><span class="hint">${d.points.length}점 · 출처 ${d.source} · ③의 피크 유입에 자동 입력됨</span>`;
}
function applyAvgRps() {
  const avg = +$('avgRps').value; $('avgRpsVal').textContent = avg;
  if (!DATA.cur) return;
  DATA.peak = Math.round(avg * DATA.cur.peakToMean);
  $('sloRps').value = DATA.peak;                        // D4 피크 입력에 반영
  CMP.ref = { name: DATA.cur.name.slice(0, 12), p50: 0, peak: DATA.peak, avg };
}
$('dataset').addEventListener('change', (e) => selectDataset(e.target.value));
$('avgRps').addEventListener('input', () => { applyAvgRps(); if (DATA.cur) $('dsInfo').innerHTML = `<b>${DATA.cur.name}</b> · 피크/평균 ${DATA.cur.peakToMean}배 → <b>피크 ${DATA.peak} rps</b>`; });
loadDatasetIndex();

/* =====================================================================
 * 10. 시나리오 파일 — docs/scenario-format.md 형식의 JSON 을 불러와 드롭다운에 등록
 *   파싱·배율·재생은 engine.js 4b. 여기는 파일 읽기(file.text — file:// 로 열어도 동작)와 옵션 UI 뿐이다.
 *   배율 옵션은 불러온 파일마다 따로 기억한다.
 * ===================================================================== */
const SCF = { files: new Map(), cur: null, timer: 0 };
const SCF_DEFAULT = { N: 1, jitter_ms: 30000, seed: 1, excl: true };
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtRps = (v) => v >= 100 ? Math.round(v).toLocaleString() : v >= 10 ? v.toFixed(1) : v.toFixed(2);
function fmtDur(ms) {
  const s = ms / 1000, txt = `${Number.isInteger(s) ? s : s.toFixed(2)}초`;
  return s >= 60 ? `${txt} (${Math.floor(s / 60)}분 ${Math.round(s % 60)}초)` : txt;
}
function showScErrors(errs, title) {
  $('scFileErr').innerHTML = errs.length
    ? `<b>${escHtml(title || '오류')}</b><ul>${errs.map(e => `<li>${escHtml(e)}</li>`).join('')}</ul><div>이전 시나리오를 그대로 유지합니다.</div>`
    : '';
}
function selectScenarioKey(key) {
  let o = [...scSel.options].find(x => x.value === key);
  if (!o) { o = document.createElement('option'); o.value = key; scSel.appendChild(o); }
  o.textContent = SCENARIOS[key].name;
  scSel.value = key;
  scSel.dispatchEvent(new Event('change'));   // 기존 처리: scenarioKey · scenarioStart(=0초부터) · params 반영
}
// 배율을 적용해 등록하고 0초부터 재생. 실패하면 SCENARIOS 는 그대로다
function applyScFile(st) {
  const o = st.opts;
  const r = registerFileScenario(st.sc, { N: o.N, jitter_ms: o.jitter_ms, seed: o.seed, exclude_src: o.excl ? TRACE_EXCLUDE_DEFAULT : [] });
  if (!r.ok) { showScErrors(r.errors, '배율 적용 실패'); return false; }
  st.before = r.before; st.after = r.after; PB_KEY = '';
  selectScenarioKey(r.key);
  return true;
}
async function loadScenarioFile(file) {
  if (!file) return;
  let text;
  try { text = await file.text(); } catch (e) { showScErrors([`파일을 읽지 못했습니다: ${e.message}`], `불러오기 실패 — ${file.name}`); return; }
  const res = parseScenarioFile(text);
  if (!res.ok) { showScErrors(res.errors, `불러오기 실패 — ${file.name}`); return; }
  const key = 'file:' + res.scenario.name;
  const st = { key, sc: res.scenario, fileName: file.name, warnings: res.warnings, opts: Object.assign({}, SCF_DEFAULT) };
  if (!applyScFile(st)) return;
  SCF.files.set(key, st); SCF.cur = key;
  showScErrors([]); syncScInputs(st); renderScFile();
}
function syncScInputs(st) {
  $('scN').value = st.opts.N; $('scJitter').value = st.opts.jitter_ms; $('scSeed').value = st.opts.seed; $('scExcl').checked = st.opts.excl;
  syncJitterBtns();
}
// 흩뜨림 값이 버튼 값과 같으면 그 버튼을 강조 (고급에서 다른 값을 넣으면 둘 다 꺼진다)
function syncJitterBtns() {
  document.querySelectorAll('#scJitterRow [data-j]').forEach(b => b.classList.toggle('on', +b.dataset.j === +$('scJitter').value));
}
function readScInputs() {
  const N = +$('scN').value, J = +$('scJitter').value, seed = Number($('scSeed').value), errs = [];
  if (!(N >= 0.1 && N <= 1000)) errs.push('배율 N은 0.1 ~ 1000 사이여야 합니다.');
  if (!(J >= 0 && J <= 600000)) errs.push('흩뜨림 범위는 0 ~ 600000ms 사이여야 합니다.');
  if (!Number.isInteger(seed)) errs.push('시드는 정수여야 합니다.');
  if (errs.length) { showScErrors(errs, '배율 옵션 오류'); return null; }
  return { N, jitter_ms: J, seed, excl: $('scExcl').checked };
}
function onScOpt() {
  syncJitterBtns();
  clearTimeout(SCF.timer);
  SCF.timer = setTimeout(() => {
    const st = SCF.files.get(SCF.cur); if (!st) return;
    const o = readScInputs(); if (!o) return;
    st.opts = o;
    if (applyScFile(st)) { showScErrors([]); renderScFile(); }
  }, 300);
}
// 화면에는 이름 · 모드 · 길이 · 요청 수만. 출처 · 원본 파일명 · 시작 시각 · 묶음 수는 이름에 마우스를 올리면 보인다
function renderScFile() {
  const st = SCF.files.get(SCF.cur), box = $('scScale');
  $('scFileBox').classList.toggle('loaded', SCF.files.size > 0);
  if (!st) { $('scFileInfo').innerHTML = ''; box.style.display = 'none'; renderMixFileInfo(); return; }
  const sc = st.sc, src = sc.source || {}, isTrace = sc.mode === 'trace', ev = sc.events;
  const origin = [src.type || '출처 미상', src.synthetic === true ? '합성' : src.synthetic === false ? '실측' : null, src.truncated ? '일부 구간' : null].filter(Boolean).join(' · ');
  const tip = [`파일 ${st.fileName}`, `출처 ${origin}`, sc.loop ? '반복 재생' : '1회 재생',
    src.start_utc && `시작 ${src.start_utc} (UTC)`,
    isTrace && `묶음 ${ev.groupCount.toLocaleString()}개 (함께 발생한 요청 단위 — 배율은 묶음째 복제)`,
    sc.description].filter(Boolean).join('\n');
  const H = [`<div class="scname" title="${escHtml(tip)}"><b>${escHtml(sc.name)}</b></div>`,
    `<div class="kv"><span><b>${sc.mode}</b></span><span>${fmtDur(sc.duration_ms)}</span>${isTrace ? `<span>요청 <b>${ev.n.toLocaleString()}</b>건</span>` : ''}</div>`];
  for (const w of st.warnings) H.push(`<div class="scwarn">${escHtml(w)}</div>`);
  $('scFileInfo').innerHTML = H.join('');
  box.style.display = '';
  $('scJitterRow').style.display = isTrace ? '' : 'none';
  $('scAdv').style.display = isTrace ? '' : 'none';
  $('scExclRow').style.display = isTrace && ev.srcNames.some(s => TRACE_EXCLUDE_DEFAULT.includes(s)) ? '' : 'none';   // 크론·관리자 요청이 있는 파일에서만
  const b = st.before, a = st.after, head = `<tr><th></th><th>원본</th><th>×${st.opts.N}</th></tr>`;
  const table = (R) => head + R.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td><b>${r[2]}</b></td></tr>`).join('');
  $('scStats').innerHTML = table([['평균 rps', fmtRps(b.meanRps), fmtRps(a.meanRps)],
    isTrace ? ['가장 붐빈 1초', b.peak.toLocaleString(), a.peak.toLocaleString()] : ['최대 rps', fmtRps(b.peak), fmtRps(a.peak)]]);
  $('scStats2').innerHTML = isTrace ? table([['총 요청', b.n.toLocaleString(), a.n.toLocaleString()], ['배율 대상 묶음', b.bundles.toLocaleString(), a.bundles.toLocaleString()]]) : '';
  renderMixFileInfo();
}
// 작업 패널에 지금 재생 중인 trace 파일의 조회·검색·쓰기 비율을 한 줄로 (0 인 유형은 뺀다)
function renderMixFileInfo() {
  const st = SCF.files.get(scenarioKey), el = $('mixFileInfo');
  if (!st || st.sc.mode !== 'trace') { el.innerHTML = ''; return; }
  const ev = st.sc.events, parts = [['조회', ev.opCount[0]], ['검색', ev.opCount[1]], ['쓰기', ev.opCount[2]]].filter(p => p[1] > 0);
  el.innerHTML = `<span title="${parts.map(([k, v]) => `${k} ${v.toLocaleString()}건`).join(' · ')} — 재생 중에는 위 비율 대신 이 구성을 쓴다">`
    + `이 파일: <b>${parts.map(([k, v]) => `${k} ${Math.round(v / ev.n * 100)}%`).join(' · ')}</b></span>`
    + (BASE.mixOn ? '' : ` · <span style="color:var(--warn)">켜기 꺼짐 → 전부 기본 DB 시간</span>`);
}
// 드롭다운에서 다른 파일 시나리오를 고르면 그 파일의 정보·옵션을 보여 준다
scSel.addEventListener('change', () => {
  if (SCF.files.has(scSel.value) && SCF.cur !== scSel.value) { SCF.cur = scSel.value; syncScInputs(SCF.files.get(SCF.cur)); renderScFile(); }
  renderMixFileInfo();
});
$('mixOn').addEventListener('change', renderMixFileInfo);
$('btnScFile').addEventListener('click', () => $('scFileInput').click());
$('scFileInput').addEventListener('change', (e) => { loadScenarioFile(e.target.files[0]); e.target.value = ''; });
{
  const box = $('scFileBox');
  box.addEventListener('dragenter', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drag'); });
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); loadScenarioFile(e.dataTransfer && e.dataTransfer.files[0]); });
  // 상자 밖에 떨어뜨려도 브라우저가 JSON 파일로 이동해 버리지 않게
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
}
for (const id of ['scN', 'scJitter', 'scSeed']) $(id).addEventListener('input', onScOpt);
$('scExcl').addEventListener('change', onScOpt);
document.querySelectorAll('#scScale [data-n]').forEach(b => b.addEventListener('click', () => { $('scN').value = b.dataset.n; onScOpt(); }));
document.querySelectorAll('#scJitterRow [data-j]').forEach(b => b.addEventListener('click', () => { $('scJitter').value = b.dataset.j; onScOpt(); }));

renderExplain(0); updateStats(); markStep(); setInterval(markStep, 2000); requestAnimationFrame(frame);

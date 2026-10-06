/* 韩语背单词 —— 阶段 1 骨架
 *
 * 这个版本只做四件事，目的是先在 iPad 上验证"能不能用"：
 *   1. 能把词显示出来、翻面看意思
 *   2. 能用手写（Apple Pencil）
 *   3. 能听韩语朗读（用 iPad 系统自带的语音）
 *   4. 进度能存在本机，关掉再打开还在
 *
 * 真正的"复习排期 / 每日配额 / 听写"在阶段 2 加。
 */

// ============================================================
// 一、存进度（localStorage = 浏览器自带的本地小仓库）
// ============================================================

const STORE_KEY = 'kr-vocab-v1';
const PER_DAY = 20;          // 阶段 1 先固定每天 20 个，阶段 2 再按需求改成 10+60

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return { version: 1, day: todayStr(), doneToday: 0, pos: 0, marks: {}, queueAdds: {} };
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let state = loadState();
// 跨天了：进度位置留着，但"今天做了几个"归零
if (state.day !== todayStr()) {
  state.day = todayStr();
  state.doneToday = 0;
}

// ============================================================
// 二、读数据
// ============================================================

let WORDS = [];
let META = {};

async function loadWords() {
  const res = await fetch('data/words.json');
  const data = await res.json();
  WORDS = data.words;
  META = data.meta;
}

// ============================================================
// 三、朗读（Web Speech API = 浏览器调用系统语音）
// ============================================================

let koVoice = null;

function refreshVoices() {
  if (!('speechSynthesis' in window)) return;
  const vs = speechSynthesis.getVoices() || [];
  koVoice = vs.find(v => /^ko/i.test(v.lang)) || null;
  return vs;
}

function speak(text, rate) {
  if (!('speechSynthesis' in window)) return false;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    if (koVoice) u.voice = koVoice;
    u.rate = rate || 0.95;
    speechSynthesis.speak(u);
    return true;
  } catch (e) {
    return false;
  }
}

// 有些浏览器语音列表是异步加载的
if ('speechSynthesis' in window) {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

// ============================================================
// 四、手写画布（canvas）
//    关键点：只认"笔"（pointerType === 'pen'），手掌碰到的算 touch，直接忽略
//    —— 这就是网页上做"防误触"最简单可靠的办法
// ============================================================

function setupPad(canvas, opts) {
  const o = opts || {};
  const ctx = canvas.getContext('2d');
  let drawing = false, last = null, penOnly = true;

  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = o.width || 2.6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1c1c1e';
  }
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 300));

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function note(t) {
    if (o.onInfo) o.onInfo(t);
  }

  canvas.addEventListener('pointerdown', e => {
    if (penOnly && e.pointerType !== 'pen') {
      note(`忽略了一次「${e.pointerType === 'touch' ? '手指/手掌' : e.pointerType}」触碰（防误触生效中）`);
      return;
    }
    e.preventDefault();
    drawing = true;
    last = pos(e);
    note(`正在用「${e.pointerType}」书写`);
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    // 点一个点也要留下痕迹
    ctx.beginPath();
    ctx.arc(last.x, last.y, (o.width || 2.6) / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1c1e';
    ctx.fill();
  });

  canvas.addEventListener('pointermove', e => {
    if (!drawing) return;
    if (penOnly && e.pointerType !== 'pen') return;
    e.preventDefault();
    const evts = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
    for (const ev of evts) {
      const p = pos(ev);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      last = p;
    }
  });

  function end(e) {
    if (!drawing) return;
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', end);

  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); },
    setPenOnly(v) { penOnly = v; },
  };
}

// ============================================================
// 五、背单词主流程
// ============================================================

let queue = [];      // 待学的词（存的是词的 id 字符串）
let byId = new Map();
let flipped = false;

function buildQueue() {
  byId = new Map(WORDS.map(w => [w.id, w]));
  // 从上次停下的位置接着往后；到末尾就从头来（阶段 1 不做排期）
  const ids = WORDS.map(w => w.id);
  let start = Math.min(state.pos || 0, Math.max(0, ids.length - 1));
  queue = ids.slice(start, start + PER_DAY);
  if (queue.length === 0) queue = ids.slice(0, PER_DAY);
}

function currentWord() {
  return byId.get(queue[0]);
}

function renderCard() {
  const w = currentWord();
  if (!w) {
    document.getElementById('korean').textContent = '今天到这儿';
    return;
  }
  const m = state.marks[w.id] || { right: 0, wrong: 0 };

  document.getElementById('korean').textContent = w.korean;
  document.getElementById('pron').textContent = w.pron ? `发音 ${w.pron}` : '';
  document.getElementById('zh').textContent = w.zh || '（这个词没有中文释义）';
  document.getElementById('zhDfn').textContent = w.zhDfn || '';
  document.getElementById('metaLine').textContent =
    `${w.pos || ''}${w.grade ? ' · ' + w.grade : ''} · 第${w.chapter}课 第${w.unit}节 · 对${m.right} 错${m.wrong}` +
    (w.src === 'krdict' ? ' · 释义来自官方词典' : ' · 释义来自开源词表');

  const exWrap = document.getElementById('exWrap');
  const exEl = document.getElementById('ex');
  exEl.innerHTML = '';
  if (w.examples && w.examples.length) {
    exWrap.hidden = false;
    for (const s of w.examples) {
      const d = document.createElement('div');
      d.textContent = s;
      exEl.appendChild(d);
    }
  } else {
    exWrap.hidden = true;
  }

  document.getElementById('counter').textContent =
    `今天第 ${state.doneToday + 1} 个（本批还剩 ${queue.length}） · 全书第 ${state.pos + 1} / ${WORDS.length}`;
  document.getElementById('progressLine').textContent =
    `已学 ${Object.keys(state.marks).length} 个词 · 今天完成 ${state.doneToday} 个`;
}

function flip(showBack) {
  flipped = showBack;
  document.getElementById('front').hidden = showBack;
  document.getElementById('back').hidden = !showBack;
  document.getElementById('flipBtn').hidden = showBack;
  document.getElementById('goodBtn').hidden = !showBack;
  document.getElementById('againBtn').hidden = !showBack;
  if (showBack) pad.clear();
}

function answer(ok) {
  const w = currentWord();
  if (!w) return;
  const m = state.marks[w.id] || { right: 0, wrong: 0 };
  if (ok) {
    m.right++;
    queue.shift();
    state.pos++;
    state.doneToday++;
  } else {
    m.wrong++;
    // 不记得的，往后挪 3 个位置再见一次
    const [id] = queue.splice(0, 1);
    queue.splice(Math.min(3, queue.length), 0, id);
  }
  state.marks[w.id] = m;
  saveState();
  flip(false);
  renderCard();
  if (ok && state.doneToday >= PER_DAY) {
    document.getElementById('counter').textContent = '今天的量做完了 🎉';
  }
}

// ============================================================
// 六、自检页
// ============================================================

function runSelfTest() {
  // ① 是不是从主屏幕图标打开的
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  setHTML('t-standalone', standalone
    ? '<span class="ok">是</span> —— 很好，进度不会被系统定期清理。'
    : '<span class="warn">否</span> —— 现在是在 Safari 标签页里打开的。点分享 →「添加到主屏幕」，然后从主屏图标打开。');

  // ② 本地存储
  let storeOk = false, storeDetail = '';
  try {
    localStorage.setItem('__t', '1');
    storeOk = localStorage.getItem('__t') === '1';
    localStorage.removeItem('__t');
    let used = 0;
    for (const k in localStorage) if (Object.prototype.hasOwnProperty.call(localStorage, k)) {
      used += (localStorage[k] || '').length + k.length;
    }
    storeDetail = `已用约 ${(used / 1024).toFixed(1)} KB`;
  } catch (e) {
    storeDetail = '被拒绝：' + e.message;
  }
  setHTML('t-storage', storeOk
    ? `<span class="ok">可写</span> —— ${storeDetail}`
    : `<span class="no">不可用</span> —— ${storeDetail}`);

  // ③ 语音
  const vs = refreshVoices() || [];
  const ko = vs.filter(v => /^ko/i.test(v.lang));
  setHTML('t-voices', vs.length === 0
    ? '<span class="no">这个设备报告了 0 个语音</span>（可能是还没加载完，稍等再点一次"背单词"页回来）'
    : ko.length
      ? `<span class="ok">找到 ${ko.length} 个韩语语音</span>：${ko.map(v => v.name).join('、')}`
      : `<span class="no">没有韩语语音</span>（共 ${vs.length} 个语音，但都不是韩语）—— 需要去 iPad 设置里下载`);

  // ④ 笔
  setHTML('t-penInfo', '还没检测到笔。用笔在下面的框里写一笔试试。');

  // ⑤ 数据出处
  setHTML('t-meta', META.total
    ? `共 <b>${META.total}</b> 条；其中 <b>${META.withDict}</b> 条来自官方词典、<b>${META.withExample}</b> 条带例句。<br>` +
      `<span class="tiny">${(META.sources || []).join('<br>')}</span>`
    : '数据还没加载。');
}

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ============================================================
// 七、启动
// ============================================================

let pad, padTest;

function switchView(name) {
  document.getElementById('view-study').hidden = name !== 'study';
  document.getElementById('view-test').hidden = name !== 'test';
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  if (name === 'test') runSelfTest();
}

async function main() {
  await loadWords();
  buildQueue();

  pad = setupPad(document.getElementById('pad'), {
    onInfo: t => { document.getElementById('penInfo').textContent = t; },
  });
  padTest = setupPad(document.getElementById('padTest'), {
    onInfo: t => setHTML('t-penInfo', `<span class="ok">检测到输入类型：${t}</span>`),
  });

  document.getElementById('penOnly').addEventListener('change', e => {
    pad.setPenOnly(e.target.checked);
    padTest.setPenOnly(e.target.checked);
    document.getElementById('penInfo').textContent = e.target.checked
      ? '只认笔：手指和手掌不会画出线'
      : '手指也能画（手掌碰到会画出线）';
  });

  document.getElementById('clearPad').addEventListener('click', () => pad.clear());
  document.getElementById('t-clearPad').addEventListener('click', () => padTest.clear());

  document.getElementById('flipBtn').addEventListener('click', () => flip(true));
  document.getElementById('goodBtn').addEventListener('click', () => answer(true));
  document.getElementById('againBtn').addEventListener('click', () => answer(false));
  document.getElementById('speakBtn').addEventListener('click', () => {
    const w = currentWord();
    if (w) speak(w.korean);
  });
  document.getElementById('t-speak1').addEventListener('click', () => speak('안녕하세요'));
  document.getElementById('t-speak2').addEventListener('click', () => speak('선생님! 질문 있어요.'));

  document.querySelectorAll('.tab').forEach(b => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  // 点卡片任意处也能翻面
  document.getElementById('card').addEventListener('click', e => {
    if (e.target.id === 'speakBtn') return;
    flip(!flipped);
  });

  renderCard();
  switchView('study');
}

main().catch(err => {
  document.getElementById('counter').textContent = '加载失败：' + err.message;
  console.error(err);
});

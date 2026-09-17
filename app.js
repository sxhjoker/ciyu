/* 词语复习 · 纯静态单页应用（数据+进度在手机本地，AI 直连 DeepSeek）
   注意：为兼容旧手机浏览器（微信内置/X5 内核），不使用 Object.fromEntries / flatMap / 对象展开语法。 */
"use strict";

/* 错误可见化：任何脚本错误都显示在页面上，便于排查 */
window.onerror = function (msg, src, line) {
  try {
    var el = document.getElementById("main");
    if (el) {
      el.innerHTML = '<div class="card" style="color:#dc2626">页面脚本出错：' + String(msg) +
        '（第' + line + '行）。<br><span class="muted">请把这段文字截图发给开发者；或尝试用最新版 Chrome/Edge/Safari 打开。</span></div>';
    }
  } catch (e) {}
  return false;
};

function $(sel, el) { return (el || document).querySelector(sel); }
var main = $("#main");
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/* ---------- 数据 ---------- */
var SECTIONS = [], WORDS = [], QUESTIONS = [], CONFUSABLES = [], SIHAI = [];
var WORD_INDEX = {}, WORD_ORDER = {};

function loadData() {
  return Promise.all([
    fetch("./data/sections.json").then(function (r) { return r.json(); }),
    fetch("./data/words.json").then(function (r) { return r.json(); }),
    fetch("./data/questions.json").then(function (r) { return r.json(); }),
    fetch("./data/confusables.json").then(function (r) { return r.json(); }),
    fetch("./data/sihai_questions.json").then(function (r) { return r.json(); }),
  ]).then(function (rs) {
    SECTIONS = rs[0]; WORDS = rs[1]; QUESTIONS = rs[2]; CONFUSABLES = rs[3]; SIHAI = rs[4];
    WORD_INDEX = {};
    WORDS.forEach(function (w) { WORD_INDEX[w.id] = w; });
    WORD_ORDER = {};
    WORDS.forEach(function (w, i) { WORD_ORDER[w.id] = i; });
  });
}

/* ---------- 本地存储 ---------- */
var LS_PROGRESS = "ciyu_progress", LS_AI_CACHE = "ciyu_ai_cache", LS_DS_KEY = "ciyu_dskey";

function defaultProgress() {
  return { words: {}, settings: { daily_new: 20, mixed_new: false, practice_count: 10 }, wrong_book: {}, study_log: {} };
}
function loadProgress() {
  try {
    var d = JSON.parse(localStorage.getItem(LS_PROGRESS) || "null");
    if (!d) return defaultProgress();
    var base = defaultProgress();
    var st = {};
    for (var k in base.settings) st[k] = (d.settings && d.settings[k] != null) ? d.settings[k] : base.settings[k];
    return { words: d.words || {}, settings: st, wrong_book: d.wrong_book || {}, study_log: d.study_log || {} };
  } catch (e) { return defaultProgress(); }
}
function saveProgress(p) { localStorage.setItem(LS_PROGRESS, JSON.stringify(p)); }
function loadAiCache() { try { return JSON.parse(localStorage.getItem(LS_AI_CACHE) || "{}"); } catch (e) { return {}; } }
function saveAiCache(c) { localStorage.setItem(LS_AI_CACHE, JSON.stringify(c)); }

/* ---------- 日期与 SRS ---------- */
function dateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function todayStr() { return dateStr(new Date()); }
function addDays(n) {
  var d = new Date(); d.setDate(d.getDate() + n); return dateStr(d);
}
function defaultState() {
  return { status: "new", interval: 0, streak: 0, lapses: 0, due: null, introduced_on: null };
}
function gradeState(st, g) {
  var s = {};
  for (var k in (st || defaultState())) s[k] = st[k];
  if ((s.status || "new") === "new") {
    if (g === "again") return [s, true];
    s.status = "learning"; s.interval = 1;
    s.streak = g === "good" ? 1 : 0;
    s.due = addDays(1);
    return [s, false];
  }
  if (g === "good") {
    s.interval = Math.min((s.interval || 1) * 2, 120);
    s.streak = (s.streak || 0) + 1;
    if (s.streak >= 3) s.status = "mature";
  } else if (g === "hard") {
    s.interval = Math.min(Math.ceil((s.interval || 1) * 1.5), 120);
    s.streak = 0; s.status = "learning";
  } else {
    s.interval = 1; s.streak = 0; s.lapses = (s.lapses || 0) + 1;
    s.status = "learning"; s.due = todayStr();
    return [s, true];
  }
  s.due = addDays(s.interval);
  return [s, false];
}
function dateSeed(s) {
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function seededShuffle(arr, seed) {
  var a = arr.slice(), x = seed || 1;
  function rnd() { x = (x * 1103515245 + 12345) >>> 0; return x / 4294967296; }
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(rnd() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---------- DeepSeek ---------- */
function callDeepseek(messages, temp) {
  var key = localStorage.getItem(LS_DS_KEY);
  if (!key) return Promise.reject(new Error("未配置 DeepSeek key，请到「设置」页填写"));
  return fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: messages, temperature: temp || 0.6, stream: false, thinking: { type: "disabled" } }),
  }).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) throw new Error((d && d.error && d.error.message) || ("API 错误 " + r.status));
      return d.choices[0].message.content;
    });
  });
}
function aiExplainWord(w) {
  var cache = loadAiCache();
  if (cache[w.id]) return Promise.resolve({ text: cache[w.id], cached: true });
  var prompt =
    "你是公考言语理解辅导老师。请为下面这个词写一段 80~150 字的讲解，面向备考者，包含：①本义与引申义 " +
    "②最常考的语境/搭配 ③一个记忆技巧（联想或拆分）④与最容易混淆的近义词的一句话辨析（如适用对象、褒贬、侧重）。直接输出讲解正文，不要标题。\n\n" +
    "词：" + w.name + "（" + (w.type === "cy" ? "成语" : "实词") + "）\n书中释义：" + w.definition + "\n" +
    (w.examples && w.examples.length ? "例句：" + w.examples[0] : "");
  return callDeepseek([{ role: "user", content: prompt }], 0.6).then(function (text) {
    cache[w.id] = text;
    saveAiCache(cache);
    return { text: text, cached: false };
  });
}

/* ---------- 队列构建 ---------- */
function buildQueue(prog, t) {
  var stMap = prog.words, due = [], introduced = [];
  WORDS.forEach(function (w) {
    var st = stMap[w.id];
    if (!st) return;
    if (["learning", "review", "mature"].indexOf(st.status) >= 0 && st.due && st.due <= t) due.push(w);
    if (st.status === "new" && st.introduced_on === t) introduced.push(w);
  });
  due.sort(function (a, b) {
    return (stMap[a.id].due || "").localeCompare(stMap[b.id].due || "") || WORD_ORDER[a.id] - WORD_ORDER[b.id];
  });
  var quota = prog.settings.daily_new - introduced.length;
  var candidates = WORDS.filter(function (w) {
    var st = stMap[w.id];
    return (!st || st.status === "new") && !(st && st.introduced_on);
  });
  if (prog.settings.mixed_new) candidates = seededShuffle(candidates, dateSeed("daily-" + t));
  var picks = candidates.slice(0, Math.max(0, quota));
  picks.forEach(function (w) {
    var base = stMap[w.id] || defaultState();
    var st = {};
    for (var k in base) st[k] = base[k];
    st.introduced_on = t;
    stMap[w.id] = st;
  });
  var queue = introduced.concat(due, picks).map(function (w) {
    var st = stMap[w.id] || defaultState();
    return {
      word_id: w.id, name: w.name, type: w.type, section_id: w.section_id,
      subtheme: w.subtheme || "", definition: w.definition, examples: w.examples,
      is_new: st.status === "new", is_due: st.status !== "new", lapses: st.lapses || 0,
    };
  });
  return { queue: queue, due_count: due.length, new_count: introduced.length + picks.length };
}

function calcStats(prog) {
  var t = todayStr();
  var by = { new: 0, learning: 0, review: 0, mature: 0 }, dueToday = 0;
  WORDS.forEach(function (w) {
    var st = prog.words[w.id] || {};
    by[st.status || "new"] = (by[st.status || "new"] || 0) + 1;
    if (["learning", "review", "mature"].indexOf(st.status) >= 0 && st.due && st.due <= t) dueToday++;
  });
  var streak = 0, d = new Date();
  while (true) {
    var x = new Date(d);
    x.setDate(x.getDate() - streak);
    if (!prog.study_log[dateStr(x)]) break;
    streak++;
  }
  var wrongTotal = 0;
  for (var qid in prog.wrong_book) wrongTotal += prog.wrong_book[qid].count || 0;
  return {
    total: WORDS.length, by_status: by, learned: WORDS.length - by.new,
    due_today: dueToday, streak: streak, wrong_total: wrongTotal,
  };
}

/* ---------- 状态 ---------- */
var curTab = "study";
var studyQueue = [];
var practiceCfg = { mode: "mixed", count: 10 };
var practiceList = [], practiceIdx = 0, practiceScore = 0;

function switchTab(name) {
  curTab = name;
  document.querySelectorAll(".tab").forEach(function (t) {
    t.classList.toggle("active", t.dataset.view === name);
  });
  if (name === "study") renderStudy();
  else if (name === "library") renderLibrary();
  else if (name === "practice") renderPracticeHome();
  else if (name === "confus") renderConfus();
  else renderSettings();
}

/* 底部 Tab 点击绑定 */
document.querySelectorAll(".tab").forEach(function (t) {
  t.addEventListener("click", function () { switchTab(t.dataset.view); });
});

/* ================= 今日 / 学习 ================= */
function renderStudy() {
  var prog = loadProgress(), t = todayStr();
  var r = buildQueue(prog, t);
  saveProgress(prog);
  studyQueue = r.queue;
  var st = calcStats(prog);
  var todayLog = prog.study_log[t] || { new: 0, reviewed: 0, wrong: 0 };
  main.innerHTML =
    '<h1>今日学习</h1>' +
    '<div class="stats-row">' +
    '<div class="stat"><div class="num">' + r.new_count + '</div><div class="label">今日新词 / ' + prog.settings.daily_new + '</div></div>' +
    '<div class="stat"><div class="num">' + r.due_count + '</div><div class="label">到期复习</div></div>' +
    '<div class="stat"><div class="num">' + st.streak + '</div><div class="label">连续天数</div></div>' +
    '</div>' +
    '<div class="card">' +
    '<div class="muted" style="margin-bottom:6px">词库进度</div>' +
    '<div class="progress-bar"><div style="width:' + (st.total ? Math.round(st.learned / st.total * 100) : 0) + '%"></div></div>' +
    '<div class="muted" style="margin-top:6px">已学 ' + st.learned + ' / ' + st.total + ' 词 · 错题 ' + st.wrong_total + ' 道 · 今日已练 ' + (todayLog.new + todayLog.reviewed) + ' 张</div>' +
    '</div>' +
    (r.queue.length
      ? '<button class="btn" id="start-study">开始学习（' + r.queue.length + ' 张卡片）</button>'
      : '<div class="card" style="text-align:center;color:var(--gray)">今日任务已完成 🎉<br><span class="muted">新词已发完、到期词已清空</span></div>');
  var btn = $("#start-study");
  if (btn) btn.addEventListener("click", startStudyFlow);
}

function startStudyFlow() {
  main.innerHTML =
    '<div class="study-card" id="scard"><div class="word-name" id="sword"></div><div class="hint" id="shint">点击卡片看释义</div></div>' +
    '<div class="grade-row" id="grade-row" style="display:none">' +
    '<button class="grade-btn again" data-g="again">不认识</button>' +
    '<button class="grade-btn hard" data-g="hard">模糊</button>' +
    '<button class="grade-btn good" data-g="good">认识</button>' +
    '</div>' +
    '<div class="muted" style="text-align:center;margin-top:10px" id="spos"></div>';
  showCard(0);
}

function showCard(idx) {
  if (idx >= studyQueue.length) { renderStudySummary(); return; }
  var w = studyQueue[idx];
  $("#spos").textContent = "第 " + (idx + 1) + " / " + studyQueue.length + " 张";
  var card = $("#scard");
  card.classList.remove("study-back");
  var badge = w.is_new ? '<span class="badge new">新词</span>'
    : '<span class="badge due">复习' + (w.lapses ? " · 忘过 " + w.lapses + " 次" : "") + "</span>";
  card.innerHTML =
    '<div class="word-name">' + esc(w.name) + "</div>" +
    '<div class="hint">' + badge + " · " + esc(w.section_id) + " · 点击卡片看释义</div>";
  $("#grade-row").style.display = "none";
  card.onclick = function () {
    card.classList.add("study-back");
    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div style="font-size:20px;font-weight:700">' + esc(w.name) + '</div>' +
      '<button class="back-btn" id="ai-explain">AI 讲词</button></div>' +
      '<div class="def">' + esc(w.definition) + "</div>" +
      (w.examples || []).map(function (e) { return '<div class="ex">' + esc(e) + "</div>"; }).join("") +
      '<div class="hint" style="margin-top:12px">自评一下，然后点下面的按钮</div>';
    $("#ai-explain").addEventListener("click", function (ev) { ev.stopPropagation(); showAiExplain(w.word_id); });
    $("#grade-row").style.display = "flex";
  };
}

function renderStudySummary() {
  main.innerHTML =
    '<div class="card" style="text-align:center;padding:40px 20px">' +
    '<div style="font-size:44px">🎉</div><h2>本轮完成！</h2>' +
    '<p class="muted">今日学习 ' + studyQueue.length + ' 张卡片。忘掉的词明天还会回来找你。</p>' +
    '<button class="btn" id="back-today">返回今日页</button></div>';
  $("#back-today").addEventListener("click", renderStudy);
}

document.addEventListener("click", function (e) {
  var g = e.target.closest(".grade-btn");
  if (!g) return;
  var grade = g.dataset.g;
  var w = studyQueue[0];
  if (!w) return;
  var prog = loadProgress(), t = todayStr();
  var st = prog.words[w.word_id] || defaultState();
  var wasNew = st.status === "new";
  if (wasNew && !st.introduced_on) st.introduced_on = t;
  var r = gradeState(st, grade);
  prog.words[w.word_id] = r[0];
  var log = prog.study_log[t] = prog.study_log[t] || { new: 0, reviewed: 0, wrong: 0 };
  if (wasNew && grade !== "again") log.new++; else log.reviewed++;
  saveProgress(prog);
  var done = studyQueue.shift();
  if (r[1]) studyQueue.push(done);
  showCard(0);
});

function showAiExplain(wordId) {
  var w = WORD_INDEX[wordId];
  if (!w) return;
  var mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = '<div class="modal"><h2>AI 讲词</h2><div class="loading" id="ex-body">生成中…（首次需几秒，之后有缓存）</div></div>';
  main.appendChild(mask);
  mask.addEventListener("click", function (e) { if (e.target === mask) mask.remove(); });
  aiExplainWord(w).then(function (d) {
    $("#ex-body").innerHTML = '<div style="line-height:1.8;white-space:pre-wrap">' + esc(d.text) + "</div>" +
      (d.cached ? '<div class="muted" style="margin-top:8px">（缓存）</div>' : "");
  }).catch(function (err) {
    $("#ex-body").innerHTML = "<div>" + esc(err.message) + '</div><button class="btn secondary" style="margin-top:12px" id="retry-ex">重试</button>';
    $("#retry-ex").addEventListener("click", function () { mask.remove(); showAiExplain(wordId); });
  });
}

/* ================= 词库 ================= */
function renderLibrary() {
  var prog = loadProgress();
  var groups = [
    { name: "成语 · 上册（第 1–40 组）", secs: SECTIONS.filter(function (s) { return s.kind === "cy" && s.book === "上"; }) },
    { name: "成语 · 下册（第 41–66 组）", secs: SECTIONS.filter(function (s) { return s.kind === "cy" && s.book === "下"; }) },
    { name: "实词 · 下册（第 1–11 组）", secs: SECTIONS.filter(function (s) { return s.kind === "sc"; }) },
  ];
  var html = "<h1>词库</h1>";
  groups.forEach(function (g, gi) {
    var ids = [];
    g.secs.forEach(function (s) {
      WORDS.forEach(function (w) { if (w.section_id === s.id) ids.push(w.id); });
    });
    var learned = ids.filter(function (id) {
      return prog.words[id] && prog.words[id].status && prog.words[id].status !== "new";
    }).length;
    html += '<button class="collapse-head" data-g="' + gi + '"><span>' + g.name + '</span><span class="muted">' + learned + "/" + ids.length + "</span></button>";
    html += '<div id="group-' + gi + '">' + g.secs.map(function (s) {
      var wids = [];
      WORDS.forEach(function (w) { if (w.section_id === s.id) wids.push(w.id); });
      var ln = wids.filter(function (id) {
        return prog.words[id] && prog.words[id].status && prog.words[id].status !== "new";
      }).length;
      return '<button class="section-row" data-sid="' + s.id + '"><span>' +
        esc(s.title.replace(/^【第.+?组】/, "")) + '</span><span class="muted">' + ln + "/" + wids.length + "</span></button>";
    }).join("") + "</div>";
  });
  main.innerHTML = html;
  main.querySelectorAll(".collapse-head").forEach(function (h) {
    h.addEventListener("click", function () {
      var el = $("#group-" + h.dataset.g);
      el.style.display = el.style.display === "none" ? "" : "none";
    });
  });
  main.querySelectorAll(".section-row").forEach(function (r) {
    r.addEventListener("click", function () { renderSection(r.dataset.sid); });
  });
}

function renderSection(sid) {
  var prog = loadProgress();
  var sec = SECTIONS.filter(function (s) { return s.id === sid; })[0];
  var secWords = WORDS.filter(function (w) { return w.section_id === sid; });
  var qs = QUESTIONS.filter(function (q) { return q.section_id === sid; });
  var html = '<button class="back-btn" id="lib-back">← 返回词库</button><h1>' + esc(sec.title.replace(/^【第.+?组】/, "")) + "</h1>";
  var curSub = null;
  secWords.forEach(function (w) {
    if (w.subtheme && w.subtheme !== curSub) {
      curSub = w.subtheme;
      html += '<div class="muted" style="margin:14px 0 6px">' + esc(curSub) + "</div>";
    }
    var learned = prog.words[w.id] && prog.words[w.id].status && prog.words[w.id].status !== "new";
    html += '<button class="word-row" data-wid="' + w.id + '"><span>' + esc(w.name) + "</span>" +
      (learned ? '<span class="badge learned">已学</span>' : "") + "</button>";
  });
  html += '<div class="card" style="margin-top:16px"><div class="muted">本板块真题/练习题：' + qs.length + ' 道</div>' +
    '<button class="btn secondary" style="margin-top:10px" id="go-practice">去练习本板块</button></div>';
  main.innerHTML = html;
  $("#lib-back").addEventListener("click", renderLibrary);
  $("#go-practice").addEventListener("click", function () {
    practiceCfg = { mode: "section", section_id: sid, count: loadProgress().settings.practice_count || 10 };
    switchTab("practice");
    startPractice();
  });
  main.querySelectorAll(".word-row").forEach(function (r) {
    r.addEventListener("click", function () { renderWord(r.dataset.wid); });
  });
}

function renderWord(wid) {
  var w = WORD_INDEX[wid];
  var related = QUESTIONS.filter(function (q) { return (q.word_ids || []).indexOf(wid) >= 0; });
  var html = '<button class="back-btn" id="w-back">← 返回</button><h1>' + esc(w.name) + "</h1>" +
    '<div class="card"><div class="def">' + esc(w.definition) + "</div>" +
    (w.examples || []).map(function (e) { return '<div class="ex">' + esc(e) + "</div>"; }).join("") + "</div>" +
    '<button class="btn secondary" id="w-explain">AI 讲词</button>';
  if (related.length) {
    html += '<h2 style="margin-top:18px">相关真题（' + related.length + "）</h2>";
    related.forEach(function (q) {
      html += '<div class="card">' +
        '<div class="muted">' + (q.source === "real" ? "真题 · " + q.year + " " + q.exam : "练习题") + "</div>" +
        '<div class="q-stem" style="margin-top:8px">' + esc(q.stem) + "</div>" +
        q.options.map(function (o) { return '<div class="option dim" style="white-space:pre-line">' + o.letter + "．" + esc(o.text) + "</div>"; }).join("") +
        '<div class="explain-box"><b>答案 ' + esc(q.answer) + "</b>" + (q.explanation ? "<br>" + esc(q.explanation) : "（暂无解析）") + "</div></div>";
    });
  }
  main.innerHTML = html;
  $("#w-back").addEventListener("click", function () { renderSection(w.section_id); });
  $("#w-explain").addEventListener("click", function () { showAiExplain(w.id); });
}

/* ================= 练习 ================= */
function renderPracticeHome() {
  var prog = loadProgress();
  practiceCfg = practiceCfg || { mode: "mixed", count: prog.settings.practice_count || 10 };
  var wrongCount = 0;
  for (var k in prog.wrong_book) wrongCount++;
  main.innerHTML = '<h1>练习</h1>' +
    '<div class="card">' +
    '<div class="muted" style="margin-bottom:8px">模式</div>' +
    '<div class="seg">' +
    '<button data-m="mixed" class="' + (practiceCfg.mode === "mixed" ? "on" : "") + '">混合（题本+题库各半）</button>' +
    '<button data-m="section" class="' + (practiceCfg.mode === "section" ? "on" : "") + '">板块</button>' +
    '<button data-m="wrong" class="' + (practiceCfg.mode === "wrong" ? "on" : "") + '">错题（' + wrongCount + "）</button>" +
    "</div>" +
    '<div id="sec-pick" style="' + (practiceCfg.mode === "section" ? "" : "display:none") + '">' +
    '<div class="muted" style="margin-bottom:8px">选择板块</div>' +
    '<select id="sec-sel" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);font-size:16px">' +
    SECTIONS.map(function (s) {
      var n = QUESTIONS.filter(function (q) { return q.section_id === s.id; }).length;
      return '<option value="' + s.id + '"' + (s.id === practiceCfg.section_id ? " selected" : "") + ">" + esc(s.title) + "（" + n + " 题）</option>";
    }).join("") + "</select></div>" +
    '<div class="muted" style="margin:14px 0 8px">题数</div>' +
    '<div class="seg">' +
    [5, 10, 20, 50].map(function (n) {
      return '<button data-n="' + n + '" class="' + (practiceCfg.count === n ? "on" : "") + '">' + n + " 题</button>";
    }).join("") + "</div>" +
    '<div class="setting-row"><span class="muted">自定义题数（5~50）</span>' +
    '<input type="number" id="count-input" value="' + practiceCfg.count + '" min="5" max="50" style="width:80px;text-align:center"></div>' +
    '<button class="btn" style="margin-top:8px" id="start-practice">开始练习</button></div>';
  main.querySelectorAll(".seg [data-m]").forEach(function (b) {
    b.addEventListener("click", function () { practiceCfg.mode = b.dataset.m; renderPracticeHome(); });
  });
  main.querySelectorAll(".seg [data-n]").forEach(function (b) {
    b.addEventListener("click", function () { practiceCfg.count = parseInt(b.dataset.n, 10); renderPracticeHome(); });
  });
  $("#count-input").addEventListener("change", function () {
    practiceCfg.count = Math.min(50, Math.max(5, parseInt(this.value, 10) || 10));
    renderPracticeHome();
  });
  $("#start-practice").addEventListener("click", startPractice);
}

function startPractice() {
  if (practiceCfg.mode === "section") {
    practiceCfg.section_id = $("#sec-sel") ? $("#sec-sel").value : practiceCfg.section_id;
  }
  var count = practiceCfg.count || 10;
  var pool = [];
  if (practiceCfg.mode === "section") {
    pool = QUESTIONS.filter(function (q) { return q.section_id === practiceCfg.section_id; });
    practiceList = seededShuffle(pool, dateSeed(todayStr() + Math.random())).slice(0, count);
  } else if (practiceCfg.mode === "wrong") {
    var prog = loadProgress();
    pool = QUESTIONS.concat(SIHAI).filter(function (q) { return prog.wrong_book[q.id]; });
    practiceList = seededShuffle(pool, dateSeed(todayStr() + Math.random())).slice(0, count);
  } else {
    // 混合：四海题本与现有题库各半
    var halfSihai = Math.ceil(count / 2);
    var fromSihai = seededShuffle(SIHAI, dateSeed(todayStr() + Math.random())).slice(0, Math.min(halfSihai, SIHAI.length));
    var fromBank = seededShuffle(QUESTIONS, dateSeed(todayStr() + Math.random())).slice(0, count - fromSihai.length);
    practiceList = seededShuffle(fromSihai.concat(fromBank), dateSeed(Math.random()));
  }
  practiceIdx = 0; practiceScore = 0;
  if (!practiceList.length) {
    main.innerHTML = '<div class="card" style="text-align:center;padding:40px 20px">' +
      '<div style="font-size:40px">✅</div><h2>' + (practiceCfg.mode === "wrong" ? "错题本已清空" : "暂无题目") + "</h2>" +
      '<button class="btn" id="p-back">返回</button></div>';
    $("#p-back").addEventListener("click", renderPracticeHome);
    return;
  }
  renderQuestion();
}

function renderQuestion() {
  var q = practiceList[practiceIdx];
  var src = q.source === "real" ? "真题 · " + q.year + " " + q.exam
    : (q.source === "sihai" ? "四海题本 · " + q.section + " 第" + q.number + "题" : "练习题");
  main.innerHTML =
    '<div class="muted" style="margin-bottom:10px">' + (practiceIdx + 1) + " / " + practiceList.length + " · " + esc(src) + "</div>" +
    '<div class="card">' +
    '<div class="q-stem">' + esc(q.stem) + "</div>" +
    q.options.map(function (o, i) {
      return '<button class="option" data-i="' + i + '">' + String.fromCharCode(65 + i) + "．" + esc(o.text) + "</button>";
    }).join("") +
    '<div id="after" style="display:none">' +
    '<div class="explain-box"><b>答案 ' + esc(q.answer) + "</b>" + (q.explanation ? "<br>" + esc(q.explanation) : "") + "</div>" +
    '<div class="muted" id="word-links" style="margin-bottom:10px"></div>' +
    '<button class="btn" id="next-q">' + (practiceIdx + 1 < practiceList.length ? "下一题" : "查看结果") + "</button>" +
    "</div></div>";
  var opts = main.querySelectorAll(".option");
  var answered = false;
  opts.forEach(function (o) {
    o.addEventListener("click", function () {
      if (answered) return;
      answered = true;
      var chosen = String.fromCharCode(65 + parseInt(o.dataset.i, 10));
      var correct = chosen === q.answer;
      if (correct) practiceScore++;
      o.classList.add(correct ? "right" : "wrong");
      opts.forEach(function (x, i) {
        if (String.fromCharCode(65 + i) === q.answer) x.classList.add("right");
        else if (x !== o) x.classList.add("dim");
      });
      $("#after").style.display = "block";
      if (q.word_ids && q.word_ids.length) {
        $("#word-links").innerHTML = "考点词：" + q.word_ids.map(function (wid) {
          var w = WORD_INDEX[wid];
          return w ? '<a href="#" data-wid="' + wid + '" class="wlink">' + esc(w.name) + "</a>" : "";
        }).join("　");
        main.querySelectorAll(".wlink").forEach(function (a) {
          a.addEventListener("click", function (e) { e.preventDefault(); showWordModal(a.dataset.wid); });
        });
      }
      var prog = loadProgress(), t = todayStr();
      var log = prog.study_log[t] = prog.study_log[t] || { new: 0, reviewed: 0, wrong: 0 };
      if (correct) { delete prog.wrong_book[q.id]; log.reviewed++; }
      else {
        var wb = prog.wrong_book[q.id] = prog.wrong_book[q.id] || { count: 0, last: t };
        wb.count++; wb.last = t; log.wrong++;
      }
      saveProgress(prog);
      $("#next-q").addEventListener("click", function () {
        practiceIdx++;
        if (practiceIdx < practiceList.length) renderQuestion();
        else renderPracticeResult();
      });
    });
  });
}

function renderPracticeResult() {
  var wrong = practiceList.length - practiceScore;
  main.innerHTML =
    '<div class="card" style="text-align:center;padding:30px 20px">' +
    '<div class="result-num">' + practiceScore + " / " + practiceList.length + "</div>" +
    '<div class="muted">答错 ' + wrong + " 道" + (wrong ? "，已加入错题本" : "") + "</div>" +
    '<div style="display:flex;gap:10px;margin-top:18px">' +
    '<button class="btn secondary" id="r-again">再练一组</button>' +
    '<button class="btn" id="r-back">返回</button></div></div>';
  $("#r-again").addEventListener("click", startPractice);
  $("#r-back").addEventListener("click", renderPracticeHome);
}

function showWordModal(wid) {
  var w = WORD_INDEX[wid];
  if (!w) return;
  var mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = '<div class="modal"><h2>' + esc(w.name) + "</h2>" +
    '<div class="def">' + esc(w.definition) + "</div>" +
    (w.examples || []).map(function (e) { return '<div class="ex" style="margin-top:8px">' + esc(e) + "</div>"; }).join("") +
    '<button class="btn secondary" style="margin-top:14px" id="m-explain">AI 讲词</button></div>';
  main.appendChild(mask);
  mask.addEventListener("click", function (e) { if (e.target === mask) mask.remove(); });
  $("#m-explain").addEventListener("click", function (e) { e.stopPropagation(); mask.remove(); showAiExplain(w.id); });
}

/* ================= 易混 ================= */
function renderConfus() {
  var html = "<h1>易混词</h1>";
  CONFUSABLES.forEach(function (g) {
    html += "<h2>" + esc(g.category) + "</h2>";
    g.items.forEach(function (it) {
      if (it.words) {
        html += '<div class="pair-card">' +
          '<div class="pair-words">' + (it.star ? '<span class="star">★</span> ' : "") + esc(it.words) + "</div>" +
          '<div class="pair-note">' + esc(it.note || "") + "</div>" +
          (it.memory ? '<div class="pair-memory">记忆对子：' + esc(it.memory) + "</div>" : "") + "</div>";
      } else {
        html += '<div class="pair-card"><div class="pair-words">' + esc(it.name) + "</div>" +
          '<div class="pair-note">' + esc(it.content) + "</div></div>";
      }
    });
  });
  main.innerHTML = html;
}

/* ================= 设置 ================= */
function renderSettings() {
  var prog = loadProgress();
  var key = localStorage.getItem(LS_DS_KEY) || "";
  var st = calcStats(prog);
  main.innerHTML = '<h1>设置</h1>' +
    '<div class="card">' +
    '<div class="setting-row"><span>每日新词数</span>' +
    '<input type="number" id="set-daily" value="' + prog.settings.daily_new + '" min="1" max="100" style="width:80px;text-align:center"></div>' +
    '<div class="setting-row"><span>新词跨板块随机（混合模式）</span>' +
    '<label class="switch"><input type="checkbox" id="set-mixed"' + (prog.settings.mixed_new ? " checked" : "") + '><span class="slider"></span></label></div>' +
    '<div class="setting-row"><span>每次练习题数（混合/错题模式）</span>' +
    '<input type="number" id="set-count" value="' + (prog.settings.practice_count || 10) + '" min="5" max="50" style="width:80px;text-align:center"></div>' +
    '<button class="btn" id="save-settings">保存设置</button></div>' +
    '<div class="card"><h2>DeepSeek API</h2>' +
    '<div class="muted">' + (key ? "已配置（key 仅保存在本手机浏览器）" : "未配置——AI 讲词不可用") + "</div>" +
    '<input type="password" id="set-key" placeholder="sk-…（留空则不修改）" style="margin-top:10px">' +
    '<div style="display:flex;gap:10px;margin-top:10px">' +
    '<button class="btn secondary" id="save-key">保存 key</button>' +
    '<button class="btn secondary" id="test-key">测试</button></div>' +
    '<div class="muted" id="key-msg" style="margin-top:8px"></div></div>' +
    '<div class="card"><h2>数据备份</h2>' +
    '<div class="muted">学习进度、AI 缓存、key 都保存在<b>本手机浏览器</b>里。换手机或清浏览器数据前，请先导出备份。</div>' +
    '<div style="display:flex;gap:10px;margin-top:10px">' +
    '<button class="btn secondary" id="export-btn">导出备份</button>' +
    '<button class="btn secondary" id="import-btn">导入备份</button></div>' +
    '<input type="file" id="import-file" accept=".json" style="display:none"></div>' +
    '<div class="card"><h2>数据统计</h2><div class="muted">' +
    "总词数 " + st.total + " · 已学 " + st.learned + " · 到期待复习 " + st.due_today + " · 错题 " + st.wrong_total +
    "<br>状态分布：新 " + st.by_status.new + " / 学习中 " + st.by_status.learning + " / 复习 " + st.by_status.review + " / 熟记 " + st.by_status.mature +
    "<br>题库：书内真题+生成题 " + QUESTIONS.length + " 道 · 四海题本 " + SIHAI.length + " 道" +
    "<br><br>版本 v4" +
    "</div></div>";
  $("#save-settings").addEventListener("click", function () {
    prog.settings.daily_new = Math.min(100, Math.max(1, parseInt($("#set-daily").value, 10) || 20));
    prog.settings.mixed_new = $("#set-mixed").checked;
    prog.settings.practice_count = Math.min(50, Math.max(5, parseInt($("#set-count").value, 10) || 10));
    saveProgress(prog);
    alert("已保存");
  });
  $("#save-key").addEventListener("click", function () {
    var k = $("#set-key").value.trim();
    if (!k) return alert("请先粘贴 key");
    localStorage.setItem(LS_DS_KEY, k);
    alert("key 已保存（仅存本手机浏览器）");
    renderSettings();
  });
  $("#test-key").addEventListener("click", function () {
    $("#key-msg").textContent = "测试中…";
    callDeepseek([{ role: "user", content: "只回复两个字：正常" }], 0).then(function () {
      $("#key-msg").textContent = "key 可用 ✓";
    }).catch(function (e) {
      $("#key-msg").textContent = "失败：" + e.message;
    });
  });
  $("#export-btn").addEventListener("click", function () {
    var data = {
      app: "ciyu", version: 1, exported_at: new Date().toISOString(),
      progress: loadProgress(), ai_cache: loadAiCache(), ds_key: localStorage.getItem(LS_DS_KEY) || "",
    };
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ciyu-backup-" + todayStr() + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#import-btn").addEventListener("click", function () { $("#import-file").click(); });
  $("#import-file").addEventListener("change", function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (data.progress) {
          var base = defaultProgress();
          saveProgress({ words: data.progress.words || {}, settings: base.settings,
            wrong_book: data.progress.wrong_book || {}, study_log: data.progress.study_log || {} });
          var prog2 = loadProgress();
          if (data.progress.settings) {
            for (var k in prog2.settings) {
              if (data.progress.settings[k] != null) prog2.settings[k] = data.progress.settings[k];
            }
            saveProgress(prog2);
          }
        }
        if (data.ai_cache) saveAiCache(data.ai_cache);
        if (data.ds_key) localStorage.setItem(LS_DS_KEY, data.ds_key);
        alert("导入成功");
        renderSettings();
      } catch (err) { alert("导入失败：" + err.message); }
    };
    reader.readAsText(f);
  });
}

/* ---------- 启动 ---------- */
main.innerHTML = '<div class="loading">题库加载中…（首次约需几秒，请稍候）</div>';
loadData().then(function () {
  switchTab("study");
}).catch(function (e) {
  main.innerHTML = '<div class="card">数据加载失败：' + esc(e.message) +
    '<br><span class="muted">请检查网络后刷新页面</span>' +
    '<br><button class="btn" style="margin-top:12px" onclick="location.reload()">刷新重试</button></div>';
});

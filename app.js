const askBtn = document.getElementById("askBtn");
const voiceBtn = document.getElementById("voiceBtn");
const speakBtn = document.getElementById("speakBtn");
const resetBtn = document.getElementById("resetBtn");
const questionInput = document.getElementById("questionInput");
const photoInput = document.getElementById("photoInput");
const answerBox = document.getElementById("answerBox");
const resourceList = document.getElementById("resourceList");
const quizBox = document.getElementById("quizBox");
const scoreText = document.getElementById("scoreText");
const stageText = document.getElementById("stageText");
const rewardBox = document.getElementById("rewardBox");
const growthTrack = document.getElementById("growthTrack");
const growthBar = document.getElementById("growthBar");
const stageAvatar = document.getElementById("stageAvatar");
const voiceStatus = document.getElementById("voiceStatus");
const tags = document.querySelectorAll(".tag");
const answerCard = document.querySelector(".answer-card");
const API_BASE = (() => {
  const fromWindow = typeof window !== "undefined" ? window.__SILKWORM_API_BASE__ : "";
  if (fromWindow) return String(fromWindow).replace(/\/+$/, "");

  const meta = document.querySelector('meta[name="silkworm-api-base"]');
  const fromMeta = meta?.getAttribute("content") || "";
  if (fromMeta) return String(fromMeta).replace(/\/+$/, "");

  const h = window.location.hostname;
  if (h === "localhost" || h === "127.0.0.1") return "http://localhost:8787";
  return window.location.origin;
})();

const SCORE_KEY = "silkworm_score";
let score = Number(localStorage.getItem(SCORE_KEY) || 0);
let currentQuiz = null;
let answeredCurrentQuiz = false;

const STAGES = [
  "蚕卵",
  "一龄幼虫",
  "二龄幼虫",
  "三龄幼虫",
  "四龄幼虫",
  "五龄幼虫",
  "蛹",
  "蛾",
];
const LARVA_SCALES = [0, 0.84, 0.9, 0.97, 1.05, 1.12];

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;
let preferredVoice = null;

renderScore();
setupVoiceInput();

askBtn.addEventListener("click", () => askQuestion());
speakBtn.addEventListener("click", () => speakAnswer());

tags.forEach((tag) => {
  tag.addEventListener("click", () => {
    questionInput.value = tag.dataset.question || "";
    askBtn.click();
  });
});

resetBtn.addEventListener("click", () => {
  score = 0;
  localStorage.setItem(SCORE_KEY, String(score));
  renderScore();
});

async function askQuestion() {
  const question = questionInput.value.trim();
  const file = photoInput.files[0];

  if (!question && !file) {
    answerBox.textContent = "你可以先输入问题，或者上传一张蚕宝宝照片。";
    answerCard.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  setAskLoading(true);
  answerBox.textContent = "我在思考中，请稍等...";
  resourceList.innerHTML = '<div class="resource-empty">正在整理简单资料...</div>';
  quizBox.textContent = "正在出题...";

  try {
    const diagnosis = await askWithModel(question, file);
    answerBox.textContent = diagnosis.answer;
    renderResources(diagnosis.resources);
    currentQuiz = diagnosis.quiz;
    answeredCurrentQuiz = false;
    renderQuiz();
  } catch (err) {
    const msg = String(err?.message || err || "");
    answerBox.textContent = `模型服务暂时异常：${msg}`;
    resourceList.innerHTML =
      '<div class="resource-empty">可先用语音提问再试，或确认后端服务是否在运行。</div>';
    quizBox.textContent = "服务恢复后可继续答题。";
  } finally {
    setAskLoading(false);
  }

  setTimeout(() => {
    answerCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

function setAskLoading(loading) {
  askBtn.disabled = Boolean(loading);
  askBtn.classList.toggle("loading", Boolean(loading));
  askBtn.textContent = loading ? "思考中..." : "搜索答案";
}

async function askWithModel(question, file) {
  const resp = await fetch(`${API_BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      imageName: file ? file.name : "",
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data?.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }

  const r = data.result || {};
  return {
    answer: limitTo200(r.answer || ""),
    resources: Array.isArray(r.resources) ? r.resources : [],
    quiz: r.quiz || null,
  };
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setupVoiceInput() {
  if (!SpeechRecognition) {
    voiceBtn.disabled = true;
    voiceStatus.textContent = "当前浏览器暂不支持语音输入，建议使用新版 Chrome 或 Edge。";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = false;

  let pressMode = false;

  function startListening() {
    if (isListening) return;
    try {
      recognition.start();
    } catch {
      // 某些浏览器会在短时间重复 start 时抛异常，忽略即可
    }
  }

  function stopListening() {
    if (!isListening) return;
    try {
      recognition.stop();
    } catch {
      // 忽略停止阶段异常
    }
  }

  // 桌面/不支持按住时：点击切换
  voiceBtn.addEventListener("click", () => {
    if (pressMode) return;
    if (isListening) {
      stopListening();
      return;
    }
    startListening();
  });

  // 手机优先：按住说话，松手结束
  voiceBtn.addEventListener("pointerdown", (e) => {
    pressMode = true;
    e.preventDefault();
    startListening();
  });
  voiceBtn.addEventListener("pointerup", () => {
    stopListening();
    setTimeout(() => {
      pressMode = false;
    }, 120);
  });
  voiceBtn.addEventListener("pointercancel", () => {
    stopListening();
    setTimeout(() => {
      pressMode = false;
    }, 120);
  });
  voiceBtn.addEventListener("pointerleave", () => {
    if (pressMode) stopListening();
  });

  recognition.onstart = () => {
    isListening = true;
    voiceBtn.classList.add("listening");
    voiceBtn.textContent = "正在听...";
    voiceStatus.textContent = "请直接说出你的问题，比如：蚕宝宝不吃桑叶怎么办？";
  };

  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join("");
    questionInput.value = transcript.trim();
    voiceStatus.textContent = `我听到的是：${questionInput.value || "请再说一次"}`;
  };

  recognition.onerror = (event) => {
    isListening = false;
    voiceBtn.classList.remove("listening");
    voiceBtn.textContent = "按住小话筒";
    const err = String(event?.error || "");
    if (err === "not-allowed") {
      voiceStatus.textContent = "请允许麦克风权限后再试一次。";
      return;
    }
    voiceStatus.textContent = "没有听清楚，可以再点一次小话筒重新说。";
  };

  recognition.onend = () => {
    isListening = false;
    voiceBtn.classList.remove("listening");
    voiceBtn.textContent = "按住小话筒";
    if (questionInput.value.trim()) {
      voiceStatus.textContent = `识别完成：${questionInput.value}`;
    }
  };
}

function renderResources(resources) {
  resourceList.innerHTML = "";
  if (!Array.isArray(resources) || resources.length === 0) {
    resourceList.innerHTML =
      '<div class="resource-empty">暂时没有找到可直接打开的资料链接。你可以换个问法，或更具体一点（比如“一龄蚕温度湿度”）。</div>';
    return;
  }

  resources.forEach((item) => {
    const card = document.createElement("article");
    card.className = `resource-card ${item.type}`;

    const link = isReliableLink(item.link) ? item.link : "";
    const verifyHint = item.needsVerify ? '<span class="verify-hint">可能需微信内打开/可能触发验证</span>' : "";
    if (item.type === "video") {
      card.innerHTML = `
        <div class="resource-head">
          <strong>${item.title}</strong>
          <span class="resource-type">站内视频资料</span>
        </div>
        <div class="resource-script">${(item.summary || "").slice(0, 80)}\n\n${(item.script || "").slice(0, 120)}</div>
        ${
          link
            ? `<div class="resource-link"><a href="${link}" target="_blank" rel="noreferrer">点击查看视频资料</a></div>`
            : '<div class="resource-link">暂无可靠视频链接</div>'
        }
        ${verifyHint ? `<div class="resource-note">${verifyHint}</div>` : ""}
      `;
    } else {
      card.innerHTML = `
        <div class="resource-head">
          <strong>${item.title}</strong>
          <span class="resource-type">站内文字资料</span>
        </div>
        <div class="resource-content">${(item.content || "").slice(0, 100)}</div>
        ${
          link
            ? `<div class="resource-link"><a href="${link}" target="_blank" rel="noreferrer">点击查看文字资料</a></div>`
            : '<div class="resource-link">暂无可靠文字链接</div>'
        }
        ${verifyHint ? `<div class="resource-note">${verifyHint}</div>` : ""}
      `;
    }

    resourceList.appendChild(card);
  });
}

function renderQuiz() {
  if (!currentQuiz) {
    quizBox.textContent = "暂无测验。";
    return;
  }

  quizBox.innerHTML = "";

  const q = document.createElement("div");
  q.className = "quiz-question";
  q.textContent = currentQuiz.question;
  quizBox.appendChild(q);

  const optionsWrap = document.createElement("div");
  optionsWrap.className = "quiz-options";

  currentQuiz.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.textContent = `选项 ${idx + 1}：${opt}`;
    btn.addEventListener("click", () => checkAnswer(idx));
    optionsWrap.appendChild(btn);
  });

  quizBox.appendChild(optionsWrap);
}

function checkAnswer(selectedIndex) {
  if (!currentQuiz || answeredCurrentQuiz) return;

  const feedback = document.createElement("div");
  feedback.className = "quiz-feedback";

  if (selectedIndex === currentQuiz.correctIndex) {
    score += 1;
    localStorage.setItem(SCORE_KEY, String(score));
    feedback.classList.add("ok");
    feedback.textContent = `回答正确！+1 积分。${currentQuiz.explain}`;
    answeredCurrentQuiz = true;
  } else {
    feedback.classList.add("bad");
    feedback.textContent = `这次不对，再想想：${currentQuiz.explain}`;
  }

  const old = quizBox.querySelector(".quiz-feedback");
  if (old) old.remove();
  quizBox.appendChild(feedback);
  renderScore();
}

function renderScore() {
  scoreText.textContent = String(score);
  const stageIndex = Math.min(score, STAGES.length - 1);
  stageText.textContent = STAGES[stageIndex];
  stageAvatar.innerHTML = getStageAvatarSvg(stageIndex);
  const percent = (stageIndex / (STAGES.length - 1)) * 100;
  growthBar.style.width = `${percent}%`;

  const stages = growthTrack.querySelectorAll(".stage");
  stages.forEach((stage, index) => {
    stage.classList.toggle("active", index <= stageIndex);
  });

  const finalScore = STAGES.length - 1;
  if (score >= finalScore) {
    rewardBox.classList.remove("locked");
    rewardBox.classList.add("unlocked");
    rewardBox.textContent = "太棒了！你已经把蚕宝宝养到最终阶段啦。";
  } else {
    rewardBox.classList.remove("unlocked");
    rewardBox.classList.add("locked");
    rewardBox.textContent = `再答对 ${finalScore - score} 题，蚕宝宝会继续升级。`;
  }
}

function getStageAvatarSvg(stageIndex) {
  if (stageIndex === 0) {
    return `
      <svg viewBox="0 0 120 120" class="stage-svg" aria-hidden="true">
        <ellipse cx="60" cy="102" rx="28" ry="8" fill="#dbe7d9" />
        <ellipse cx="60" cy="58" rx="24" ry="31" fill="#f9f7ef" stroke="#d9d4c8" stroke-width="3" />
        <ellipse cx="53" cy="50" rx="6" ry="8" fill="#fffdf8" />
      </svg>
    `;
  }

  if (stageIndex >= 1 && stageIndex <= 5) {
    const scale = LARVA_SCALES[stageIndex] || 1;
    return `
      <svg viewBox="0 0 120 120" class="stage-svg" aria-hidden="true">
        <ellipse cx="60" cy="100" rx="38" ry="8" fill="#dbe7d9" />
        <g transform="translate(60 62) scale(${scale}) translate(-60 -62)">
          <ellipse cx="44" cy="64" rx="16" ry="14" fill="#fbfaf5" stroke="#dbd6ca" stroke-width="2.4" />
          <ellipse cx="58" cy="63" rx="17" ry="15" fill="#fbfaf5" stroke="#dbd6ca" stroke-width="2.4" />
          <ellipse cx="74" cy="62" rx="18" ry="16" fill="#fbfaf5" stroke="#dbd6ca" stroke-width="2.4" />
          <ellipse cx="90" cy="61" rx="16" ry="14" fill="#fbfaf5" stroke="#dbd6ca" stroke-width="2.4" />
          <circle cx="95" cy="57" r="2.3" fill="#2f4f65" />
          <path d="M86 68 C90 71, 94 71, 97 68" fill="none" stroke="#ff9a9a" stroke-width="2.4" stroke-linecap="round" />
        </g>
      </svg>
    `;
  }

  if (stageIndex === 6) {
    return `
      <svg viewBox="0 0 120 120" class="stage-svg" aria-hidden="true">
        <ellipse cx="60" cy="100" rx="34" ry="8" fill="#dbe7d9" />
        <path d="M60 28 C79 36, 89 57, 82 77 C75 93, 59 97, 47 90 C33 82, 29 63, 37 48 C42 38, 50 31, 60 28Z"
          fill="#efe6cb" stroke="#d4c9ab" stroke-width="3"/>
        <path d="M51 43 C65 47, 72 58, 68 76" fill="none" stroke="#d4c9ab" stroke-width="2.2" stroke-linecap="round" />
      </svg>
    `;
  }

  return `
    <svg viewBox="0 0 120 120" class="stage-svg" aria-hidden="true">
      <ellipse cx="60" cy="98" rx="34" ry="8" fill="#dbe7d9" />
      <ellipse cx="60" cy="62" rx="16" ry="18" fill="#f0ece4" stroke="#c9c1b5" stroke-width="2.4" />
      <path d="M58 43 C46 35, 32 36, 23 48 C32 56, 46 56, 58 52Z" fill="#efe8da" stroke="#c9c1b5" stroke-width="2.2" />
      <path d="M62 43 C74 35, 88 36, 97 48 C88 56, 74 56, 62 52Z" fill="#efe8da" stroke="#c9c1b5" stroke-width="2.2" />
      <circle cx="56" cy="60" r="2.2" fill="#2f4f65" />
      <circle cx="64" cy="60" r="2.2" fill="#2f4f65" />
      <path d="M56 68 C58 70, 62 70, 64 68" fill="none" stroke="#ff9a9a" stroke-width="2.2" stroke-linecap="round" />
      <path d="M54 45 C50 38, 46 34, 42 31" fill="none" stroke="#7a6f64" stroke-width="2" stroke-linecap="round" />
      <path d="M66 45 C70 38, 74 34, 78 31" fill="none" stroke="#7a6f64" stroke-width="2" stroke-linecap="round" />
    </svg>
  `;
}

function isReliableLink(link) {
  const s = String(link || "").trim();
  if (!s) return false;
  if (!/^https?:\/\//i.test(s)) return false;
  const lower = s.toLowerCase();
  return !(
    lower.includes("example.com") ||
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("your_link")
  );
}

function limitTo200(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (t.length <= 200) return t;
  return `${t.slice(0, 200)}...`;
}

function speakAnswer() {
  const text = answerBox.textContent.trim();
  if (!text) return;
  window.speechSynthesis.cancel();
  ensurePreferredVoice();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "zh-CN";
  utter.rate = 0.95;
  utter.pitch = 1.02;
  if (preferredVoice) utter.voice = preferredVoice;
  window.speechSynthesis.speak(utter);
}

function ensurePreferredVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices || !voices.length) return;
  const candidates = voices.filter((v) => (v.lang || "").toLowerCase().includes("zh"));
  preferredVoice =
    candidates.find((v) => /xiaoxiao|yunxi|xiaoyi|xiaohan|natural|neural/i.test(v.name)) ||
    candidates[0] ||
    voices[0] ||
    null;
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = ensurePreferredVoice;
  ensurePreferredVoice();
}

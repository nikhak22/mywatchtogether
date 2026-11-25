// 1. Визначаємо або генеруємо ID кімнати в URL
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get("room");
if (!roomId) {
  roomId = Math.random().toString(36).slice(2, 8);
  const nextUrl = `${window.location.pathname}?room=${roomId}`;
  window.history.replaceState({}, "", nextUrl);
}

const storedNick = localStorage.getItem("wt_nick") || `User_${Math.floor(100 + Math.random() * 900)}`;
const nickInput = document.getElementById("nickInput");
nickInput.value = storedNick;

nickInput.addEventListener("change", () => {
  const val = nickInput.value.trim() || "Гість";
  localStorage.setItem("wt_nick", val);
  window.location.reload();
});

const socket = io({
  query: {
    room: roomId,
    nick: storedNick
  }
});

// DOM-елементи
const emptyState = document.getElementById("emptyState");
const htmlVideo = document.getElementById("htmlVideo");
const ytPlayerContainer = document.getElementById("ytPlayerContainer");
const urlInput = document.getElementById("urlInput");
const loadUrlBtn = document.getElementById("loadUrlBtn");
const localFileInput = document.getElementById("localFileInput");
const copyLinkBtn = document.getElementById("copyLinkBtn");
const syncPlayBtn = document.getElementById("syncPlayBtn");
const syncPauseBtn = document.getElementById("syncPauseBtn");
const forceSyncBtn = document.getElementById("forceSyncBtn");
const syncStatus = document.getElementById("syncStatus");
const reactionsLayer = document.getElementById("reactionsLayer");
const chatMessages = document.getElementById("chatMessages");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");

let currentSource = { type: "none", value: "", meta: "" };
let isRemoteAction = false; // Захист від петель подій при програмному керуванні плеєром
let ytPlayer = null;
let ytReady = false;
let pendingYtSource = null;
let hlsInstance = null;
let localObjectUrl = null;

// --- Допоміжні функції для джерел відео ---
function extractYouTubeId(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "").split("/")[0] || null;
    }
    if (u.hostname.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const parts = u.pathname.split("/").filter(Boolean);
      const embedIdx = parts.findIndex((p) => p === "embed" || p === "shorts" || p === "live");
      if (embedIdx !== -1 && parts[embedIdx + 1]) return parts[embedIdx + 1];
    }
  } catch (_) {
    return null;
  }
  return null;
}

function detectSourceFromUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const ytId = extractYouTubeId(trimmed);
  if (ytId) {
    return { type: "youtube", value: ytId, meta: trimmed };
  }

  return { type: "direct", value: trimmed, meta: trimmed };
}

// --- Підключення YouTube IFrame API ---
const ytScript = document.createElement("script");
ytScript.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(ytScript);

window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  if (pendingYtSource) {
    createOrLoadYouTube(pendingYtSource.value, 0, false);
    pendingYtSource = null;
  }
};

function createOrLoadYouTube(videoId, startSec = 0, autoPlay = false) {
  if (!ytReady) {
    pendingYtSource = { value: videoId };
    return;
  }

  if (!ytPlayer) {
    ytPlayer = new YT.Player("ytPlayerContainer", {
      height: "100%",
      width: "100%",
      videoId,
      playerVars: {
        playsinline: 1,
        rel: 0,
        start: Math.floor(startSec)
      },
      events: {
        onReady: (event) => {
          if (startSec > 0) event.target.seekTo(startSec, true);
          if (autoPlay) event.target.playVideo();
        },
        onStateChange: (event) => {
          if (isRemoteAction) return;
          const t = event.target.getCurrentTime ? event.target.getCurrentTime() : 0;
          if (event.data === YT.PlayerState.PLAYING) {
            socket.emit("player:play", { currentTime: t });
          } else if (event.data === YT.PlayerState.PAUSED) {
            socket.emit("player:pause", { currentTime: t });
          }
        }
      }
    });
  } else {
    isRemoteAction = true;
    if (autoPlay) {
      ytPlayer.loadVideoById({ videoId, startSeconds: startSec });
    } else {
      ytPlayer.cueVideoById({ videoId, startSeconds: startSec });
    }
    setTimeout(() => {
      isRemoteAction = false;
    }, 300);
  }
}

// --- Уніфікований інтерфейс керування активним плеєром ---
function applySource(source, startTime = 0, shouldPlay = false) {
  currentSource = source;
  emptyState.style.display = "none";

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (source.type === "youtube") {
    htmlVideo.style.display = "none";
    htmlVideo.pause();
    ytPlayerContainer.style.display = "block";
    createOrLoadYouTube(source.value, startTime, shouldPlay);
    return;
  }

  if (source.type === "direct" || source.type === "local") {
    ytPlayerContainer.style.display = "none";
    if (ytPlayer && ytPlayer.pauseVideo) {
      isRemoteAction = true;
      ytPlayer.pauseVideo();
      setTimeout(() => (isRemoteAction = false), 200);
    }
    htmlVideo.style.display = "block";

    const srcUrl = source.type === "local" ? localObjectUrl : source.value;
    if (!srcUrl) {
      syncStatus.textContent = `Оберіть локальний файл: ${source.meta || "відео"}`;
      return;
    }

    const isHls = source.type === "direct" && /\.m3u8(\?|$)/i.test(srcUrl);
    if (isHls && window.Hls && window.Hls.isSupported()) {
      hlsInstance = new window.Hls();
      hlsInstance.loadSource(srcUrl);
      hlsInstance.attachMedia(htmlVideo);
    } else {
      htmlVideo.src = srcUrl;
    }

    htmlVideo.currentTime = startTime;
    if (shouldPlay) {
      htmlVideo.play().catch(() => {});
    }
  }
}

function getPlayerTime() {
  if (currentSource.type === "youtube" && ytPlayer && ytPlayer.getCurrentTime) {
    return ytPlayer.getCurrentTime() || 0;
  }
  if (currentSource.type === "direct" || currentSource.type === "local") {
    return htmlVideo.currentTime || 0;
  }
  return 0;
}

function setPlayerTime(sec) {
  isRemoteAction = true;
  if (currentSource.type === "youtube" && ytPlayer && ytPlayer.seekTo) {
    ytPlayer.seekTo(sec, true);
  } else if (currentSource.type === "direct" || currentSource.type === "local") {
    htmlVideo.currentTime = sec;
  }
  setTimeout(() => {
    isRemoteAction = false;
  }, 250);
}

function playPlayer() {
  isRemoteAction = true;
  if (currentSource.type === "youtube" && ytPlayer && ytPlayer.playVideo) {
    ytPlayer.playVideo();
  } else if (currentSource.type === "direct" || currentSource.type === "local") {
    htmlVideo.play().catch(() => {});
  }
  setTimeout(() => {
    isRemoteAction = false;
  }, 250);
}

function pausePlayer() {
  isRemoteAction = true;
  if (currentSource.type === "youtube" && ytPlayer && ytPlayer.pauseVideo) {
    ytPlayer.pauseVideo();
  } else if (currentSource.type === "direct" || currentSource.type === "local") {
    htmlVideo.pause();
  }
  setTimeout(() => {
    isRemoteAction = false;
  }, 250);
}

function setPlayerPlaybackRate(rate) {
  if (currentSource.type === "youtube" && ytPlayer && ytPlayer.setPlaybackRate) {
    ytPlayer.setPlaybackRate(rate);
  } else if (currentSource.type === "direct" || currentSource.type === "local") {
    htmlVideo.playbackRate = rate;
  }
}

// --- Локальні події HTML5 <video> ---
htmlVideo.addEventListener("play", () => {
  if (isRemoteAction) return;
  socket.emit("player:play", { currentTime: htmlVideo.currentTime });
});

htmlVideo.addEventListener("pause", () => {
  if (isRemoteAction) return;
  socket.emit("player:pause", { currentTime: htmlVideo.currentTime });
});

htmlVideo.addEventListener("seeked", () => {
  if (isRemoteAction) return;
  socket.emit("player:seek", {
    currentTime: htmlVideo.currentTime,
    isPlaying: !htmlVideo.paused
  });
});

// --- Кнопки керування та завантаження ---
loadUrlBtn.addEventListener("click", () => {
  const parsed = detectSourceFromUrl(urlInput.value);
  if (!parsed) return;
  socket.emit("media:change", { source: parsed });
});

localFileInput.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;

  if (localObjectUrl) {
    URL.revokeObjectURL(localObjectUrl);
  }
  localObjectUrl = URL.createObjectURL(file);

  const source = {
    type: "local",
    value: "", // локальний шлях/blob не передаємо на сервер; кожен обирає свій файл
    meta: file.name
  };

  // Застосовуємо локально одразу та сповіщаємо кімнату про обраний файл
  applySource(source, 0, false);
  socket.emit("media:change", { source });
});

syncPlayBtn.addEventListener("click", () => {
  const t = getPlayerTime();
  playPlayer();
  socket.emit("player:play", { currentTime: t });
});

syncPauseBtn.addEventListener("click", () => {
  const t = getPlayerTime();
  pausePlayer();
  socket.emit("player:pause", { currentTime: t });
});

// --- Плавна корекція розсинхрону через playbackRate ---
function reconcileWithTarget(targetTime, isPlaying) {
  if (currentSource.type === "none") return;

  const localTime = getPlayerTime();
  const diff = targetTime - localTime; // > 0: відстаємо; < 0: випереджаємо
  const absDiff = Math.abs(diff);

  if (isPlaying) {
    playPlayer();
  } else {
    pausePlayer();
    setPlayerPlaybackRate(1.0);
  }

  // Якщо розсинхрон більше 1.8 сек — робимо жорсткий seek
  if (absDiff > 1.8) {
    setPlayerPlaybackRate(1.0);
    setPlayerTime(targetTime);
    syncStatus.textContent = `Корекція: стрибок (${diff > 0 ? "+" : ""}${diff.toFixed(2)}с)`;
    return;
  }

  // Плавна корекція швидкістю при розсинхроні від 0.15с до 1.8с
  if (isPlaying && absDiff > 0.15) {
    const rate = diff > 0 ? 1.06 : 0.94;
    setPlayerPlaybackRate(rate);
    syncStatus.textContent = `Підтягування швидкості ${rate}x (Δ ${diff.toFixed(2)}с)`;
  } else {
    setPlayerPlaybackRate(1.0);
    syncStatus.textContent = `Синхронізовано (Δ ${diff.toFixed(2)}с)`;
  }
}

forceSyncBtn.addEventListener("click", () => {
  socket.emit("player:heartbeat", {
    currentTime: getPlayerTime(),
    isPlaying: currentSource.type === "youtube" && ytPlayer && ytPlayer.getPlayerState
      ? ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
      : !htmlVideo.paused
  });
  syncStatus.textContent = "Запит синхронізації надіслано";
});

// Періодично відправляємо стан, щоб учасники з невеликим дрейфом плавно вирівнювались
setInterval(() => {
  if (currentSource.type === "none") return;
  const playing =
    currentSource.type === "youtube" && ytPlayer && ytPlayer.getPlayerState
      ? ytPlayer.getPlayerState() === YT.PlayerState.PLAYING
      : !htmlVideo.paused;

  if (playing) {
    socket.emit("player:heartbeat", {
      currentTime: getPlayerTime(),
      isPlaying: true
    });
  }
}, 2500);

// --- Socket.IO події ---
socket.on("room:state", (state) => {
  syncStatus.textContent = `Кімната: ${state.roomId}`;
  if (state.source && state.source.type !== "none") {
    applySource(state.source, state.currentTime, state.isPlaying);
  }
});

socket.on("media:change", ({ source, isPlaying, currentTime, by }) => {
  appendSystemMessage(`${by} змінив відео: ${source.meta || source.value}`);
  applySource(source, currentTime, isPlaying);
});

socket.on("player:play", ({ currentTime, updatedAt, by }) => {
  const expectedNow = currentTime + Math.max(0, (Date.now() - updatedAt) / 1000);
  syncStatus.textContent = `Play від ${by}`;
  reconcileWithTarget(expectedNow, true);
});

socket.on("player:pause", ({ currentTime, by }) => {
  syncStatus.textContent = `Pause від ${by}`;
  setPlayerTime(currentTime);
  pausePlayer();
  setPlayerPlaybackRate(1.0);
});

socket.on("player:seek", ({ currentTime, isPlaying, updatedAt, by }) => {
  const expectedNow = isPlaying
    ? currentTime + Math.max(0, (Date.now() - updatedAt) / 1000)
    : currentTime;
  syncStatus.textContent = `Перемотування від ${by}`;
  setPlayerTime(expectedNow);
  if (isPlaying) playPlayer();
  else pausePlayer();
});

socket.on("player:sync_tick", ({ currentTime, isPlaying, updatedAt }) => {
  const expectedNow = isPlaying
    ? currentTime + Math.max(0, (Date.now() - updatedAt) / 1000)
    : currentTime;
  reconcileWithTarget(expectedNow, isPlaying);
});

// --- Чат ---
function appendChatMessage(author, text) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  const authorSpan = document.createElement("span");
  authorSpan.className = "author";
  authorSpan.textContent = `${author}:`;
  const textSpan = document.createElement("span");
  textSpan.textContent = text;
  div.append(authorSpan, textSpan);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "chat-system";
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat:message", { text });
  chatInput.value = "";
});

socket.on("chat:message", ({ author, text }) => {
  appendChatMessage(author, text);
});

socket.on("chat:system", ({ text }) => {
  appendSystemMessage(text);
});

// --- Літаючі реакції ---
document.querySelectorAll(".reaction-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    socket.emit("reaction:send", { emoji: btn.dataset.emoji });
  });
});

socket.on("reaction:show", ({ emoji }) => {
  const el = document.createElement("div");
  el.className = "floating-reaction";
  el.textContent = emoji;
  el.style.left = `${8 + Math.random() * 84}%`;
  reactionsLayer.appendChild(el);
  setTimeout(() => el.remove(), 2500);
});

// --- Копіювання лінку кімнати ---
copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyLinkBtn.textContent = "Скопійовано!";
    setTimeout(() => {
      copyLinkBtn.textContent = "Скопіювати лінк кімнати";
    }, 1500);
  } catch (_) {
    prompt("Скопіюй посилання:", window.location.href);
  }
});
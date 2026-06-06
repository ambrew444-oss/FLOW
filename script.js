const field = document.querySelector("#cloudField");
const form = document.querySelector("#messageForm");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector(".send-button");
const limitStatus = document.querySelector("#limitStatus");
const charCounter = document.querySelector("#charCounter");

const CLIENT_ID_STORAGE_KEY = "vibe-sky-client-id";
const API_BASE_URL = (window.VIBE_API_URL || "").replace(/\/$/, "");
const MESSAGE_MAX_LENGTH = 96;
const CLOUD_CAPACITY = 18;
const CLOUD_SPEED = 46;
const POLL_INTERVAL_MS = 1200;
const LOCAL_PROMOTE_DELAY_MS = 180;

const seedMessages = [
  createSeedMessage("Пусть мысль станет облаком", -900000),
  createSeedMessage("Сегодня легко дышится", -640000),
  createSeedMessage("Мягкий привет", -420000),
  createSeedMessage("Небо внутри экрана", -170000),
];

const cloudElements = new Map();
const cloudReleaseTimers = new Map();
const visuallyExpiredMessageIds = new Set();
const localState = {
  active: API_BASE_URL ? [] : seedMessages,
  queue: [],
};

let clientId = getClientId();
let queuedByMeId = null;
let isSubmitting = false;
let pollTimer;
let lastActiveMessages = [];
let lastComposerState = {};
let stickyFocusTimer;

function createSeedMessage(text, offsetMs) {
  return {
    id: `seed-${Math.abs(offsetMs)}`,
    text,
    createdAt: Date.now() + offsetMs,
    seed: true,
  };
}

function getClientId() {
  try {
    const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);

    if (existing) {
      return existing;
    }

    const generated =
      globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;

    localStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return `${Date.now()}-${Math.random()}`;
  }
}

function createMessage(text) {
  const id =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  return {
    id,
    text: limitTextLength(text),
    clientId,
    createdAt: Date.now(),
  };
}

function normalizeMessage(message) {
  return {
    id: String(message.id),
    text: limitTextLength(message.text || ""),
    clientId: message.clientId ? String(message.clientId) : "",
    createdAt: Number(message.createdAt || message.startedAt || Date.now()),
    startedAt: Number(message.startedAt || message.createdAt || Date.now()),
    seed: Boolean(message.seed),
  };
}

function limitTextLength(value) {
  return [...String(value || "")].slice(0, MESSAGE_MAX_LENGTH).join("");
}

function sanitizeMessageText(value) {
  return limitTextLength(String(value || "").trim().replace(/\s+/g, " "));
}

function updateCharCounter() {
  const length = [...input.value].length;
  const displayLength = Math.min(length, MESSAGE_MAX_LENGTH);

  charCounter.textContent = `${displayLength}/${MESSAGE_MAX_LENGTH}`;
  charCounter.classList.toggle("is-near-limit", displayLength >= MESSAGE_MAX_LENGTH * 0.8);
  charCounter.classList.toggle("is-at-limit", displayLength >= MESSAGE_MAX_LENGTH);
}

function enforceMessageLimit() {
  const limited = limitTextLength(input.value);

  if (limited !== input.value) {
    input.value = limited;
  }

  updateCharCounter();
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function hashText(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed || 1;

  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function estimateCloudSize(message) {
  const width = Math.max(field.clientWidth, 320);
  const textLength = [...message.text].length;
  const maxWidth = Math.min(width < 580 ? 260 : 330, width * 0.72);
  const estimatedWidth = clamp(124 + textLength * 5.3, 132, maxWidth);
  const lineCount = Math.ceil(estimatedWidth > 0 ? (textLength * 8.5) / estimatedWidth : 1);
  const estimatedHeight = clamp((width < 580 ? 64 : 78) + lineCount * 17, width < 580 ? 78 : 92, 136);

  return {
    width: estimatedWidth,
    height: estimatedHeight,
  };
}

function getVisibleCapacity() {
  const width = Math.max(field.clientWidth, 320);
  const height = Math.max(field.clientHeight, 360);
  const usableArea = width * Math.max(height - 80, 260);
  const mobileCapacity = Math.max(5, Math.floor((height - 30) / 92));
  const desktopCapacity = Math.max(16, Math.floor(usableArea / 36000));

  return Math.min(CLOUD_CAPACITY, width < 580 ? mobileCapacity : desktopCapacity);
}

function getOccupiedRects() {
  return Array.from(cloudElements.values()).map((cloud) => {
    const rect = cloud.getBoundingClientRect();
    const targetRect = getCloudTargetRect(cloud);
    const placedAt = Number(cloud.dataset.placedAt || 0);
    const isArriving = placedAt > 0 && Date.now() - placedAt < 1900;

    if (isArriving && Number.isFinite(targetRect.left)) {
      return targetRect;
    }

    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

function rectsOverlap(a, b, margin = field.clientWidth < 580 ? 6 : 8) {
  return (
    a.left - margin < b.right &&
    a.right + margin > b.left &&
    a.top - margin < b.bottom &&
    a.bottom + margin > b.top
  );
}

function chooseCloudPosition(message, occupiedRects) {
  const width = Math.max(field.clientWidth, 320);
  const height = Math.max(field.clientHeight, 360);
  const size = estimateCloudSize(message);
  const random = seededRandom(hashText(`${message.id}-${message.text}`));
  const safeX = size.width / 2 + 22;
  const safeTop = size.height / 2 + 20;
  const safeBottom = height - size.height / 2 - 22;
  const columns = Math.max(1, Math.floor((width - safeX * 2) / Math.max(160, size.width * 0.72)));
  const rows = Math.max(1, Math.floor((safeBottom - safeTop) / Math.max(76, size.height * 0.74)));

  let bestCandidate = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const xRatio = columns === 1 ? 0.5 : column / (columns - 1);
      const yRatio = rows === 1 ? 0.5 : row / (rows - 1);

      candidates.push({
        x: clamp(safeX + xRatio * (width - safeX * 2) + (random() - 0.5) * 54, safeX, width - safeX),
        y: clamp(safeTop + yRatio * (safeBottom - safeTop) + (random() - 0.5) * 38, safeTop, safeBottom),
      });
    }
  }

  for (let attempt = 0; attempt < 260; attempt += 1) {
    candidates.push({
      x: clamp(safeX + random() * (width - safeX * 2), safeX, width - safeX),
      y: clamp(safeTop + random() * (safeBottom - safeTop), safeTop, safeBottom),
    });
  }

  candidates.sort(() => random() - 0.5);

  for (const point of candidates) {
    const candidate = {
      x: point.x,
      y: point.y,
      left: point.x - size.width / 2,
      right: point.x + size.width / 2,
      top: point.y - size.height / 2,
      bottom: point.y + size.height / 2,
    };
    const collisions = occupiedRects.filter((rect) => rectsOverlap(candidate, rect));

    if (collisions.length === 0) {
      return { x: point.x, y: point.y, width: size.width, height: size.height };
    }

    const penalty = collisions.reduce((sum, rect) => {
      const dx = Math.max(0, Math.min(candidate.right, rect.right) - Math.max(candidate.left, rect.left));
      const dy = Math.max(0, Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top));
      return sum + dx * dy;
    }, 0);

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestCandidate = candidate;
    }
  }

  return {
    x: bestCandidate?.x || width / 2,
    y: bestCandidate?.y || height * 0.72,
    width: size.width,
    height: size.height,
    collided: true,
  };
}

function createCloud(message, occupiedRects) {
  const position = chooseCloudPosition(message, occupiedRects);
  const originX = field.clientWidth / 2;
  const originY = field.clientHeight + 74;
  const random = seededRandom(hashText(`motion-${message.id}`));
  const driftDistance = -(position.y + position.height + 68);
  const driftDuration = Math.max(4.5, Math.abs(driftDistance) / CLOUD_SPEED);
  const sway = 0;
  const scale = field.clientWidth < 580 ? 0.88 + random() * 0.08 : 0.9 + random() * 0.13;
  const cloud = document.createElement("article");
  const motion = document.createElement("div");
  const body = document.createElement("div");
  const text = document.createElement("span");
  const time = document.createElement("time");

  cloud.className = message.seed ? "cloud is-seed" : "cloud";
  cloud.dataset.messageId = message.id;
  cloud.dataset.collided = position.collided ? "true" : "false";
  cloud.dataset.targetLeft = (position.x - position.width / 2).toFixed(1);
  cloud.dataset.targetRight = (position.x + position.width / 2).toFixed(1);
  cloud.dataset.targetTop = (position.y - position.height / 2).toFixed(1);
  cloud.dataset.targetBottom = (position.y + position.height / 2).toFixed(1);
  cloud.dataset.placedAt = String(Date.now());
  cloud.style.setProperty("--x", `${position.x.toFixed(1)}px`);
  cloud.style.setProperty("--y", `${position.y.toFixed(1)}px`);
  cloud.style.setProperty("--dx", `${(originX - position.x).toFixed(1)}px`);
  cloud.style.setProperty("--dy", `${(originY - position.y).toFixed(1)}px`);
  cloud.style.setProperty("--scale", scale.toFixed(3));
  cloud.style.setProperty("--float-duration", `${(5.4 + random() * 2.8).toFixed(2)}s`);
  cloud.style.setProperty("--drift-end", `${driftDistance.toFixed(1)}px`);
  cloud.style.setProperty("--drift-sway", `${sway.toFixed(1)}px`);
  cloud.style.setProperty("--drift-duration", `${driftDuration.toFixed(2)}s`);
  cloud.style.setProperty("--drift-delay", "0s");

  motion.className = "cloud__motion";
  body.className = "cloud__body";
  text.className = "cloud__text";
  time.className = "cloud__time";

  text.textContent = message.text;
  time.dateTime = new Date(message.createdAt).toISOString();
  time.textContent = formatTime(message.createdAt);

  body.append(text, time);
  motion.append(body);
  cloud.append(motion);
  cloud.addEventListener(
    "animationend",
    (event) => {
      if (event.animationName !== "cloud-drift-up") {
        return;
      }

      releaseExpiredCloud(message.id, cloud);
    },
    { once: true },
  );

  return cloud;
}

function getCloudTargetRect(cloud) {
  return {
    left: Number(cloud.dataset.targetLeft),
    right: Number(cloud.dataset.targetRight),
    top: Number(cloud.dataset.targetTop),
    bottom: Number(cloud.dataset.targetBottom),
  };
}

function removeCloudElement(id, element, options = {}) {
  const timer = cloudReleaseTimers.get(id);

  if (timer) {
    window.clearInterval(timer);
    cloudReleaseTimers.delete(id);
  }

  cloudElements.delete(id);
  element.remove();

  if (options.visuallyExpired) {
    visuallyExpiredMessageIds.add(id);
  }

  if (options.expireLocal) {
    expireLocalMessage(id);
  }
}

function releaseExpiredCloud(id, element) {
  removeCloudElement(id, element, {
    expireLocal: true,
    visuallyExpired: true,
  });
}

function watchCloudVisibility(id, element) {
  const checkVisibility = () => {
    if (!element.isConnected) {
      removeCloudElement(id, element);
      return;
    }

    const cloudRect = element.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();

    if (cloudRect.bottom <= fieldRect.top + 1) {
      releaseExpiredCloud(id, element);
    }
  };
  const timer = window.setInterval(checkVisibility, 300);

  cloudReleaseTimers.set(id, timer);
  window.requestAnimationFrame(checkVisibility);
}

function renderClouds(messages) {
  const normalizedMessages = messages.map(normalizeMessage);
  const activeIds = new Set(normalizedMessages.map((message) => message.id));

  for (const id of visuallyExpiredMessageIds) {
    if (!activeIds.has(id)) {
      visuallyExpiredMessageIds.delete(id);
    }
  }

  const visibleMessages = normalizedMessages
    .filter((message) => !visuallyExpiredMessageIds.has(message.id))
    .slice(0, getVisibleCapacity());
  const visibleIds = new Set(visibleMessages.map((message) => message.id));

  for (const [id, element] of cloudElements.entries()) {
    if (!visibleIds.has(id)) {
      removeCloudElement(id, element);
    }
  }

  const occupiedRects = getOccupiedRects();

  for (const message of visibleMessages) {
    if (cloudElements.has(message.id)) {
      continue;
    }

    const cloud = createCloud(message, occupiedRects);
    const positionCollided = cloud.dataset.collided === "true";

    if (positionCollided) {
      deferLocalMessage(message.id);
      continue;
    }

    field.append(cloud);
    cloudElements.set(message.id, cloud);
    watchCloudVisibility(message.id, cloud);
    occupiedRects.push(getCloudTargetRect(cloud));
  }
}

function setStatus(message = "") {
  limitStatus.textContent = message;
}

function setComposerDisabled(disabled) {
  sendButton.disabled = disabled;
}

function updateComposerState(state = {}) {
  const capacity = Number(state.capacity || CLOUD_CAPACITY);

  if (isSubmitting) {
    setComposerDisabled(true);
    setStatus("Отправляем...");
    return;
  }

  if (state.ownQueuePosition) {
    setComposerDisabled(true);
    setStatus(`Небо заполнено. Ваше сообщение в очереди: ${state.ownQueuePosition}.`);
    return;
  }

  setComposerDisabled(false);

  if (state.queueSize > 0 && state.activeCount >= capacity) {
    setStatus(`Небо заполнено. В очереди ждут ${state.queueSize}.`);
    return;
  }

  if (state.activeCount >= capacity) {
    setStatus("Небо заполнено. Новые сообщения попадут в очередь.");
    return;
  }

  setStatus("");
}

function getLocalStatePayload() {
  return {
    active: localState.active,
    queueSize: localState.queue.length,
    ownQueuePosition: queuedByMeId
      ? localState.queue.findIndex((message) => message.id === queuedByMeId) + 1 || null
      : null,
    activeCount: localState.active.length,
    capacity: getVisibleCapacity(),
  };
}

function rememberComposerState(state) {
  lastComposerState = state;
  return state;
}

function promoteLocalQueue() {
  while (localState.active.length < getVisibleCapacity() && localState.queue.length > 0) {
    const nextMessage = localState.queue.shift();

    nextMessage.startedAt = Date.now();
    localState.active.push(nextMessage);

    if (nextMessage.id === queuedByMeId) {
      queuedByMeId = null;
      setStatus("Место освободилось. Ваше сообщение отправилось.");
    }
  }

  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  renderClouds(state.active);
  updateComposerState(state);
}

function expireLocalMessage(id) {
  const before = localState.active.length;
  localState.active = localState.active.filter((message) => message.id !== id);

  if (before !== localState.active.length) {
    window.setTimeout(promoteLocalQueue, LOCAL_PROMOTE_DELAY_MS);
  }
}

function makeRoomForLocalMessage() {
  const userMessageTarget = Math.max(1, getVisibleCapacity() - 1);
  const firstSeedIndex = localState.active.findIndex((message) => message.seed);

  if (firstSeedIndex >= 0) {
    localState.active.splice(firstSeedIndex, 1);
  }

  while (localState.active.length >= userMessageTarget) {
    const seedIndex = localState.active.findIndex((message) => message.seed);

    if (seedIndex < 0) {
      return;
    }

    localState.active.splice(seedIndex, 1);
  }
}

function deferLocalMessage(id) {
  if (API_BASE_URL) {
    return;
  }

  const index = localState.active.findIndex((message) => message.id === id);

  if (index < 0) {
    return;
  }

  const [message] = localState.active.splice(index, 1);

  if (!message.seed) {
    localState.queue.unshift(message);
    queuedByMeId = message.id;
  }

  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  updateComposerState(state);
}

function submitLocalMessage(text) {
  const message = createMessage(text);

  makeRoomForLocalMessage();

  if (localState.queue.length === 0 && localState.active.length < getVisibleCapacity()) {
    localState.active.push(message);
  } else {
    localState.queue.push(message);
    queuedByMeId = message.id;
  }

  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  renderClouds(state.active);
  updateComposerState(state);
}

async function fetchSkyState() {
  const response = await fetch(`${API_BASE_URL}/state?clientId=${encodeURIComponent(clientId)}`);

  if (!response.ok) {
    throw new Error(`State request failed: ${response.status}`);
  }

  return response.json();
}

async function submitRemoteMessage(text) {
  const response = await fetch(`${API_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ text, clientId }),
  });

  if (!response.ok) {
    throw new Error(`Message request failed: ${response.status}`);
  }

  return response.json();
}

function applyRemoteState(state) {
  const active = Array.isArray(state.active) ? state.active.map(normalizeMessage) : [];

  lastActiveMessages = active;
  renderClouds(active);

  if (queuedByMeId && active.some((message) => message.id === queuedByMeId)) {
    queuedByMeId = null;
    setStatus("Место освободилось. Ваше сообщение отправилось.");
  }

  updateComposerState(rememberComposerState({
    activeCount: active.length,
    capacity: Number(state.capacity || CLOUD_CAPACITY),
    queueSize: Number(state.queueSize || 0),
    ownQueuePosition: state.ownQueuePosition || null,
  }));
}

async function syncRemoteState() {
  if (!API_BASE_URL) {
    return;
  }

  try {
    const state = await fetchSkyState();
    applyRemoteState(state);
  } catch {
    setComposerDisabled(false);
    setStatus("Связь с общим небом потерялась. Пробуем снова...");
  } finally {
    window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(syncRemoteState, POLL_INTERVAL_MS);
  }
}

async function handleSubmit(event) {
  event.preventDefault();

  const text = sanitizeMessageText(input.value);
  let stateWasApplied = false;
  let hadError = false;

  if (!text || isSubmitting) {
    input.focus();
    return;
  }

  isSubmitting = true;
  updateComposerState();

  try {
    if (API_BASE_URL) {
      const state = await submitRemoteMessage(text);
      queuedByMeId = state.acceptedId && state.status === "queued" ? state.acceptedId : null;
      applyRemoteState(state);
      stateWasApplied = true;
    } else {
      submitLocalMessage(text);
      stateWasApplied = true;
    }

    if (sanitizeMessageText(input.value) === text) {
      input.value = "";
      updateCharCounter();
    }
  } catch {
    hadError = true;
    setComposerDisabled(false);
    setStatus("Не получилось отправить. Попробуйте ещё раз.");
  } finally {
    isSubmitting = false;

    if (!hadError) {
      updateComposerState(stateWasApplied ? lastComposerState : API_BASE_URL ? { activeCount: lastActiveMessages.length } : getLocalStatePayload());
    }

    focusMessageInput();
  }
}

function rerenderAfterResize() {
  for (const [id, element] of cloudElements.entries()) {
    removeCloudElement(id, element);
  }

  cloudElements.clear();
  renderClouds(lastActiveMessages);
}

function focusMessageInput() {
  if (document.activeElement === input) {
    return;
  }

  input.focus({ preventScroll: true });
}

function focusMessageInputSoon() {
  window.clearTimeout(stickyFocusTimer);
  stickyFocusTimer = window.setTimeout(focusMessageInput, 0);
}

function isEditableElement(element) {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element?.isContentEditable
  );
}

function insertTextAtCursor(text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;

  input.setRangeText(text, start, end, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

document.addEventListener("pointerdown", (event) => {
  if (event.target === input) {
    return;
  }

  focusMessageInputSoon();
});

document.addEventListener(
  "keydown",
  (event) => {
    if (event.defaultPrevented || document.activeElement === input) {
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      focusMessageInput();
      form.requestSubmit();
      return;
    }

    if (event.key.length === 1 && !isEditableElement(event.target)) {
      event.preventDefault();
      focusMessageInput();
      insertTextAtCursor(event.key);
    }
  },
  true,
);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    focusMessageInputSoon();
  }
});

form.addEventListener("submit", handleSubmit);
input.maxLength = MESSAGE_MAX_LENGTH;
input.addEventListener("input", enforceMessageLimit);

let resizeTimer;

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rerenderAfterResize, 120);
});

if (API_BASE_URL) {
  syncRemoteState();
} else {
  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  renderClouds(state.active);
  updateComposerState(state);
}

focusMessageInputSoon();
updateCharCounter();

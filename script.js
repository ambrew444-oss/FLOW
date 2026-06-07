const field = document.querySelector("#cloudField");
const form = document.querySelector("#messageForm");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector(".send-button");
const limitStatus = document.querySelector("#limitStatus");
const charCounter = document.querySelector("#charCounter");

const CLIENT_ID_STORAGE_KEY = "vibe-sky-client-id";
const API_BASE_URL = (window.VIBE_API_URL || "").replace(/\/$/, "");
const MESSAGE_MAX_LENGTH = 96;
const CLOUD_CAPACITY = 80;
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
const cloudReservations = new Map();
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
let queuePromotionTimer;

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

function getCloudGap() {
  return field.clientWidth < 580 ? 8 : 12;
}

function getCloudSlotSize() {
  const width = Math.max(field.clientWidth, 320);

  return {
    width: Math.min(width < 580 ? 286 : 360, width - 32),
    height: width < 580 ? 126 : 148,
  };
}

function getOccupiedRects() {
  const now = Date.now();
  const rects = [];

  for (const id of cloudReservations.keys()) {
    if (!cloudElements.has(id)) {
      cloudReservations.delete(id);
      continue;
    }

    const rect = getReservationRect(id, now);

    if (rect && rect.bottom > 0 && rect.top < field.clientHeight) {
      rects.push(rect);
    }
  }

  return rects;
}

function rectsOverlap(a, b, margin = getCloudGap()) {
  return (
    a.left - margin < b.right &&
    a.right + margin > b.left &&
    a.top - margin < b.bottom &&
    a.bottom + margin > b.top
  );
}

function getFreeCenterIntervals(occupiedRects, slotSize, rowY, width) {
  const margin = getCloudGap();
  const minCenter = slotSize.width / 2 + 16;
  const maxCenter = width - minCenter;
  const rowTop = rowY - slotSize.height / 2;
  const rowBottom = rowY + slotSize.height / 2;
  const blockedIntervals = occupiedRects
    .filter((rect) => rowTop - margin < rect.bottom && rowBottom + margin > rect.top)
    .map((rect) => ({
      start: clamp(rect.left - slotSize.width / 2 - margin, minCenter, maxCenter),
      end: clamp(rect.right + slotSize.width / 2 + margin, minCenter, maxCenter),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start);
  const freeIntervals = [];
  let cursor = minCenter;

  for (const interval of blockedIntervals) {
    if (interval.start > cursor) {
      freeIntervals.push({ start: cursor, end: interval.start });
    }

    cursor = Math.max(cursor, interval.end);
  }

  if (cursor < maxCenter) {
    freeIntervals.push({ start: cursor, end: maxCenter });
  }

  return freeIntervals.filter((interval) => interval.end - interval.start > 1);
}

function chooseCloudPosition(message, occupiedRects) {
  const width = Math.max(field.clientWidth, 320);
  const height = Math.max(field.clientHeight, 360);
  const visualSize = estimateCloudSize(message);
  const slotSize = getCloudSlotSize();
  const random = seededRandom(hashText(`${message.id}-${message.text}`));
  const fixedBottomRowY = height - slotSize.height / 2 - 10;
  const freeIntervals = getFreeCenterIntervals(occupiedRects, slotSize, fixedBottomRowY, width);

  if (freeIntervals.length > 0) {
    const totalFreeWidth = freeIntervals.reduce((total, interval) => total + interval.end - interval.start, 0);
    let intervalPick = random() * totalFreeWidth;
    let selectedInterval = freeIntervals[0];

    for (const interval of freeIntervals) {
      const intervalWidth = interval.end - interval.start;

      if (intervalPick <= intervalWidth) {
        selectedInterval = interval;
        break;
      }

      intervalPick -= intervalWidth;
    }

    const pointX = selectedInterval.start + random() * (selectedInterval.end - selectedInterval.start);
    const point = {
      x: pointX,
      y: fixedBottomRowY,
      left: pointX - slotSize.width / 2,
      right: pointX + slotSize.width / 2,
      top: fixedBottomRowY - slotSize.height / 2,
      bottom: fixedBottomRowY + slotSize.height / 2,
    };
    const xSlack = Math.max(0, slotSize.width - visualSize.width) / 2;
    const ySlack = Math.max(0, slotSize.height - visualSize.height) / 2;
    const visualX = clamp(point.x + (random() - 0.5) * xSlack * 1.7, point.left + visualSize.width / 2, point.right - visualSize.width / 2);
    const visualY = clamp(point.y + (random() - 0.5) * ySlack * 1.7, point.top + visualSize.height / 2, point.bottom - visualSize.height / 2);

    return {
      x: visualX,
      y: visualY,
      width: visualSize.width,
      height: visualSize.height,
      slotLeft: point.left,
      slotRight: point.right,
      slotTop: point.top,
      slotBottom: point.bottom,
      slotWidth: slotSize.width,
      slotHeight: slotSize.height,
    };
  }

  return {
    x: width / 2,
    y: fixedBottomRowY,
    width: visualSize.width,
    height: visualSize.height,
    slotLeft: width / 2 - slotSize.width / 2,
    slotRight: width / 2 + slotSize.width / 2,
    slotTop: fixedBottomRowY - slotSize.height / 2,
    slotBottom: fixedBottomRowY + slotSize.height / 2,
    slotWidth: slotSize.width,
    slotHeight: slotSize.height,
    collided: true,
  };
}

function createCloud(message, occupiedRects) {
  const position = chooseCloudPosition(message, occupiedRects);
  const originX = position.x;
  const originY = field.clientHeight + position.slotHeight + 54;
  const random = seededRandom(hashText(`motion-${message.id}`));
  const driftDistance = -(position.slotTop + position.slotHeight + 68);
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
  cloud.dataset.targetLeft = position.slotLeft.toFixed(1);
  cloud.dataset.targetRight = position.slotRight.toFixed(1);
  cloud.dataset.targetTop = position.slotTop.toFixed(1);
  cloud.dataset.targetBottom = position.slotBottom.toFixed(1);
  cloud.dataset.slotWidth = position.slotWidth.toFixed(1);
  cloud.dataset.slotHeight = position.slotHeight.toFixed(1);
  cloud.dataset.visualLeft = (position.x - position.width / 2).toFixed(1);
  cloud.dataset.visualRight = (position.x + position.width / 2).toFixed(1);
  cloud.dataset.visualTop = (position.y - position.height / 2).toFixed(1);
  cloud.dataset.visualBottom = (position.y + position.height / 2).toFixed(1);
  cloud.dataset.placedAt = String(Date.now());
  cloud.dataset.driftDistance = driftDistance.toFixed(1);
  cloud.dataset.driftDuration = driftDuration.toFixed(2);
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

function getReservationRect(id, now = Date.now()) {
  const reservation = cloudReservations.get(id);

  if (!reservation) {
    return null;
  }

  const progress = clamp((now - reservation.placedAt) / (reservation.driftDuration * 1000), 0, 1);
  const offsetY = reservation.driftDistance * progress;

  return {
    left: reservation.left,
    right: reservation.right,
    top: reservation.top + offsetY,
    bottom: reservation.bottom + offsetY,
  };
}

function removeCloudElement(id, element, options = {}) {
  const timer = cloudReleaseTimers.get(id);

  if (timer) {
    window.clearInterval(timer);
    cloudReleaseTimers.delete(id);
  }

  cloudElements.delete(id);
  cloudReservations.delete(id);
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

function createSpaceProbeMessage() {
  const text = sanitizeMessageText(input.value) || "Новое облако";

  return {
    id: `space-probe-${text}`,
    text,
    createdAt: Date.now(),
  };
}

function hasFreeCloudSpace(message = createSpaceProbeMessage()) {
  return !chooseCloudPosition(message, getOccupiedRects()).collided;
}

function watchCloudVisibility(id, element) {
  const checkVisibility = () => {
    if (!element.isConnected) {
      removeCloudElement(id, element);
      return;
    }

    const cloudRect = getReservationRect(id);

    if (cloudRect && cloudRect.bottom <= 1) {
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
    .slice(0, CLOUD_CAPACITY);
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
    cloudReservations.set(message.id, {
      ...getCloudTargetRect(cloud),
      placedAt: Number(cloud.dataset.placedAt),
      driftDistance: Number(cloud.dataset.driftDistance),
      driftDuration: Number(cloud.dataset.driftDuration),
    });
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

  if (state.queueSize > 0) {
    setStatus(`Нижний ряд занят. В очереди ждут ${state.queueSize}.`);
    return;
  }

  if (state.hasFreeSpace === false) {
    setStatus("Нижний ряд пока занят. Новые сообщения попадут в очередь.");
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
    hasFreeSpace: hasFreeCloudSpace(),
  };
}

function rememberComposerState(state) {
  lastComposerState = state;
  return state;
}

function scheduleLocalQueuePromotion() {
  if (API_BASE_URL || localState.queue.length === 0 || queuePromotionTimer) {
    return;
  }

  queuePromotionTimer = window.setTimeout(() => {
    queuePromotionTimer = null;
    promoteLocalQueue();
  }, LOCAL_PROMOTE_DELAY_MS);
}

function promoteLocalQueue() {
  if (localState.queue.length > 0 && hasFreeCloudSpace(localState.queue[0])) {
    const nextMessage = localState.queue.shift();

    nextMessage.startedAt = Date.now();
    localState.active.push(nextMessage);

    if (nextMessage.id === queuedByMeId) {
      queuedByMeId = null;
      setStatus("Место освободилось. Ваше сообщение отправилось.");
    }
  }

  const draftState = getLocalStatePayload();
  lastActiveMessages = draftState.active;
  renderClouds(draftState.active);

  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  updateComposerState(state);
  scheduleLocalQueuePromotion();
}

function expireLocalMessage(id) {
  const before = localState.active.length;
  localState.active = localState.active.filter((message) => message.id !== id);

  if (before !== localState.active.length) {
    scheduleLocalQueuePromotion();
  }
}

function makeRoomForLocalMessage() {
  const firstSeedIndex = localState.active.findIndex((message) => message.seed);

  if (firstSeedIndex >= 0) {
    localState.active.splice(firstSeedIndex, 1);
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
  scheduleLocalQueuePromotion();
}

function submitLocalMessage(text) {
  const message = createMessage(text);

  makeRoomForLocalMessage();

  if (localState.queue.length === 0) {
    localState.active.push(message);
  } else {
    localState.queue.push(message);
    queuedByMeId = message.id;
  }

  const draftState = getLocalStatePayload();
  lastActiveMessages = draftState.active;
  renderClouds(draftState.active);

  const state = rememberComposerState(getLocalStatePayload());
  lastActiveMessages = state.active;
  updateComposerState(state);
  scheduleLocalQueuePromotion();
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
    hasFreeSpace: hasFreeCloudSpace(),
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

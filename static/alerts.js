const soundButton = document.querySelector("#soundButton");
const KITCHEN_STATUSES = ["sent", "preparing", "suspended"];
const LATE_MINUTES = 25;
const CRITICAL_MINUTES = 35;

let audioContext = null;
let soundMuted = false;
try { soundMuted = localStorage.getItem("comandaSoundMuted") === "1"; } catch (error) {}

const seenKitchenItems = new Set();
const ticketAlertLevels = new Map();
let alertsInitialized = false;

function getAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContext = new AudioContextClass();
  }
  return audioContext;
}

function unlockAudio() {
  const context = getAudioContext();
  if (context && context.state === "suspended") context.resume().catch(() => {});
  updateSoundButton();
}

function playTones(tones, { type = "sine", volume = 0.35 } = {}) {
  if (soundMuted) return;
  const context = getAudioContext();
  if (!context) return;
  if (context.state === "suspended") context.resume().catch(() => {});
  const start = context.currentTime + 0.02;
  tones.forEach(([frequency, offset, duration]) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(volume, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + duration + 0.05);
  });
}

const alertSounds = {
  newOrder: () => playTones([[880, 0, 0.18], [1175, 0.17, 0.3]], { type: "sine", volume: 0.4 }),
  late: () => playTones([[740, 0, 0.16], [740, 0.24, 0.16], [740, 0.48, 0.16]], { type: "triangle", volume: 0.45 }),
  critical: () => playTones([[988, 0, 0.14], [784, 0.18, 0.14], [988, 0.36, 0.14], [784, 0.54, 0.14], [988, 0.72, 0.14], [784, 0.9, 0.2]], { type: "square", volume: 0.25 }),
};

function updateSoundButton() {
  if (!soundButton) return;
  soundButton.hidden = currentRole !== "cocina";
  const needsTap = !soundMuted && (!audioContext || audioContext.state !== "running");
  soundButton.textContent = soundMuted ? "🔕" : "🔔";
  soundButton.classList.toggle("sound-needs-tap", needsTap);
  const label = soundMuted ? "Sonido desactivado · tocá para activar" : needsTap ? "Tocá para activar el sonido de alertas" : "Sonido de alertas activado · tocá para silenciar";
  soundButton.title = label;
  soundButton.setAttribute("aria-label", label);
}

function oldestPendingSentAt(table) {
  const times = table.items.filter((item) => KITCHEN_STATUSES.includes(item.status)).map((item) => Date.parse(item.sent_at || "")).filter(Number.isFinite);
  return times.length ? Math.min(...times) : null;
}

function checkKitchenAlerts() {
  updateSoundButton();
  if (currentRole !== "cocina") {
    alertsInitialized = false;
    seenKitchenItems.clear();
    ticketAlertLevels.clear();
    return;
  }
  if (!state) return;

  let hasNewOrder = false;
  let alertLevel = 0;
  const activeTickets = new Set();
  const now = Date.now();

  state.tables.forEach((table) => {
    if (table.status !== "open") return;
    table.items.forEach((item) => {
      if (item.status === "draft" || item.status === "canceled") return;
      if (!seenKitchenItems.has(item.id)) {
        seenKitchenItems.add(item.id);
        if (alertsInitialized && item.status === "sent") hasNewOrder = true;
      }
    });

    const oldest = oldestPendingSentAt(table);
    if (oldest === null) return;
    const ticketKey = table.id;
    activeTickets.add(ticketKey);
    const minutes = (now - oldest) / 60000;
    const level = minutes > CRITICAL_MINUTES ? 2 : minutes > LATE_MINUTES ? 1 : 0;
    const known = ticketAlertLevels.get(ticketKey) ?? (alertsInitialized ? 0 : level);
    if (level > known) alertLevel = Math.max(alertLevel, level);
    ticketAlertLevels.set(ticketKey, Math.max(known, level));
  });

  [...ticketAlertLevels.keys()].forEach((key) => { if (!activeTickets.has(key)) ticketAlertLevels.delete(key); });
  alertsInitialized = true;

  if (alertLevel === 2) alertSounds.critical();
  else if (alertLevel === 1) alertSounds.late();
  else if (hasNewOrder) alertSounds.newOrder();
}

let pressNeededTap = null;
const soundNeedsTap = () => !soundMuted && (!audioContext || audioContext.state !== "running");
["pointerdown", "keydown"].forEach((eventName) => soundButton?.addEventListener(eventName, () => { pressNeededTap = soundNeedsTap(); }));

soundButton?.addEventListener("click", () => {
  const needsTap = pressNeededTap ?? soundNeedsTap();
  pressNeededTap = null;
  if (needsTap) {
    unlockAudio();
    alertSounds.newOrder();
    return;
  }
  soundMuted = !soundMuted;
  try { localStorage.setItem("comandaSoundMuted", soundMuted ? "1" : "0"); } catch (error) {}
  updateSoundButton();
  if (!soundMuted) alertSounds.newOrder();
});

["pointerdown", "keydown", "touchstart"].forEach((eventName) => document.addEventListener(eventName, unlockAudio, { passive: true }));
setInterval(checkKitchenAlerts, 2000);

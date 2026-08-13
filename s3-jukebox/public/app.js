"use strict";

const PAGE_SIZE = 100;

const $ = (id) => document.getElementById(id);

const state = {
  q: "",
  sort: "relevance",
  offset: 0,
  total: 0,
  tracks: [],
  selected: new Set(),
  playingId: null,
};

/* ---------- helpers ---------- */

function formatTime(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "–";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3000);
}

async function api(path, options) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  if (response.status === 401) {
    showLogin();
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/* ---------- auth ---------- */

function showLogin() {
  $("login").hidden = false;
  $("app").hidden = true;
  $("password").focus();
}

function showApp() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("search").focus();
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = $("login-error");
  error.hidden = true;
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password: $("password").value }),
    });
    if (!response.ok) throw new Error("Incorrect password");
    $("password").value = "";
    showApp();
    await Promise.all([load(), refreshStats()]);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$("logout").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  showLogin();
});

/* ---------- library ---------- */

async function load() {
  const params = new URLSearchParams({
    sort: state.sort,
    limit: String(PAGE_SIZE),
    offset: String(state.offset),
  });
  if (state.q) params.set("q", state.q);

  const data = await api(`/api/tracks?${params}`);
  state.tracks = data.tracks;
  state.total = data.total;
  render();
}

function render() {
  const tbody = $("rows");
  tbody.replaceChildren();

  for (const track of state.tracks) {
    const row = document.createElement("tr");
    row.dataset.id = String(track.id);
    if (track.id === state.playingId) row.classList.add("playing");

    const check = document.createElement("td");
    check.className = "col-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.selected.has(track.id);
    box.addEventListener("click", (event) => event.stopPropagation());
    box.addEventListener("change", () => {
      if (box.checked) state.selected.add(track.id);
      else state.selected.delete(track.id);
      updateSelectionUI();
    });
    check.append(box);

    const title = document.createElement("td");
    title.className = "col-title";
    title.textContent = track.title || track.key;
    title.title = track.key;

    const artist = document.createElement("td");
    artist.className = "col-artist";
    artist.textContent = track.artist || "—";

    const album = document.createElement("td");
    album.className = "col-album";
    album.textContent = track.album || "—";

    const time = document.createElement("td");
    time.className = "col-time";
    time.textContent = formatTime(track.duration);

    const actions = document.createElement("td");
    actions.className = "col-actions";
    const download = document.createElement("button");
    download.className = "ghost";
    download.textContent = "Download";
    download.addEventListener("click", (event) => {
      event.stopPropagation();
      window.location.assign(`/api/tracks/${track.id}/download`);
    });
    actions.append(download);

    row.append(check, title, artist, album, time, actions);
    row.addEventListener("click", () => play(track.id));
    tbody.append(row);
  }

  $("empty").hidden = state.tracks.length > 0;

  const from = state.total === 0 ? 0 : state.offset + 1;
  const to = state.offset + state.tracks.length;
  $("page-label").textContent = state.total ? `${from}–${to} of ${state.total}` : "";
  $("prev").disabled = state.offset === 0;
  $("next").disabled = to >= state.total;
  $("select-page").checked =
    state.tracks.length > 0 && state.tracks.every((t) => state.selected.has(t.id));

  updateSelectionUI();
}

function updateSelectionUI() {
  const count = state.selected.size;
  $("zip-selected").disabled = count === 0;
  $("zip-selected").textContent = count ? `Download ${count} selected` : "Download selected";
  $("clear-selection").hidden = count === 0;
}

async function refreshStats() {
  try {
    const data = await api("/api/stats");
    const parts = [
      `${data.tracks.toLocaleString()} tracks`,
      `${data.artists.toLocaleString()} artists`,
      formatBytes(data.totalBytes),
    ];
    if (data.sync.running) {
      parts.push(`indexing… ${data.sync.indexed} done`);
      setTimeout(refreshStats, 2000);
    }
    $("summary").textContent = parts.join(" · ");
  } catch {
    /* stats are cosmetic */
  }
}

/* ---------- playback ---------- */

function play(id) {
  const track = state.tracks.find((t) => t.id === id);
  if (!track) return;

  state.playingId = id;
  $("player").hidden = false;
  $("now-title").textContent = track.title || track.key;
  $("now-artist").textContent = [track.artist, track.album].filter(Boolean).join(" — ") || "—";

  const cover = $("now-cover");
  if (track.cover_hash) {
    cover.src = `/api/tracks/${track.id}/cover`;
    cover.hidden = false;
  } else {
    cover.removeAttribute("src");
    cover.hidden = true;
  }

  const audio = $("audio");
  // Redirects to a presigned S3 URL, so the bytes come straight from S3.
  audio.src = `/api/tracks/${track.id}/stream`;
  audio.play().catch(() => toast("Playback failed — the link may have expired"));

  for (const row of document.querySelectorAll("#rows tr")) {
    row.classList.toggle("playing", row.dataset.id === String(id));
  }
}

function step(delta) {
  const index = state.tracks.findIndex((t) => t.id === state.playingId);
  const next = state.tracks[index + delta];
  if (next) play(next.id);
}

$("audio").addEventListener("ended", () => step(1));
$("next-track").addEventListener("click", () => step(1));
$("prev-track").addEventListener("click", () => step(-1));

/* ---------- downloads ---------- */

/**
 * Submits a real form so the browser handles the download itself — a fetch()
 * would buffer the whole archive in memory before saving it.
 */
function postDownload(fields) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/zip";
  form.style.display = "none";

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.name = name;
    input.value = value;
    form.append(input);
  }

  document.body.append(form);
  form.submit();
  form.remove();
}

$("zip-selected").addEventListener("click", () => {
  if (state.selected.size === 0) return;
  postDownload({ ids: JSON.stringify([...state.selected]) });
  toast(`Building a zip of ${state.selected.size} tracks…`);
});

$("zip-all").addEventListener("click", () => {
  if (state.total === 0) return;
  const label = state.q ? `${state.total} matching tracks` : `all ${state.total} tracks`;
  if (!confirm(`Download ${label} as a zip?`)) return;
  postDownload({ all: "1", q: state.q });
  toast("Building zip — the download will start shortly…");
});

$("clear-selection").addEventListener("click", () => {
  state.selected.clear();
  render();
});

$("select-page").addEventListener("change", (event) => {
  for (const track of state.tracks) {
    if (event.target.checked) state.selected.add(track.id);
    else state.selected.delete(track.id);
  }
  render();
});

/* ---------- search + paging ---------- */

let searchTimer;
$("search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    state.offset = 0;
    load().catch((err) => toast(err.message));
  }, 200);
});

$("sort").addEventListener("change", (event) => {
  state.sort = event.target.value;
  state.offset = 0;
  load().catch((err) => toast(err.message));
});

$("prev").addEventListener("click", () => {
  state.offset = Math.max(0, state.offset - PAGE_SIZE);
  load().catch((err) => toast(err.message));
  window.scrollTo({ top: 0 });
});

$("next").addEventListener("click", () => {
  state.offset += PAGE_SIZE;
  load().catch((err) => toast(err.message));
  window.scrollTo({ top: 0 });
});

$("reindex").addEventListener("click", async () => {
  await api("/api/reindex", { method: "POST" });
  toast("Re-indexing the bucket…");
  refreshStats();
});

/* ---------- boot ---------- */

(async () => {
  const { authenticated } = await api("/api/me");
  if (!authenticated) return showLogin();
  showApp();
  await Promise.all([load(), refreshStats()]);
})().catch(() => showLogin());

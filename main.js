/* =========================================================
   CONFIG / ESTADO
   ========================================================= */
const BACKEND_URL = "http://localhost:3000";

const state = {
  unit: localStorage.getItem("unit") || "C", // 'C' | 'F'
  fetchSeq: 0, // anti-carreras
  isSearching: false, // evita reentradas
  lastQueryKey: null, // para evitar repetir la misma query en muy poco tiempo
  lastRenderAt: 0, // timestamp del último render
};

/* =========================================================
   FORMATTERS / UTILS
   ========================================================= */
const nf1 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nfPerc0 = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const nf1raw = (n) => (Math.round(n * 10) / 10).toString();
const toF = (c) => (c * 9) / 5 + 32;
const kmhToMph = (k) => k * 0.621371;

const asTemp = (n) =>
  state.unit === "C" ? `${nf1.format(n)}°C` : `${nf1.format(toF(n))}°F`;
const asWind = (kmh) =>
  state.unit === "C"
    ? `${nf0.format(kmh)} km/h`
    : `${nf0.format(kmhToMph(kmh))} mph`;

const WMO_ICON = (code) => {
  if (code === 0) return "☀️";
  if (code >= 1 && code <= 3) return "⛅";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if (code >= 61 && code <= 67) return "🌧️";
  if (code >= 71 && code <= 77) return "🌨️";
  if (code >= 80 && code <= 82) return "🌦️";
  if (code === 85 || code === 86) return "❄️";
  if (code === 95 || code === 96 || code === 99) return "⛈️";
  return "🌤️";
};

// Cache (en formato interno, SIEMPRE °C, km/h)
const cache = new Map();

// helper numérico para coords en tarjetas
function fmt2(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toFixed(2) : "";
}

/* =========================================================
   DOM
   ========================================================= */
const form = document.getElementById("search-form");
const input = document.getElementById("city");
const loader = document.getElementById("loader");
const statusEl = document.getElementById("status");
const currentEl = document.getElementById("current");
const dailyEl = document.getElementById("daily");
const unitCBtn = document.getElementById("unit-c");
const unitFBtn = document.getElementById("unit-f");
const favBtn = document.getElementById("btn-fav");
const historyEl = document.getElementById("history");
const favoritesEl = document.getElementById("favorites");

// aseguro el contenido inicial del botón favorito
if (favBtn && !favBtn.querySelector(".star")) {
  favBtn.innerHTML = `☆ <span class="star">Favorito</span>`;
  favBtn.setAttribute("aria-pressed", "false");
}

/* =========================================================
   UI HELPERS
   ========================================================= */
function setLoading(is) {
  if (!loader) return;
  loader.setAttribute("aria-hidden", String(!is));
  form?.classList.toggle("is-loading", is); // activa/desactiva el spinner sin mover layout
}

function setStatus(msg, type = "info") {
  if (!statusEl) return;
  statusEl.textContent = msg || "";
  statusEl.className = "status " + (type === "error" ? "error" : "info");
}
function updateUnitButtons() {
  const isC = state.unit === "C";
  unitCBtn?.setAttribute("aria-pressed", String(isC));
  unitFBtn?.setAttribute("aria-pressed", String(!isC));
  if (unitCBtn) unitCBtn.disabled = isC;
  if (unitFBtn) unitFBtn.disabled = !isC;
}
function forceShow(el) {
  if (!el) return;
  el.hidden = false;
  el.removeAttribute("hidden");
  el.style.display = "";
}

/* =========================================================
   FETCH HELPERS
   ========================================================= */
async function fetchJSON(url, { signal, timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Error ${res.status}: ${res.statusText}`);
    return res.json();
  } catch (e) {
    clearTimeout(timer);
    if (!navigator.onLine)
      throw new Error("Estás sin conexión. Verificá tu internet.");
    throw e;
  }
}

// API al backend
const apiWeatherByCity = (city, signal) =>
  fetchJSON(`${BACKEND_URL}/weather?city=${encodeURIComponent(city)}`, {
    signal,
  });
const apiFavorites = () => fetchJSON(`${BACKEND_URL}/favorites`);
const apiToggleFavorite = (city, lat, lon) =>
  fetch(`${BACKEND_URL}/favorites/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ city, lat, lon }),
  }).then((r) => r.json());

/* =========================================================
   FAVORITO: UI y sincronización
   ========================================================= */
// setup inicial (por si el HTML no lo tenía así)
if (favBtn && !favBtn.querySelector(".star")) {
  favBtn.innerHTML = `<span class="glyph">☆</span> <span class="star">Favorito</span>`;
  favBtn.setAttribute("aria-pressed", "false");
}

function applyFavVisual(isOn) {
  if (!favBtn) return;
  favBtn.classList.toggle("is-on", isOn);
  favBtn.setAttribute("aria-pressed", String(isOn));
  const glyph = isOn ? "★" : "☆";
  favBtn.innerHTML = `<span class="glyph">${glyph}</span> <span class="star">Favorito</span>`;
}

async function syncFavButton(place) {
  if (!favBtn || !place) return;
  try {
    const list = await apiFavorites();
    const isFav = list.some(
      (f) => f.city?.toLowerCase() === String(place).toLowerCase()
    );
    applyFavVisual(isFav);
  } catch {
    // si falla, dejamos el estado actual
  }
}

/* =========================================================
   RENDER
   ========================================================= */
function renderCurrent(el, place, current) {
  const items = [
    { label: "Temperatura", val: asTemp(current.temperature_2m) },
    { label: "Sensación", val: asTemp(current.apparent_temperature) },
    { label: "Viento", val: asWind(current.wind_speed_10m) },
  ];
  if (typeof current.relative_humidity_2m === "number")
    items.push({
      label: "Humedad",
      val: `${nfPerc0.format(current.relative_humidity_2m)}%`,
    });
  if (typeof current.precipitation === "number")
    items.push({
      label: "Precipitación",
      val: `${nf1raw(current.precipitation)} mm`,
    });
  if (typeof current.pressure_msl === "number")
    items.push({
      label: "Presión",
      val: `${nf0.format(current.pressure_msl)} hPa`,
    });

  el.innerHTML = `
    <div class="row" style="justify-content: space-between;">
      <div>
        <h2 class="place">${place}</h2>
        <div class="muted">${new Date().toLocaleString("es-AR")}</div>
      </div>
      <div class="emoji" aria-hidden="true">${WMO_ICON(
        current.weather_code
      )}</div>
    </div>

    <div class="kv">
      ${items
        .map(
          ({ label, val }) => `
        <div>
          <div class="label">${label}</div>
          <div class="${
            label === "Temperatura" || label === "Sensación" ? "big" : ""
          }">${val}</div>
        </div>`
        )
        .join("")}
    </div>
  `;
}

function renderDaily(el, daily) {
  const days = daily.time.slice(0, 5).map((date, i) => ({
    date,
    tmax: daily.temperature_2m_max[i],
    tmin: daily.temperature_2m_min[i],
    code: daily.weather_code[i],
    pprob: daily.precipitation_probability_max?.[i],
    psum: daily.precipitation_sum?.[i],
  }));

  el.innerHTML = days
    .map(
      (d) => `
    <article class="day">
      <div class="row" style="justify-content: space-between;">
        <strong>${new Date(d.date).toLocaleDateString("es-AR", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        })}</strong>
        <span class="emoji" aria-hidden="true">${WMO_ICON(d.code)}</span>
      </div>
      <div class="row"><span class="muted">Mín</span><span>${asTemp(
        d.tmin
      )}</span></div>
      <div class="row"><span class="muted">Máx</span><span>${asTemp(
        d.tmax
      )}</span></div>
      ${
        typeof d.pprob === "number"
          ? `<div class="row"><span class="muted">Lluvia (prob.)</span><span>${nfPerc0.format(
              d.pprob
            )}%</span></div>`
          : ""
      }
      ${
        typeof d.psum === "number"
          ? `<div class="row"><span class="muted">Lluvia (acum.)</span><span>${nf1raw(
              d.psum
            )} mm</span></div>`
          : ""
      }
    </article>
  `
    )
    .join("");
}

function render(place, data) {
  // mostrar paneles (si algo los ocultó)
  forceShow(currentEl);
  forceShow(dailyEl);

  renderCurrent(currentEl, place, data.current);
  renderDaily(dailyEl, data.daily);

  // Botón Favorito solo con coords válidas
  if (favBtn) {
    const hasLatLon =
      Number.isFinite(Number(data.latitude)) &&
      Number.isFinite(Number(data.longitude));
    favBtn.hidden = !hasLatLon;
    if (hasLatLon) {
      favBtn.dataset.city = place;
      favBtn.dataset.lat = String(data.latitude);
      favBtn.dataset.lon = String(data.longitude);
    } else {
      delete favBtn.dataset.city;
      delete favBtn.dataset.lat;
      delete favBtn.dataset.lon;
    }
    // sincronizar estado visual con la DB
    syncFavButton(place);
  }

  // Persistir última vista para rehidratación SIN volver a pedir a la API
  sessionStorage.setItem(
    "lastResult",
    JSON.stringify({ place, data, ts: Date.now() })
  );
  localStorage.setItem("lastSearch", place);
  localStorage.setItem("lastSearchTime", new Date().toISOString());

  state.lastRenderAt = Date.now();
}

/* =========================================================
   HISTORIAL (tarjetas flotantes)
   ========================================================= */
const HISTORY_KEY = "city-history";
function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) ?? [];
  } catch {
    return [];
  }
}
function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}
function renderHistory() {
  if (!historyEl) return;
  const list = getHistory().slice(0, 4); // ← renderiza sólo 4
  if (!list.length) {
    historyEl.innerHTML = "";
    historyEl.classList.remove("floating-grid", "history");
    return;
  }
  historyEl.classList.add("floating-grid", "history");
  historyEl.innerHTML = list
    .map(
      (c) => `
    <article class="floating-card" data-city="${c}">
      <h4 class="title">${c}</h4>
      <!-- sin subtítulo -->
    </article>
  `
    )
    .join("");
}

function addToHistory(city) {
  let list = getHistory().filter(
    (c) => c.toLowerCase() !== String(city).toLowerCase()
  );
  list.unshift(city);
  list = list.slice(0, 4); // ← antes era 5; ahora 4
  saveHistory(list);
  renderHistory();
}

// Delegación: click en cualquier tarjeta del historial
historyEl?.addEventListener("click", (e) => {
  const card = e.target.closest(".floating-card[data-city]");
  if (!card) return;
  searchCity(card.dataset.city);
});

/* =========================================================
   FAVORITOS (tarjetas flotantes clickeables)
   ========================================================= */
async function renderFavorites() {
  if (!favoritesEl) return;
  try {
    const list = await apiFavorites();
    if (!list?.length) {
      favoritesEl.classList.remove("floating-grid");
      favoritesEl.innerHTML = "";
      return;
    }
    favoritesEl.classList.add("floating-grid");
    favoritesEl.innerHTML = list
      .map(
        (f) => `
      <article class="floating-card" data-city="${f.city}">
        <h4 class="title">${f.city}</h4>
      </article>
    `
      )
      .join("");
  } catch (e) {
    console.error("Error cargando favoritos", e);
  }
}

// Delegación: click en cualquier tarjeta de favoritos
favoritesEl?.addEventListener("click", (e) => {
  const card = e.target.closest(".floating-card[data-city]");
  if (!card) return;
  searchCity(card.dataset.city);
});

/* =========================================================
   BÚSQUEDA (anti-duplicado y anti-loop)
   ========================================================= */
let controller; // AbortController compartido

async function searchCity(city) {
  const key = (city || "").trim().toLowerCase();
  if (!key) return;

  // Si es la misma query en menos de 3s, ignoramos para evitar "rebotes"
  if (state.lastQueryKey === key && Date.now() - state.lastRenderAt < 3000) {
    return;
  }
  if (state.isSearching) return; // evita reentradas
  state.isSearching = true;
  state.lastQueryKey = key;

  const mySeq = ++state.fetchSeq;

  // Cancelar cualquier fetch en vuelo
  if (controller) controller.abort();
  controller = new AbortController();

  // Cache inmediata
  if (cache.has(key)) {
    const { place, data } = cache.get(key);
    if (mySeq === state.fetchSeq) {
      render(place, data);
      addToHistory(place);
      setStatus("");
      setLoading(false);
    }
    state.isSearching = false;
    return;
  }

  try {
    setLoading(true);
    setStatus("Buscando…");

    const resp = await apiWeatherByCity(key, controller.signal);

    if (mySeq !== state.fetchSeq) return; // llegó tarde, descartar

    const place = resp.place;
    const data = {
      current: resp.current,
      daily: resp.daily,
      latitude: resp.lat ?? resp.latitude,
      longitude: resp.lon ?? resp.longitude,
    };

    cache.set(key, { place, data });
    cache.set(place.toLowerCase(), { place, data });

    render(place, data);
    addToHistory(place);
    setStatus("");
  } catch (err) {
    if (err.name !== "AbortError") {
      setStatus(err.message || "Error en la búsqueda", "error");
      // importante: NO ocultamos current/daily; mantenemos el último render
    }
  } finally {
    if (mySeq === state.fetchSeq) setLoading(false);
    state.isSearching = false;
  }
}

/* =========================================================
   EVENTOS
   ========================================================= */
form?.addEventListener("submit", (e) => {
  e.preventDefault();
  searchCity(input.value);
});

unitCBtn?.addEventListener("click", () => {
  state.unit = "C";
  localStorage.setItem("unit", "C");
  updateUnitButtons();
  const k = input.value.trim().toLowerCase();
  const cached =
    cache.get(k) || cache.get((cache.get(k)?.place || "").toLowerCase());
  if (cached) render(cached.place, cached.data);
});
unitFBtn?.addEventListener("click", () => {
  state.unit = "F";
  localStorage.setItem("unit", "F");
  updateUnitButtons();
  const k = input.value.trim().toLowerCase();
  const cached =
    cache.get(k) || cache.get((cache.get(k)?.place || "").toLowerCase());
  if (cached) render(cached.place, cached.data);
});

// --- FAVORITO: listener único con estado visual y control de doble-click ---
favBtn?.addEventListener("click", async (e) => {
  e.preventDefault();
  const city = favBtn.dataset.city;
  if (!city) return;
  const lat = parseFloat(favBtn.dataset.lat);
  const lon = parseFloat(favBtn.dataset.lon);

  const wasOn = favBtn.classList.contains("is-on");
  applyFavVisual(!wasOn); // optimista
  favBtn.disabled = true; // evita doble click

  try {
    const resp = await apiToggleFavorite(city, lat, lon);
    if (resp?.added) {
      applyFavVisual(true);
    } else if (resp?.removed) {
      applyFavVisual(false);
    } else {
      applyFavVisual(wasOn); // rollback si la API no es clara
    }
  } catch (err) {
    console.error("Toggle favorito falló:", err);
    applyFavVisual(wasOn); // rollback si falló
  } finally {
    favBtn.disabled = false;
    renderFavorites?.(); // refresca grilla
  }
});

/* =========================================================
   INICIALIZACIÓN (rehidratación SIN pedir a la API)
   ========================================================= */
updateUnitButtons();
renderHistory();
renderFavorites();
setStatus("Escribí una ciudad y presioná Buscar.");

// Rehidratar último resultado desde sessionStorage (si existe)
(() => {
  const raw = sessionStorage.getItem("lastResult");
  if (!raw) return;
  try {
    const { place, data } = JSON.parse(raw);
    if (place && data && data.current && data.daily) {
      render(place, data);
      setStatus("");
    }
  } catch {}
})();

// Título: caída desde arriba al cargar
(() => {
  const h1 =
    document.querySelector(".hero--in-box h1") ||
    document.querySelector(".hero h1");
  if (!h1 || !window.gsap) return;

  // estado inicial (evita parpadeo antes de animar)
  gsap.set(h1, { y: -80, opacity: 0 });

  // animación de entrada
  gsap.to(h1, {
    y: 0,
    opacity: 1,
    duration: 0.9,
    ease: "bounce.out", // probá "back.out(1.6)" si lo querés menos elástico
  });
})();

// === Fondo de video: velocidad lenta + evitar "saltos"/pausas ===
(() => {
  const vid = document.querySelector(".bg > video");
  if (!vid) return;

  const SPEED = 0.5; // 0.5–0.8 (más chico = más lento)
  const apply = () => {
    try {
      vid.defaultPlaybackRate = SPEED; // futuras reproducciones
      vid.playbackRate = SPEED; // velocidad actual
    } catch {}
  };
  const ensurePlaying = () => {
    if (vid.paused) vid.play().catch(() => {});
  };

  vid.addEventListener(
    "loadedmetadata",
    () => {
      apply();
      ensurePlaying();
    },
    { once: true }
  );
  vid.addEventListener("canplay", apply);
  vid.addEventListener("playing", apply);

  // Si algo cambia la velocidad, volvemos a la nuestra
  vid.addEventListener("ratechange", () => {
    if (Math.abs(vid.playbackRate - SPEED) > 0.01) apply();
  });

  // Al volver a la pestaña/ventana, que no quede pausado
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      apply();
      ensurePlaying();
    }
  });
  window.addEventListener("focus", () => {
    apply();
    ensurePlaying();
  });

  // Intento inmediato por si ya está listo
  apply();
})();

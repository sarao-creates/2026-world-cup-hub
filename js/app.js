/* World Cup 2026 Hub — live bracket, groups, match details, NYC watch parties */
(() => {
  const API = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
  const STANDINGS_API = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings?season=2026";
  const DATE_RANGE = "20260601-20260801";
  const REFRESH_MS = 60_000;

  const ROUNDS = ["round-of-32", "round-of-16", "quarterfinals", "semifinals", "final"];
  const ROUND_LABELS = {
    "group-stage": "Group Stage",
    "round-of-32": "Round of 32",
    "round-of-16": "Round of 16",
    "quarterfinals": "Quarterfinals",
    "semifinals": "Semifinals",
    "3rd-place-match": "Third Place",
    "final": "Final",
  };
  const PLACEHOLDER_RE = /^(Round of 32|Round of 16|Quarterfinal|Semifinal)s?\s+(\d+)\s+(Winner|Loser)$/i;
  const PLACEHOLDER_ROUND = {
    "round of 32": "round-of-32",
    "round of 16": "round-of-16",
    "quarterfinal": "quarterfinals",
    "semifinal": "semifinals",
  };

  const state = {
    matches: [],
    byId: new Map(),
    standings: null,
    watchParties: null,
    tab: "bracket",
    openMatchId: null,
    summaryCache: new Map(),
    timer: null,
    fingerprint: null,
  };

  const $ = (sel) => document.querySelector(sel);

  // ESPN serves original assets (500px logos ~27KB, 720p posters ~185KB); the
  // combiner endpoint resizes on their CDN — logos drop to <1KB.
  function espnImg(url, w, square) {
    const m = /^https?:\/\/a\.espncdn\.com(\/.+)$/.exec(url || "");
    if (!m || m[1].startsWith("/combiner")) return url;
    return `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(m[1])}&w=${w}${square ? `&h=${w}` : ""}`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const fmtTime = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat([], { weekday: "short", month: "short", day: "numeric" });
  const fmtDayShort = new Intl.DateTimeFormat([], { month: "numeric", day: "numeric" });
  const fmtFull = new Intl.DateTimeFormat([], { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  // Calendar date of a match in New York, as YYYY-MM-DD (watch parties are NYC-local)
  const nycDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  // ---------- data ----------

  function normalizeSide(comp) {
    const t = comp.team || {};
    const name = t.displayName || "TBD";
    return {
      id: t.id,
      name,
      abbr: t.abbreviation || t.shortDisplayName || "TBD",
      logo: (t.logos && t.logos[0] && t.logos[0].href) || (t.logo || null),
      score: comp.score,
      shootout: comp.shootoutScore,
      winner: comp.winner === true,
      placeholder: !t.logos && /winner|loser|tbd|advance/i.test(name) || name === "TBD",
    };
  }

  function normalizeEvent(e) {
    const c = e.competitions[0];
    const home = c.competitors.find((x) => x.homeAway === "home") || c.competitors[0];
    const away = c.competitors.find((x) => x.homeAway === "away") || c.competitors[1];
    const note = c.altGameNote || e.altGameNote || "";
    const groupMatch = note.match(/Group ([A-L])\b/);
    const st = c.status || e.status || {};
    return {
      id: e.id,
      date: new Date(e.date),
      round: (e.season && e.season.slug) || "group-stage",
      group: groupMatch ? groupMatch[1] : null,
      state: (st.type && st.type.state) || "pre", // pre | in | post
      completed: !!(st.type && st.type.completed),
      detail: (st.type && st.type.shortDetail) || "",
      clock: st.displayClock || "",
      venue: (c.venue && c.venue.fullName) || "",
      city: (c.venue && c.venue.address && c.venue.address.city) || "",
      broadcast: ((c.broadcasts && c.broadcasts[0] && c.broadcasts[0].names) || []).join(" · "),
      home: normalizeSide(home),
      away: normalizeSide(away),
    };
  }

  async function fetchScoreboard() {
    const res = await fetch(`${API}/scoreboard?dates=${DATE_RANGE}&limit=200`);
    if (!res.ok) throw new Error(`Scoreboard HTTP ${res.status}`);
    const data = await res.json();
    const matches = (data.events || []).map(normalizeEvent);
    matches.sort((a, b) => a.date - b.date || Number(a.id) - Number(b.id));
    state.matches = matches;
    state.byId = new Map(matches.map((m) => [String(m.id), m]));
  }

  async function fetchStandings() {
    const res = await fetch(STANDINGS_API);
    if (!res.ok) throw new Error(`Standings HTTP ${res.status}`);
    const data = await res.json();
    if (data && Array.isArray(data.children) && data.children.length) state.standings = data;
  }

  async function fetchSummary(id, force) {
    if (!force && state.summaryCache.has(id)) return state.summaryCache.get(id);
    const res = await fetch(`${API}/summary?event=${id}`);
    if (!res.ok) throw new Error(`Summary HTTP ${res.status}`);
    const data = await res.json();
    state.summaryCache.set(id, data);
    return data;
  }

  async function fetchWatchParties() {
    if (state.watchParties) return state.watchParties;
    try {
      const res = await fetch("data/watchparties.json", { cache: "no-cache" });
      if (!res.ok) throw new Error();
      state.watchParties = await res.json();
    } catch {
      state.watchParties = { scrapedAt: null, events: [] };
    }
    return state.watchParties;
  }

  // ---------- bracket tree ----------

  function roundMatches(slug) {
    return state.matches.filter((m) => m.round === slug);
  }

  function findChild(side, prevList) {
    const ph = (side.name || "").match(PLACEHOLDER_RE);
    if (ph) {
      const idx = parseInt(ph[2], 10) - 1;
      return prevList[idx] || null;
    }
    if (!side.placeholder && side.id) {
      return prevList.find((m) => m.home.id === side.id || m.away.id === side.id) || null;
    }
    return null;
  }

  // Levels from a root match down to round-of-32: [[root], [c1,c2], [4], [8]]
  function subtreeLevels(root) {
    const levels = [[root]];
    let cur = [root];
    let ri = ROUNDS.indexOf(root.round);
    while (ri > 0) {
      const prev = roundMatches(ROUNDS[ri - 1]);
      const next = [];
      for (const m of cur) {
        if (!m) { next.push(null, null); continue; }
        next.push(findChild(m.home, prev), findChild(m.away, prev));
      }
      levels.push(next);
      cur = next;
      ri--;
    }
    return levels;
  }

  function teamRowHTML(side, m, isHome) {
    const played = m.state !== "pre";
    const cls = [
      "team-row",
      side.placeholder ? "tbd" : "",
      m.completed && side.winner ? "decided-winner" : "",
      m.state === "in" ? "playing" : "",
    ].filter(Boolean).join(" ");
    const logo = side.logo && !side.placeholder
      ? `<img src="${esc(espnImg(side.logo, 48, true))}" alt="" loading="lazy">`
      : `<span class="flag-ph">·</span>`;
    const label = side.placeholder ? shortPlaceholder(side.name) : side.name;
    const so = side.shootout != null ? ` <span class="so">(${esc(side.shootout)})</span>` : "";
    return `<div class="${cls}">${logo}<span class="t-name" title="${esc(side.name)}">${esc(label)}</span><span class="t-score">${played && side.score != null ? esc(side.score) + so : ""}</span></div>`;
  }

  function shortPlaceholder(name) {
    return name
      .replace(/Round of 32/i, "R32").replace(/Round of 16/i, "R16")
      .replace(/Quarterfinals?/i, "QF").replace(/Semifinals?/i, "SF")
      .replace(/Winner/i, "winner").replace(/Loser/i, "loser");
  }

  function matchMetaHTML(m) {
    if (m.state === "in") return `<span class="live-txt">● ${esc(m.clock || "LIVE")}</span><span>${esc(m.city.split(",")[0])}</span>`;
    if (m.state === "post") return `<span>${esc(m.detail || "FT")}</span><span>${fmtDayShort.format(m.date)}</span>`;
    return `<span>${fmtDayShort.format(m.date)}</span><span>${fmtTime.format(m.date)}</span>`;
  }

  function matchCardHTML(m, fed) {
    if (!m) return `<div class="match-card" style="visibility:hidden"></div>`;
    return `<button class="match-card ${m.state === "in" ? "is-live" : ""} ${fed ? "fed" : ""}" data-match="${esc(m.id)}">
      <div class="match-meta">${matchMetaHTML(m)}</div>
      ${teamRowHTML(m.home, m, true)}
      ${teamRowHTML(m.away, m, false)}
    </button>`;
  }

  // Render one bracket column: matches grouped into pair blocks with connectors
  function columnHTML(title, matches, sideCls, opts = {}) {
    const { linked = true, fed = false } = opts;
    const pairs = [];
    if (matches.length === 1) {
      pairs.push(`<div class="pair">${matchCardHTML(matches[0], fed)}</div>`);
    } else {
      for (let i = 0; i < matches.length; i += 2) {
        pairs.push(`<div class="pair ${linked ? "linked" : ""}">${matchCardHTML(matches[i], fed)}${matchCardHTML(matches[i + 1], fed)}</div>`);
      }
    }
    return `<div class="round-col ${sideCls}">
      <div class="round-title">${esc(title)}</div>
      <div class="round-body">${pairs.join("")}</div>
    </div>`;
  }

  function renderBracket() {
    const el = $("#bracket");
    const scroller = el.closest(".bracket-scroll");
    const scrollLeft = scroller ? scroller.scrollLeft : 0;
    const final = roundMatches("final")[0];
    const third = roundMatches("3rd-place-match")[0];

    if (!final) { // fallback: flat columns
      el.innerHTML = ROUNDS.map((slug) =>
        columnHTML(ROUND_LABELS[slug], roundMatches(slug), "col-left", { linked: false })
      ).join("");
      if (scroller) scroller.scrollLeft = scrollLeft;
      return;
    }

    const sfs = subtreeLevels(final)[1] || [null, null];
    const left = sfs[0] ? subtreeLevels(sfs[0]) : [[null]];
    const right = sfs[1] ? subtreeLevels(sfs[1]) : [[null]];
    // levels: [SF],[QF x2],[R16 x4],[R32 x8] → columns outermost-first on the left
    const leftCols = [...left].reverse();  // R32, R16, QF, SF
    const rightCols = [...right];          // SF, QF, R16, R32

    const labelFor = (arr) => ROUND_LABELS[(arr.find(Boolean) || {}).round] || "";

    const html = [];
    leftCols.forEach((lvl, i) => {
      html.push(columnHTML(labelFor(lvl) || ["Round of 32", "Round of 16", "Quarterfinals", "Semifinals"][i], lvl, "col-left", { fed: i > 0 }));
    });
    html.push(`<div class="center-col">
      <div class="final-wrap">
        <div class="round-title final-label">🏆 Final</div>
        ${matchCardHTML(final)}
      </div>
      ${third ? `<div class="third-wrap"><div class="round-title">Third Place</div>${matchCardHTML(third)}</div>` : ""}
    </div>`);
    rightCols.forEach((lvl, i) => {
      html.push(columnHTML(labelFor(lvl) || ["Semifinals", "Quarterfinals", "Round of 16", "Round of 32"][i], lvl, "col-right", { fed: i < rightCols.length - 1 }));
    });
    el.innerHTML = html.join("");
    if (scroller) scroller.scrollLeft = scrollLeft;

    const banner = $("#champion-banner");
    if (final.completed) {
      const champ = final.home.winner ? final.home : final.away.winner ? final.away : null;
      if (champ) {
        banner.hidden = false;
        banner.innerHTML = `🏆 ${esc(champ.name)} — 2026 World Cup Champions`;
      }
    } else banner.hidden = true;
  }

  // ---------- groups ----------

  function statVal(entry, name) {
    const s = (entry.stats || []).find((x) => x.name === name || x.type === name);
    return s ? s.displayValue : "–";
  }

  function statNum(entry, name) {
    const s = (entry.stats || []).find((x) => x.name === name || x.type === name);
    return s && typeof s.value === "number" ? s.value : 0;
  }

  function sortEntries(entries) {
    return entries.slice().sort((a, b) => {
      const ra = statNum(a, "rank"), rb = statNum(b, "rank");
      if (ra && rb && ra !== rb) return ra - rb;
      return statNum(b, "points") - statNum(a, "points")
        || statNum(b, "pointDifferential") - statNum(a, "pointDifferential")
        || statNum(b, "pointsFor") - statNum(a, "pointsFor");
    });
  }

  function renderGroups() {
    const el = $("#groups");
    if (!state.standings) { el.innerHTML = `<div class="loading">Loading groups…</div>`; return; }
    const groups = (state.standings.children || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    el.innerHTML = groups.map((g) => {
      const entries = sortEntries((g.standings && g.standings.entries) || []);
      const rows = entries.map((en) => {
        const t = en.team;
        const dot = en.note ? `<span class="qual-dot" style="background:${esc(en.note.color || "#22c55e")}" title="${esc(en.note.description || "")}"></span>` : `<span class="qual-dot" style="background:transparent"></span>`;
        const logo = t.logos && t.logos[0] ? `<img src="${esc(espnImg(t.logos[0].href, 48, true))}" alt="" loading="lazy">` : "";
        return `<tr>
          <td class="team-cell">${dot}${logo}<span>${esc(t.displayName)}</span></td>
          <td>${statVal(en, "gamesPlayed")}</td><td>${statVal(en, "wins")}</td>
          <td>${statVal(en, "ties")}</td><td>${statVal(en, "losses")}</td>
          <td>${statVal(en, "pointDifferential")}</td><td class="pts">${statVal(en, "points")}</td>
        </tr>`;
      }).join("");

      const letter = (g.name.match(/Group ([A-L])/) || [])[1];
      const fixtures = state.matches.filter((m) => m.group === letter);
      const fixtureRows = fixtures.map((m) => {
        let mid;
        if (m.state === "in") mid = `<span class="f-score">${esc(m.home.score)}–${esc(m.away.score)}</span> <span class="f-live">${esc(m.clock)}</span>`;
        else if (m.state === "post") mid = `<span class="f-score">${esc(m.home.score)}–${esc(m.away.score)}</span>`;
        else mid = `<span class="f-score upcoming">${fmtTime.format(m.date)}</span>`;
        const img = (s) => s.logo ? `<img src="${esc(espnImg(s.logo, 48, true))}" alt="">` : "";
        return `<button class="fixture-row" data-match="${esc(m.id)}">
          <span class="f-date">${fmtDayShort.format(m.date)}</span>
          <span class="f-team right">${`<span>${esc(m.home.abbr)}</span>`}${img(m.home)}</span>
          ${mid}
          <span class="f-team">${img(m.away)}<span>${esc(m.away.abbr)}</span></span>
        </button>`;
      }).join("");

      return `<div class="group-card">
        <h3>${esc(g.name)}</h3>
        <table class="group-table">
          <thead><tr><th>Team</th><th>GP</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${fixtures.length ? `<details class="group-fixtures"><summary>Matches (${fixtures.length})</summary>${fixtureRows}</details>` : ""}
      </div>`;
    }).join("");
  }

  // ---------- modal ----------

  function modalHeaderHTML(m) {
    const teamCol = (s) => `<div class="mh-team">
      ${s.logo && !s.placeholder ? `<img src="${esc(espnImg(s.logo, 120, true))}" alt="">` : `<div style="font-size:40px">⚽</div>`}
      <div class="name">${esc(s.name)}</div>
    </div>`;
    let middle;
    if (m.state === "pre") middle = `<div class="mh-vs">vs</div>`;
    else {
      const so = (s) => s.shootout != null ? `<span class="shootout"> (${esc(s.shootout)})</span>` : "";
      middle = `<div class="mh-score">${esc(m.home.score)}${so(m.home)} – ${esc(m.away.score)}${so(m.away)}</div>`;
    }
    const statusLine = m.state === "in"
      ? `<span class="live-txt">● LIVE — ${esc(m.clock)}</span>`
      : m.state === "post" ? esc(m.detail || "Full Time") : fmtFull.format(m.date);
    return `
      <div class="mh-round">${esc(ROUND_LABELS[m.round] || "")}${m.group ? ` · Group ${esc(m.group)}` : ""}</div>
      <div class="mh-teams">${teamCol(m.home)}${middle}${teamCol(m.away)}</div>
      <div class="mh-status">${statusLine}</div>
      <div class="mh-info">${esc(m.venue)}${m.city ? ` · ${esc(m.city)}` : ""}${m.broadcast ? `<br>📺 ${esc(m.broadcast)}` : ""}</div>`;
  }

  function countdownHTML(m) {
    const diff = m.date - Date.now();
    if (diff <= 0) return "";
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const min = Math.floor((diff % 3600000) / 60000);
    return `<div class="countdown">⏱ Kicks off in ${d ? d + "d " : ""}${h}h ${min}m</div>`;
  }

  function scorersHTML(m, summary) {
    const goals = ((summary.keyEvents || []).filter((k) => k.scoringPlay));
    const line = (g) => {
      const scorer = g.participants && g.participants[0] && g.participants[0].athlete;
      const assist = g.type && /^goal$/i.test(g.type.text || "") && g.participants && g.participants[1] && g.participants[1].athlete;
      const tag = /penalty/i.test(g.type?.text || "") ? " (pen)" : /own goal/i.test(g.type?.text || "") ? " (OG)" : "";
      return `<div class="scorer-line" title="${esc(g.text || "")}">⚽ <span class="min">${esc(g.clock?.displayValue || "")}</span> ${esc(scorer ? scorer.displayName : "Goal")}${tag}${assist ? ` <span class="assist">(${esc(assist.displayName)})</span>` : ""}</div>`;
    };
    const side = (teamId) => {
      const list = goals.filter((g) => String(g.team?.id) === String(teamId));
      return list.length ? list.map(line).join("") : `<div class="no-goals">No goals</div>`;
    };
    if (!goals.length && m.state === "post" && Number(m.home.score) + Number(m.away.score) > 0) return "";
    return `<div class="m-section"><h4>Goals</h4>
      <div class="scorers">
        <div class="side home">${side(m.home.id)}</div>
        <div class="side away">${side(m.away.id)}</div>
      </div></div>`;
  }

  function videosHTML(summary) {
    const seen = new Set();
    const vids = (summary.videos || []).filter((v) => {
      const src = v.links?.source?.HD?.href || v.links?.source?.href;
      if (!src || seen.has(v.headline)) return false;
      seen.add(v.headline);
      return true;
    }).slice(0, 8);
    if (!vids.length) return "";
    const cards = vids.map((v) => {
      const src = v.links?.source?.HD?.href || v.links?.source?.href;
      return `<div class="video-card">
        <video controls preload="none" poster="${esc(espnImg(v.thumbnail, 480) || "")}" playsinline>
          <source src="${esc(src)}" type="video/mp4">
        </video>
        <div class="v-title">${esc(v.headline)}</div>
      </div>`;
    }).join("");
    return `<div class="m-section"><h4>Highlights &amp; Clips</h4><div class="videos-grid">${cards}</div></div>`;
  }

  function xLinksHTML(m) {
    const hashtag = `#${m.home.abbr}${m.away.abbr}`;
    const q1 = encodeURIComponent(`${m.home.name} ${m.away.name} World Cup`);
    const q2 = encodeURIComponent(hashtag);
    return `<div class="m-section"><h4>Fan Reactions on X</h4>
      <div class="x-links">
        <a class="x-btn" target="_blank" rel="noopener" href="https://x.com/search?q=${q2}&f=top">𝕏 Top posts ${esc(hashtag)}</a>
        <a class="x-btn" target="_blank" rel="noopener" href="https://x.com/search?q=${q1}&f=top">𝕏 ${esc(m.home.name)} vs ${esc(m.away.name)}</a>
        <a class="x-btn" target="_blank" rel="noopener" href="https://x.com/search?q=${q1}&f=live">𝕏 Live feed</a>
      </div>
      <div class="x-note">Opens X search sorted by top posts — embedding tweets directly requires an X API subscription.</div>
    </div>`;
  }

  const BOROUGHS = ["Manhattan", "Brooklyn", "Queens", "The Bronx", "Staten Island", "Other NYC"];

  function watchPartiesHTML(m, wp) {
    const matchDay = nycDate(m.date);
    const dayParties = (wp.events || []).filter((p) => p.startDate === matchDay);
    const teamRe = new RegExp([m.home.name, m.away.name].filter((n) => n && n !== "TBD").map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
    const relevant = dayParties.filter((p) => teamRe.source !== "(?:)" && teamRe.test(p.name + " " + (p.description || "")));
    const list = dayParties.length ? dayParties : (wp.events || []).slice(0, 20);
    const usingFallback = !dayParties.length;

    const scraped = wp.scrapedAt ? `Scraped from Eventbrite ${new Date(wp.scrapedAt).toLocaleString()}` : "";
    if (!list.length) {
      return `<div class="m-section"><h4>Watch Parties in NYC</h4>
        <div class="wp-empty">No watch-party data yet. Run <code>npm run scrape</code> in the project folder to pull the latest events from Eventbrite.</div></div>`;
    }

    const byBorough = {};
    for (const p of list) (byBorough[p.borough || "Other NYC"] ||= []).push(p);

    const blocks = BOROUGHS.filter((b) => byBorough[b]).map((b) => {
      const cards = byBorough[b].map((p) => `
        <a class="party-card" href="${esc(p.url)}" target="_blank" rel="noopener">
          ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : ""}
          <div>
            <div class="p-name">${esc(p.name)}</div>
            <div class="p-venue">📍 ${esc(p.venueName || "")}${p.address ? ` — ${esc(p.address)}` : ""} · ${esc(fmtDay.format(new Date(p.startDate + "T12:00:00")))}</div>
            ${relevant.includes(p) ? `<div class="p-badge">Featured for this match</div>` : ""}
          </div>
        </a>`).join("");
      return `<div class="borough-block"><h5>${esc(b)} <span style="color:var(--text-dim);font-weight:400">(${byBorough[b].length})</span></h5>${cards}</div>`;
    }).join("");

    return `<div class="m-section"><h4>Watch Parties in NYC${usingFallback ? "" : ` — ${fmtDay.format(m.date)}`}</h4>
      <div class="wp-meta">${usingFallback ? "No parties found for match day yet — showing upcoming World Cup parties across the city. " : ""}${esc(scraped)}</div>
      ${blocks}</div>`;
  }

  async function renderModal(id) {
    const m = state.byId.get(String(id));
    if (!m) return;
    state.openMatchId = String(id);
    const body = $("#modal-body");
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";

    let html = modalHeaderHTML(m);
    if (m.state === "pre") {
      html += countdownHTML(m);
      body.innerHTML = html + `<div class="m-section"><div class="loading">Finding watch parties…</div></div>`;
      const wp = await fetchWatchParties();
      if (state.openMatchId !== String(id)) return;
      body.innerHTML = html + watchPartiesHTML(m, wp);
    } else {
      body.innerHTML = html + `<div class="m-section"><div class="loading">Loading match details…</div></div>`;
      try {
        const summary = await fetchSummary(id, m.state === "in");
        if (state.openMatchId !== String(id)) return;
        body.innerHTML = html + scorersHTML(m, summary) + videosHTML(summary) + xLinksHTML(m);
      } catch (err) {
        if (state.openMatchId !== String(id)) return;
        body.innerHTML = html + `<div class="m-section"><div class="wp-empty">Couldn't load match details (${esc(err.message)}). Try again shortly.</div></div>` + xLinksHTML(m);
      }
    }
  }

  function closeModal() {
    state.openMatchId = null;
    $("#modal").hidden = true;
    document.body.style.overflow = "";
    // stop any playing highlight videos
    document.querySelectorAll("#modal-body video").forEach((v) => v.pause());
  }

  // ---------- shell ----------

  function renderCurrentTab() {
    if (state.tab === "bracket") renderBracket();
    else renderGroups();
    const anyLive = state.matches.some((m) => m.state === "in");
    $("#live-badge").hidden = !anyLive;
    $("#last-updated").textContent = `Updated ${fmtTime.format(new Date())}`;
  }

  async function refresh(userTriggered) {
    const btn = $("#refresh-btn");
    if (userTriggered) btn.classList.add("spinning");
    try {
      await Promise.all([fetchScoreboard(), state.tab === "groups" || !state.standings ? fetchStandings() : Promise.resolve()]);
      $("#error-banner").hidden = true;
      // skip the DOM rebuild when no score/clock/status changed since last poll
      const fp = state.matches.map((m) => `${m.id}:${m.state}:${m.clock}:${m.home.score}-${m.away.score}`).join("|");
      if (fp !== state.fingerprint || userTriggered) {
        state.fingerprint = fp;
        renderCurrentTab();
      } else {
        $("#last-updated").textContent = `Updated ${fmtTime.format(new Date())}`;
      }
      // live modal follows along
      if (state.openMatchId) {
        const m = state.byId.get(state.openMatchId);
        if (m && m.state === "in") renderModal(state.openMatchId);
      }
    } catch (err) {
      const banner = $("#error-banner");
      banner.hidden = false;
      banner.textContent = `Couldn't refresh live data (${err.message}). Retrying automatically…`;
    } finally {
      btn.classList.remove("spinning");
    }
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".tab").forEach((b) => {
      const active = b.dataset.tab === tab;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    $("#view-bracket").hidden = tab !== "bracket";
    $("#view-groups").hidden = tab !== "groups";
    renderCurrentTab();
  }

  document.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (tab) return setTab(tab.dataset.tab);
    const card = e.target.closest("[data-match]");
    if (card) return void renderModal(card.dataset.match);
    if (e.target.id === "modal" || e.target.closest("#modal-close")) return closeModal();
    if (e.target.closest("#refresh-btn")) return void refresh(true);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });

  (async () => {
    await refresh(false);
    if (!state.standings) fetchStandings().then(renderCurrentTab).catch(() => {});
    fetchWatchParties();
    state.timer = setInterval(() => { if (!document.hidden) refresh(false); }, REFRESH_MS);
  })();
})();

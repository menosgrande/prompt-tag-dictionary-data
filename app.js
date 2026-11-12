(() => {
  "use strict";
  const DATA_FILES = [
    { url: "./dictionary-working.csv", source: "dictionary-working.csv", label: "一般" },
    { url: "./characters-working.csv", source: "characters-working.csv", label: "作品・人物" }
  ];
  const PAGE_SIZE = 300;
  const HEADERS = ["index","tag","ja","major","minor","detail","aliases_json","translation_status","ero_level","ero_review_status","classification_review_status","age_safety"];
  const FAVORITES_KEY = "ptd-favorites-v1";
  const state = {
    all: [], filtered: [], page: 0, major: "", minor: "", query: "",
    classification: "all", sort: "index", searchTarget: "all", favoritesOnly: false, favorites: new Set(), polarity: new Map(), worksQuery: "", authorsQuery: "",
    selected: new Map(), activeScreen: "dictionary-screen", works: [], authors: [], reviewRows: [], ambiguousRows: [], columnWidths: [48,42,220,190,150,150,150,180,90,100]
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const keyOf = row => [row.source, row.index, row.tag].join("::");
  const statusLabel = value => ({ verified:"確認済み", pending:"未確認", needs_review:"要確認", "needs-review":"要確認", provisional:"暫定", unverified:"未確認" })[value] || value || "—";

  function setMessage(message, error = false) {
    $(".tag-results").innerHTML = '<div class="empty-state' + (error ? ' load-error' : '') + '">' + escapeHTML(message) + '</div>';
  }
  async function loadCSV(file) {
    const response = await fetch(file.url, { cache: "no-store" });
    if (!response.ok) throw new Error(file.url + " の読み込みに失敗しました (HTTP " + response.status + ")");
    const rows = window.DictionaryCSV.parseCSV(await response.text());
    if (!rows.length) throw new Error(file.url + " にデータ行がありません。");
    const actual = Object.keys(rows[0]);
    if (actual.length !== HEADERS.length || HEADERS.some((header, i) => actual[i] !== header)) {
      throw new Error(file.url + " のCSVヘッダーが想定する12列と一致しません。");
    }
    return rows.map(row => ({ ...row, source: file.source, sourceLabel: file.label }));
  }
  const normalizeWorkName = value => String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[\s・:：!！?？"'’~〜\-‐‑–—_/／（）()\[\]「」『』.。、☆★]/g, "");
  function parseAliases(value) {
    try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }
  function addWorkAlias(map, value, group) {
    const normalized = normalizeWorkName(value);
    if (!normalized) return;
    if (!map.has(normalized)) map.set(normalized, new Set());
    map.get(normalized).add(group);
  }
  function referenceTokens(value) {
    return String(value || "").match(/[（(]([^（）()]+)[）)]/g)?.map(part => part.slice(1, -1).trim()) || [];
  }
  function findWorkCandidates(tokens, aliasMap) {
    const matches = new Map();
    tokens.forEach(token => {
      const parts = [token, ...token.split(/[／]/).map(part => part.trim())].filter(Boolean);
      parts.forEach(part => {
        (aliasMap.get(normalizeWorkName(part)) || []).forEach(group => matches.set(group.key, group));
      });
    });
    return [...matches.values()];
  }
  function buildRelatedIndexes() {
    const characterRows = state.all.filter(row => row.source === "characters-working.csv");
    const titleRows = characterRows.filter(row => row.minor === "タイトル（作品名）");
    const groupMap = new Map();
    const aliasMap = new Map();
    titleRows.forEach(row => {
      const label = row.ja.replace(/（(?:アニメ|ゲーム|漫画|小説|映画|メディアミックス|その他)?(?:タイトル|作品|シリーズ)）$/, "").trim() || row.ja;
      const key = normalizeWorkName(label);
      if (!key) return;
      let group = groupMap.get(key);
      if (!group) {
        group = { key, name: label, titles: [], characters: [], elements: [], queryText: "" };
        groupMap.set(key, group);
      }
      group.titles.push(row);
      [label, row.tag, ...parseAliases(row.aliases_json)].forEach(alias => {
        addWorkAlias(aliasMap, alias, group);
        const englishBase = String(alias).replace(/\s*\((?:series|game|anime|manga|novel|film)\)\s*$/i, "");
        if (englishBase !== alias) addWorkAlias(aliasMap, englishBase, group);
        const japaneseBase = String(alias).replace(/シリーズ$/, "");
        if (japaneseBase !== alias) addWorkAlias(aliasMap, japaneseBase, group);
      });
    });
    const reviewRows = [];
    const ambiguousRows = [];
    const creatorRows = characterRows.filter(row => row.minor === "作者・配信者" || /[（(](?:作者|漫画家|配信者)[）)]$/.test(row.ja));
    characterRows.filter(row => row.minor === "キャラクター" || row.minor === "作品固有の衣装・要素").forEach(row => {
      if (/[（(](?:作者|漫画家|配信者)[）)]$/.test(row.ja)) return;
      const jaCandidates = findWorkCandidates(referenceTokens(row.ja), aliasMap);
      const enCandidates = findWorkCandidates(referenceTokens(row.tag), aliasMap);
      const franchiseTokens = [];
      if (/pokemon/i.test(row.tag) || /ポケモン|ポケットモンスター/i.test(row.ja)) franchiseTokens.push("ポケモン");
      if (/final fantasy|ff(?:11|14)/i.test(row.tag) || /ファイナルファンタジー|FF(?:11|14)/i.test(row.ja)) franchiseTokens.push("ファイナルファンタジー");
      const franchiseCandidates = findWorkCandidates(franchiseTokens, aliasMap);
      const candidates = jaCandidates.length ? jaCandidates : enCandidates.length ? enCandidates : franchiseCandidates;
      if (candidates.length === 1) {
        const group = candidates[0];
        (row.minor === "キャラクター" ? group.characters : group.elements).push(row);
        row.workTitle = group.name;
      } else if (candidates.length > 1) {
        ambiguousRows.push({ row, candidates: candidates.map(group => group.name) });
      } else {
        reviewRows.push(row);
      }
    });
    state.works = [...groupMap.values()].map(group => {
      group.characters.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
      group.elements.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
      group.titles.sort((a,b) => Number(a.index)-Number(b.index));
      group.queryText = [group.name, ...group.titles.map(row => row.tag), ...group.characters.flatMap(row => [row.tag,row.ja]), ...group.elements.flatMap(row => [row.tag,row.ja])].join(" ").toLocaleLowerCase();
      return group;
    }).sort((a,b) => a.name.localeCompare(b.name, "ja"));
    state.authors = creatorRows.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
    state.reviewRows = reviewRows.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
    state.ambiguousRows = ambiguousRows.sort((a,b) => a.row.ja.localeCompare(b.row.ja, "ja"));
  }
  function relatedTagRow(row, groupName = "", typeLabel = "") {
    const key = keyOf(row);
    return '<div class="related-tag-row"><label><input type="checkbox" class="related-select" data-key="' + escapeHTML(key) + '"' + (state.selected.has(key) ? ' checked' : '') + '><span class="related-tag-copy"><strong>' + escapeHTML(row.ja || row.tag) + '</strong><small>' + escapeHTML(row.tag) + (groupName ? ' · ' + escapeHTML(groupName) : '') + '</small></span></label><span class="related-tag-type">' + escapeHTML(typeLabel || row.minor || "作品タイトル") + '</span></div>';
  }
  function specialSeriesName(group) {
    const tags = group.titles.map(row => String(row.tag || "").toLocaleLowerCase());
    if (tags.some(tag => tag === "pokemon" || tag.startsWith("pokemon "))) return "ポケットモンスター";
    if (tags.some(tag => tag === "final fantasy" || tag.startsWith("final fantasy ") || tag === "dissidia final fantasy")) return "ファイナルファンタジー";
    if (tags.some(tag => tag === "fire emblem" || tag.startsWith("fire emblem ") || tag.startsWith("fire emblem:"))) return "ファイアーエムブレム";
    return "";
  }
  function genericSeriesGroups() {
    const manualRoots = new Set(["overwatch", "kemonofriends", "streetfighter", "idolmaster", "leagueoflegends", "touhou"]);
    const entries = state.works.map(group => {
      const tags = group.titles.map(row => String(row.tag || ""));
      const normalizedTags = tags.map(normalizeWorkName).filter(Boolean);
      const rootTag = tags.find(tag => /\\(series\\)\\s*$/i.test(tag) || manualRoots.has(normalizeWorkName(tag)));
      const normalized = rootTag ? normalizeWorkName(rootTag) : "";
      const isRoot = Boolean(rootTag);
      return { group, tags, normalizedTags, normalized, isRoot };
    });
    const roots = entries.filter(entry => entry.isRoot && entry.normalized);
    const rootFor = new Map();
    const rootAncestor = root => {
      const parent = roots.filter(candidate => candidate.group !== root.group &&
        root.normalized.startsWith(candidate.normalized) &&
        root.normalized.length > candidate.normalized.length)
        .sort((a,b) => b.normalized.length - a.normalized.length)[0];
      return parent ? rootAncestor(parent) : root;
    };
    entries.forEach(entry => {
      const forcedRootKey = entry.tags.some(tag => /^arcane:\\s*league of legends$/i.test(tag)) ? "leagueoflegends" :
        entry.tags.some(tag => /^gakuen idolmaster$/i.test(tag)) ? "idolmaster" :
        entry.tags.some(tag => /\\((?:touhou|touhou project)\\)/i.test(tag)) ? "touhou" : "";
      const forcedRoot = forcedRootKey ? roots.find(root => root.normalized === forcedRootKey && root.group !== entry.group) : null;
      const candidate = forcedRoot || roots.filter(root => root.group !== entry.group &&
        entry.normalizedTags.some(tag => tag.startsWith(root.normalized) && tag.length > root.normalized.length))
        .sort((a,b) => b.normalized.length - a.normalized.length)[0];
      if (candidate) rootFor.set(entry.group.key, rootAncestor(candidate).group);
      else if (entry.isRoot) rootFor.set(entry.group.key, rootAncestor(entry).group);
    });
    const grouped = new Map();
    rootFor.forEach((root, key) => {
      if (!grouped.has(root.key)) grouped.set(root.key, { root, members: [] });
      const member = state.works.find(group => group.key === key);
      if (member && !grouped.get(root.key).members.includes(member)) grouped.get(root.key).members.push(member);
    });
    return new Map([...grouped].filter(([,value]) => value.members.length > 1));
  }
  function renderWorkList() {
    const query = state.worksQuery.toLocaleLowerCase();
    const genericGroups = genericSeriesGroups();
    const genericRootByMember = new Map();
    genericGroups.forEach(({root,members}) => members.forEach(member => genericRootByMember.set(member.key, root)));
    const parentQueryMatches = new Set();
    genericGroups.forEach(({root,members}) => {
      if (query && root.queryText.includes(query)) members.forEach(member => parentQueryMatches.add(member.key));
    });
    const groups = state.works.filter(group =>
      !query || group.queryText.includes(query) || parentQueryMatches.has(group.key) ||
      (genericRootByMember.get(group.key)?.name || "").toLocaleLowerCase().includes(query) ||
      specialSeriesName(group).toLocaleLowerCase().includes(query)
    );
    const totalMembers = groups.reduce((sum,group) => sum + group.titles.length + group.characters.length + group.elements.length, 0);
    $("#works-count").textContent = groups.length.toLocaleString("ja-JP") + "作品 · " + totalMembers.toLocaleString("ja-JP") + "タグ";

    const renderGroupBody = group => [
      group.titles.length ? '<div class="related-subsection"><h3>作品タイトル</h3>' + group.titles.map(row => relatedTagRow(row, group.name)).join("") + '</div>' : "",
      group.characters.length ? '<div class="related-subsection"><h3>キャラクター <span>' + group.characters.length + '</span></h3>' + group.characters.map(row => relatedTagRow(row, group.name)).join("") + '</div>' : "",
      group.elements.length ? '<div class="related-subsection"><h3>作品固有の衣装・要素 <span>' + group.elements.length + '</span></h3>' + group.elements.map(row => relatedTagRow(row, group.name)).join("") + '</div>' : ""
    ].join("");
    const renderGroupCard = (group, nested = false) => {
      const count = group.characters.length + group.elements.length;
      return '<details class="work-card' + (nested ? ' series-child' : '') + '"><summary><span class="work-card-title">' + escapeHTML(group.name) + '</span><span class="work-card-meta">' + count + '件 · タイトル ' + group.titles.length + '件</span></summary><div class="work-card-body">' + renderGroupBody(group) + '</div></details>';
    };

    const specialGroups = new Map();
    const genericMembers = new Map();
    const standaloneGroups = [];
    groups.forEach(group => {
      const specialName = specialSeriesName(group);
      if (specialName) {
        if (!specialGroups.has(specialName)) specialGroups.set(specialName, []);
        specialGroups.get(specialName).push(group);
        return;
      }
      const genericRoot = genericRootByMember.get(group.key);
      if (genericRoot) {
        if (!genericMembers.has(genericRoot.key)) genericMembers.set(genericRoot.key, { root: genericRoot, members: [] });
        genericMembers.get(genericRoot.key).members.push(group);
        return;
      }
      standaloneGroups.push(group);
    });
    const specialCards = [...specialGroups.entries()].sort((a,b) => a[0].localeCompare(b[0], "ja")).map(([name,members]) => {
      const tagCount = members.reduce((sum,group) => sum + group.titles.length + group.characters.length + group.elements.length, 0);
      return '<details class="work-card series-parent"><summary><span class="work-card-title">' + escapeHTML(name) + '</span><span class="work-card-meta">' + members.length + '作品 · ' + tagCount + 'タグ</span></summary><div class="work-card-body series-body">' + members.map(group => renderGroupCard(group, true)).join("") + '</div></details>';
    }).join("");
    const genericCards = [...genericMembers.values()].sort((a,b) => a.root.name.localeCompare(b.root.name, "ja")).map(({root,members}) => {
      const children = members.filter(group => group.key !== root.key);
      const tagCount = members.reduce((sum,group) => sum + group.titles.length + group.characters.length + group.elements.length, 0);
      return '<details class="work-card series-parent"><summary><span class="work-card-title">' + escapeHTML(root.name) + '</span><span class="work-card-meta">' + members.length + '作品 · ' + tagCount + 'タグ</span></summary><div class="work-card-body series-body">' + renderGroupBody(root) + children.map(group => renderGroupCard(group, true)).join("") + '</div></details>';
    }).join("");
    const cards = specialCards + genericCards + standaloneGroups.map(group => renderGroupCard(group)).join("");

    const ambiguous = !query && state.ambiguousRows.length ? '<details class="work-card review-card"><summary><span class="work-card-title">複数候補・要確認</span><span class="work-card-meta">' + state.ambiguousRows.length + '件</span></summary><div class="work-card-body"><p class="related-note">複数の作品タイトルに一致したため、自動では割り当てていません。</p>' + state.ambiguousRows.map(item => relatedTagRow(item.row, "候補: " + item.candidates.join(" / "))).join("") + '</div></details>' : "";
    const review = !query ? '<details class="work-card review-card"><summary><span class="work-card-title">未紐付け</span><span class="work-card-meta">' + state.reviewRows.length + '件</span></summary><div class="work-card-body"><p class="related-note">既存の作品タイトルと明確に照合できないタグです。作品名を推測して割り当てていません。</p>' + state.reviewRows.map(row => relatedTagRow(row)).join("") + '</div></details>' : "";
    $("#works-list").innerHTML = cards + ambiguous + review || '<p class="empty-state">検索条件に一致する作品はありません。</p>';
  }
  function renderAuthorList() {
    const query = state.authorsQuery.toLocaleLowerCase();
    const rows = state.authors.filter(row => [row.ja,row.tag,row.aliases_json].join(" ").toLocaleLowerCase().includes(query));
    $("#authors-count").textContent = rows.length.toLocaleString("ja-JP") + "件";
    $("#authors-list").innerHTML = rows.length ? rows.map(row => relatedTagRow(row, "作者・配信者", "作者・配信者")).join("") : '<p class="empty-state">検索条件に一致する作者・配信者はいません。</p>';
  }
  function categoryCounts(rows, key) {
    const counts = new Map();
    rows.forEach(row => { if (row[key]) counts.set(row[key], (counts.get(row[key]) || 0) + 1); });
    return [...counts.entries()].sort((a,b) => a[0].localeCompare(b[0], "ja"));
  }
  function renderCategories() {
    const root = $(".category-tree");
    const majors = categoryCounts(state.all, "major");
    root.innerHTML = '<button class="category-major-button' + (!state.major ? ' active' : '') + '" data-major="">すべての分類 <span class="count">' + state.all.length.toLocaleString("ja-JP") + '</span></button>' +
      majors.map(([major,count]) => {
        const minors = categoryCounts(state.all.filter(row => row.major === major), "minor");
        return '<div class="category-major"><button class="category-major-button' + (state.major === major && !state.minor ? ' active' : '') + '" data-major="' + escapeHTML(major) + '">' + escapeHTML(major) + '<span class="count">' + count.toLocaleString("ja-JP") + '</span></button>' +
          (state.major === major ? '<div class="category-minors">' + minors.map(([minor,n]) => '<button class="category-minor' + (state.minor === minor ? ' active' : '') + '" data-major="' + escapeHTML(major) + '" data-minor="' + escapeHTML(minor) + '">' + escapeHTML(minor) + '<span class="count">' + n.toLocaleString("ja-JP") + '</span></button>').join("") + '</div>' : '') + '</div>';
      }).join("");
  }
  function matches(row) {
    if (state.major && row.major !== state.major) return false;
    if (state.minor && row.minor !== state.minor) return false;
    if (state.classification === "classified" && !row.major && !row.minor) return false;
    if (state.classification === "unclassified" && (row.major || row.minor)) return false;
    if (state.favoritesOnly && !state.favorites.has(keyOf(row))) return false;
    if (state.query) {
      const terms = state.query.toLocaleLowerCase().split(/\\s+/).filter(Boolean);
      const fields = state.searchTarget === "tag" ? [row.tag] : state.searchTarget === "ja" ? [row.ja] : state.searchTarget === "alias" ? [row.aliases_json] : [row.tag,row.ja,row.aliases_json,row.major,row.minor,row.detail,row.workTitle];
      const haystack = fields.join(" ").toLocaleLowerCase();
      if (!terms.every(term => haystack.includes(term))) return false;
    }
    return true;
  }
  const COLUMN_WIDTHS_KEY = "ptd-dictionary-column-widths-v4";
  const COLUMN_MIN_WIDTHS = [42, 34, 100, 100, 90, 90, 90, 100, 70, 90];
  const COLUMN_MAX_WIDTH = 520;
  function applyColumnWidths() {
    $(".table-scroll-shell").style.setProperty("--tag-list-columns", state.columnWidths.map(width => width + "px").join(" "));
  }
  function autoFitColumns(persist = true) {
    const headers = $(".table-head-cell");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const fields = [
      row => "",
      row => "",
      row => row.tag,
      row => row.ja,
      row => row.major,
      row => row.minor,
      row => row.detail,
      row => parseAliases(row.aliases_json).join("、"),
      row => row.ero_level,
      row => row.age_safety
    ];
    const fonts = ["10px 'DM Sans', 'Noto Sans JP', sans-serif","9px 'DM Mono', monospace","10px 'DM Sans', sans-serif","9px 'Noto Sans JP', sans-serif","8px 'Noto Sans JP', sans-serif","8px 'Noto Sans JP', sans-serif","8px 'Noto Sans JP', sans-serif","8px 'Noto Sans JP', sans-serif","8px 'DM Sans', sans-serif","8px 'DM Sans', sans-serif"];
    const widths = headers.map((header, index) => {
      if (index === 0) return 54;
      context.font = fonts[index];
      let widest = context.measureText(header.textContent.replace(/\\s+/g, " ").trim()).width;
      for (const row of state.all) {
        const value = String(fields[index](row) ?? "—") || "—";
        widest = Math.max(widest, context.measureText(value).width);
      }
      return Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTH, Math.ceil(widest + 20)));
    });
    state.columnWidths = widths;
    applyColumnWidths();
    $$(".column-resize").forEach((handle, index) => handle.setAttribute("aria-valuenow", String(widths[index])));
    if (persist) {
      try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {}
    }
  }
  function setupColumnResizers() {
    const headers = $$(".table-head-cell");
    headers.forEach((cell, index) => {
      const handle = document.createElement("span");
      handle.className = "column-resize";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", headers[index].textContent.trim() + "列の幅を変更");
      handle.setAttribute("aria-valuemin", String(COLUMN_MIN_WIDTHS[index]));
      handle.setAttribute("aria-valuemax", String(COLUMN_MAX_WIDTH));
      handle.setAttribute("aria-valuenow", String(state.columnWidths[index]));
      cell.append(handle);
      const resizeTo = width => {
        state.columnWidths[index] = Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTH, Math.round(width)));
        handle.setAttribute("aria-valuenow", String(state.columnWidths[index]));
        applyColumnWidths();
        try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(state.columnWidths)); } catch {}
      };
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = state.columnWidths[index];
        handle.setPointerCapture(event.pointerId);
        const move = e => resizeTo(startWidth + e.clientX - startX);
        const finish = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", finish);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", finish);
      });
      handle.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        resizeTo(state.columnWidths[index] + (event.key === "ArrowRight" ? 10 : -10));
      });
    });
    let hasSavedWidths = false;
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || "null");
      if (Array.isArray(saved) && saved.length === headers.length && saved.every(Number.isFinite)) {
        state.columnWidths = saved.map((width, index) => Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTH, Math.round(width))));
        hasSavedWidths = true;
      }
    } catch {}
    if (hasSavedWidths) applyColumnWidths();
    else autoFitColumns(false);
  }
  function renderRows() {
    const rows = state.filtered;
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const pageRows = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    $(".tag-results").innerHTML = pageRows.length ? pageRows.map(row => {
      const key = keyOf(row);
      let aliases = parseAliases(row.aliases_json).join("、");
      const polarity = state.polarity.get(key) || "none";
      const polarityLabel = polarity === "positive" ? "＋" : polarity === "negative" ? "−" : "";
      return '<div class="tag-row" role="row" data-source="' + escapeHTML(row.source) + '">' +
        '<span class="tag-select-cell"><button type="button" class="polarity-button polarity-' + polarity + '" data-polarity="' + escapeHTML(key) + '" aria-label="追加先：' + (polarity === "none" ? "未選択" : polarity === "positive" ? "ポジティブ" : "ネガティブ") + '" title="クリックで ポジティブ → ネガティブ → 未選択">' + polarityLabel + '</button></span>' +
        '<span class="favorite-cell"><button type="button" class="favorite-button' + (state.favorites.has(key) ? ' is-favorite' : '') + '" data-favorite="' + escapeHTML(key) + '" aria-label="お気に入り切替" title="お気に入り">★</button></span>' +
        '<span class="tag-english" title="' + escapeHTML(row.tag) + '">' + escapeHTML(row.tag) + '</span>' +
        '<span class="tag-japanese" title="' + escapeHTML(row.ja) + '">' + escapeHTML(row.ja) + '</span>' +
        '<span class="tag-category" title="' + escapeHTML(row.major) + '">' + escapeHTML(row.major || "—") + '</span>' +
        '<span class="tag-category" title="' + escapeHTML(row.minor) + '">' + escapeHTML(row.minor || "—") + '</span>' +
        '<span class="tag-category" title="' + escapeHTML(row.detail) + '">' + escapeHTML(row.detail || "—") + '</span>' +
        '<span class="tag-category alias-cell" title="' + escapeHTML(row.aliases_json) + '">' + escapeHTML(aliases || "—") + '</span>' +
        '<span class="tag-category" title="' + escapeHTML(row.ero_level) + '">' + escapeHTML(row.ero_level || "—") + '</span>' +
        '<span class="tag-category" title="' + escapeHTML(row.age_safety) + '">' + escapeHTML(row.age_safety || "—") + '</span>' +
      '</div>';
    }).join("") : '<div class="empty-state">条件に一致するタグはありません。</div>';
    const start = Math.max(1, state.page - 2), end = Math.min(pages, Math.max(5, state.page + 3));
    let nums = "";
    for (let p = start; p <= end; p++) nums += '<button type="button" class="page-number' + (p - 1 === state.page ? ' active' : '') + '" data-page="' + (p - 1) + '" aria-current="' + (p - 1 === state.page ? 'page' : 'false') + '">' + p + '</button>';
    $(".count").textContent = rows.length.toLocaleString("ja-JP") + " 件";
    $(".pagination").innerHTML = '<button class="page-number page-arrow" type="button" data-page="prev"' + (state.page === 0 ? ' disabled' : '') + '>前へ</button>' + (start > 1 ? '<span class="page-ellipsis">…</span>' : '') + nums + (end < pages ? '<span class="page-ellipsis">…</span><button class="page-number" type="button" data-page="' + (pages - 1) + '">' + pages + '</button>' : '') + '<button class="page-number page-arrow" type="button" data-page="next"' + (state.page >= pages - 1 ? ' disabled' : '') + '>次へ</button><span class="page-total">' + rows.length.toLocaleString("ja-JP") + '件</span>';
  }
  function applyFilters() {
    state.filtered = state.all.filter(matches);
    if (state.sort === "tag") state.filtered.sort((a,b) => a.tag.localeCompare(b.tag));
    else if (state.sort === "ja") state.filtered.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
    else state.filtered.sort((a,b) => Number(a.index) - Number(b.index));
    state.page = 0;
    renderRows();
  }
  function promptTags() {
    const rows = [...state.selected.values()];
    if ($(".builder-controls input")?.checked) rows.sort((a,b) => (a.major || "").localeCompare(b.major || "", "ja") || Number(a.index) - Number(b.index));
    return rows;
  }
  function renderEditor() {
    const rows = promptTags();
    const positiveRows = rows.filter(row => (state.polarity.get(keyOf(row)) || "positive") === "positive");
    const negativeRows = rows.filter(row => state.polarity.get(keyOf(row)) === "negative");
    const positive = $("#positive-output"), negative = $("#negative-output");
    if (positive && document.activeElement !== positive) positive.value = positiveRows.map(row => row.tag).join(", ");
    if (negative && document.activeElement !== negative && negativeRows.length) negative.value = negativeRows.map(row => row.tag).join(", ");
    const count = state.selected.size;
    $$(".stats strong")[1].textContent = String(count);
    const countLabel = $(".selected-dock-count");
    if (countLabel) countLabel.textContent = count + " 件選択中";
    const chips = $(".selected-dock-tags");
    if (chips) chips.innerHTML = rows.slice(0, 8).map(row => '<span class="selected-dock-chip"><span title="' + escapeHTML(row.tag) + '">' + escapeHTML(row.tag) + '</span><button class="selected-dock-remove" type="button" data-remove="' + escapeHTML(keyOf(row)) + '" aria-label="削除">×</button></span>').join("") + (count > 8 ? '<span class="selected-dock-more">+' + (count - 8) + '件</span>' : '');
    const dock = $(".selected-dock"); if (dock) dock.hidden = count === 0;
    $('[data-action="copy-positive"]').disabled = !positive?.value;
    $('[data-action="save-positive"]').disabled = !positive?.value;
    $('[data-action="copy-negative"]').disabled = !negative?.value;
    $('[data-action="save-negative"]').disabled = !negative?.value;
  }
  function setScreen(id) {
    state.activeScreen = id;
    $$(".app-screen").forEach(screen => screen.hidden = screen.id !== id);
    $$(".screen-tab").forEach(tab => {
      const active = tab.getAttribute("href") === "#" + id;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    });
    if (id === "works-screen") renderWorkList();
    if (id === "authors-screen") renderAuthorList();
    if (id === "editor-screen") renderEditor();
  }
  function addRow(row) {
    const key = keyOf(row);
    state.selected.set(key, row);
    const checkbox = $('.tag-select[data-key="' + CSS.escape(key) + '"]');
    if (checkbox) checkbox.checked = true;
    renderEditor();
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    URL.revokeObjectURL(url);
  }
  async function copyText(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.createElement("textarea"); area.value = text; document.body.append(area); area.select(); document.execCommand("copy"); area.remove(); }
  }
  function bindControls() {
    $(".column-fit-button").addEventListener("click", () => autoFitColumns(true));
    $("#works-search").addEventListener("input", event => { state.worksQuery = event.target.value.trim().toLocaleLowerCase(); renderWorkList(); });
    $("#authors-search").addEventListener("input", event => { state.authorsQuery = event.target.value.trim().toLocaleLowerCase(); renderAuthorList(); });
    $$(".related-list").forEach(root => root.addEventListener("change", event => {
      const input = event.target.closest(".related-select");
      if (!input) return;
      const row = state.all.find(item => keyOf(item) === input.dataset.key);
      if (!row) return;
      if (input.checked) { state.selected.set(input.dataset.key, row); state.polarity.set(input.dataset.key, "positive"); } else { state.selected.delete(input.dataset.key); state.polarity.delete(input.dataset.key); }
      renderEditor();
    }));
    const search = $(".search-row .searchbox input");
    search.addEventListener("input", () => { state.query = search.value.trim(); applyFilters(); });
    $("#search-target").addEventListener("change", event => { state.searchTarget = event.target.value; applyFilters(); });
    $("#favorites-only").addEventListener("change", event => { state.favoritesOnly = event.target.checked; applyFilters(); });
    try { state.favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); } catch { state.favorites = new Set(); }
    const classificationSelect = $("#classification-filter");
    const sortSelect = $("#sort-filter");
    classificationSelect.addEventListener("change", () => { state.classification = classificationSelect.selectedIndex === 1 ? "classified" : classificationSelect.selectedIndex === 2 ? "unclassified" : "all"; applyFilters(); });
    sortSelect.addEventListener("change", () => { state.sort = sortSelect.selectedIndex === 1 ? "tag" : sortSelect.selectedIndex === 2 ? "ja" : "index"; applyFilters(); });
    $(".category-tree").addEventListener("click", event => {
      const button = event.target.closest("[data-major]");
      if (!button) return;
      state.major = button.dataset.major || ""; state.minor = button.dataset.minor || "";
      renderCategories(); applyFilters();
    });
    $(".categories-panel .text-button").addEventListener("click", () => { state.major = ""; state.minor = ""; renderCategories(); applyFilters(); });
    $(".search-row > .button").addEventListener("click", () => {
      search.value = ""; state.query = ""; state.major = ""; state.minor = ""; state.classification = "all"; state.sort = "index"; state.searchTarget = "all"; state.favoritesOnly = false; $("#search-target").value = "all"; $("#favorites-only").checked = false;
      classificationSelect.selectedIndex = 0; sortSelect.selectedIndex = 0; renderCategories(); applyFilters();
    });
    $(".pagination").addEventListener("click", event => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      if (button.dataset.page === "prev") state.page--;
      else if (button.dataset.page === "next") state.page++;
      else state.page = Number(button.dataset.page);
      renderRows();
    });
    $(".tag-results").addEventListener("click", event => {
      const polarityButton = event.target.closest("[data-polarity]");
      const favoriteButton = event.target.closest("[data-favorite]");
      if (!polarityButton && !favoriteButton) return;
      const key = (polarityButton || favoriteButton).dataset.polarity || (polarityButton || favoriteButton).dataset.favorite;
      const row = state.all.find(item => keyOf(item) === key);
      if (favoriteButton) {
        if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
        try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); } catch {}
        if (state.favoritesOnly) applyFilters(); else renderRows();
        return;
      }
      const current = state.polarity.get(key) || "none";
      const next = current === "none" ? "positive" : current === "positive" ? "negative" : "none";
      if (next === "none") { state.polarity.delete(key); state.selected.delete(key); }
      else { state.polarity.set(key, next); state.selected.set(key, row); }
      renderRows(); renderEditor();
    });
    $(".screen-nav").addEventListener("click", event => {
      const tab = event.target.closest(".screen-tab");
      if (!tab) return;
      event.preventDefault(); setScreen(tab.hash.slice(1));
    });
    $(".selected-dock").addEventListener("click", event => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      state.selected.delete(button.dataset.remove); state.polarity.delete(button.dataset.remove); renderRows(); renderEditor();
    });
    $(".selected-dock-actions [data-action='open-editor']").addEventListener("click", () => setScreen("editor-screen"));
    $(".editor-builder-panel .text-button").addEventListener("click", () => {
      state.selected.clear(); state.polarity.clear(); renderRows(); renderEditor();
    });
    const addInput = $(".preview-add-row input");
    const addButton = $(".preview-add-row button");
    function updateAddButton() {
      const q = addInput.value.trim().toLocaleLowerCase();
      const match = q ? state.all.find(row => row.tag.toLocaleLowerCase() === q || row.ja.toLocaleLowerCase() === q) : null;
      addButton.disabled = !match; addButton.dataset.key = match ? keyOf(match) : "";
    }
    addInput.addEventListener("input", updateAddButton);
    addButton.addEventListener("click", () => {
      const row = state.all.find(item => keyOf(item) === addButton.dataset.key);
      if (row) { state.polarity.set(keyOf(row), "positive"); addRow(row); addInput.value = ""; updateAddButton(); }
    });
    $(".builder-controls input").addEventListener("change", renderEditor);
    $("#positive-output").addEventListener("input", renderEditor);
    $("#negative-output").addEventListener("input", () => {
      $('[data-action="copy-negative"]').disabled = !$("#negative-output").value;
      $('[data-action="save-negative"]').disabled = !$("#negative-output").value;
    });
    $$("[data-action]").forEach(button => button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const target = action.includes("negative") ? $("#negative-output") : $("#positive-output");
      if (action.startsWith("copy")) await copyText(target.value);
      if (action.startsWith("save")) downloadText(action.includes("negative") ? "negative-prompt.txt" : "positive-prompt.txt", target.value);
    }));
  }
  function createDock() {
    const dock = document.createElement("aside");
    dock.className = "selected-dock"; dock.hidden = true;
    dock.innerHTML = '<div class="selected-dock-content"><strong class="selected-dock-count">0 件選択中</strong><div class="selected-dock-tags"></div></div><div class="selected-dock-actions"><button class="button button-primary" type="button" data-action="open-editor">プロンプト編集へ</button><button class="button button-quiet" type="button" data-action="clear-selection">全解除</button></div>';
    document.body.append(dock);
    dock.querySelector('[data-action="clear-selection"]').addEventListener("click", () => { state.selected.clear(); renderRows(); renderEditor(); });
  }
  async function init() {
    setScreen("dictionary-screen");
    setMessage("CSVデータを読み込んでいます…");
    createDock();
    try {
      const loaded = await Promise.all(DATA_FILES.map(loadCSV));
      state.all = loaded.flat();
      buildRelatedIndexes();
      state.all.forEach(row => {
        const match = state.reviewRows.find(item => keyOf(item) === keyOf(row));
        if (match) return;
        const group = state.works.find(item => item.characters.some(x => keyOf(x) === keyOf(row)) || item.elements.some(x => keyOf(x) === keyOf(row)));
        if (group) row.workTitle = group.name;
      });
      $(".stats strong").textContent = state.all.length.toLocaleString("ja-JP");
      renderCategories(); setupColumnResizers(); bindControls(); applyFilters(); renderEditor();
    } catch (error) {
      console.error(error);
      setMessage("CSVの読み込みに失敗しました。GitHub Pages上で開いているか、CSVファイルの配置と12列ヘッダーを確認してください。詳細: " + error.message, true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
(() => {
  "use strict";
  const DATA_FILES = [
    { url: "./dictionary-working.csv", source: "dictionary-working.csv", label: "一般" },
    { url: "./characters-working.csv", source: "characters-working.csv", label: "作品・人物" }
  ];
  const PAGE_SIZE = 300;
  const HEADERS = ["index","tag","ja","major","minor","detail","aliases_json","translation_status","ero_level","ero_review_status","classification_review_status","age_safety"];
  const MAJOR_CATEGORY_ORDER = [
    "品質・ネガティブ", "人数・人物構成", "人物の特徴", "顔・表情", "髪・頭部",
    "キャラクター・作品", "服装・装飾", "ポーズ・姿勢", "動作・接触", "状態・状況",
    "背景・場所", "生物・動植物", "家具・設備・物品", "乗り物",
    "構図・カメラ", "光・演出", "画風・描写", "文字・記号"
  ];
  const MAJOR_CATEGORY_RANK = new Map(MAJOR_CATEGORY_ORDER.map((name, index) => [name, index]));
  const compareMajorCategories = (a, b) =>
    (MAJOR_CATEGORY_RANK.get(a) ?? Number.MAX_SAFE_INTEGER) - (MAJOR_CATEGORY_RANK.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b, "ja");
  const FAVORITES_KEY = "ptd-favorites-v1";
  const EXPRESSION_LEVELS_KEY = "ptd-expression-levels-v1";
  const CSV_CACHE_DB = "ptd-csv-cache-v1";
  const CSV_CACHE_TTL = 5 * 60 * 1000;

  function openCSVCache() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("IndexedDB is unavailable"));
      const request = indexedDB.open(CSV_CACHE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("files")) {
          request.result.createObjectStore("files", { keyPath: "url" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function readCSVCache(url) {
    let db;
    try {
      db = await openCSVCache();
      return await new Promise((resolve, reject) => {
        const request = db.transaction("files", "readonly").objectStore("files").get(url);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } finally { db?.close(); }
  }
  async function writeCSVCache(url, rows) {
    let db;
    try {
      db = await openCSVCache();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("files", "readwrite");
        transaction.objectStore("files").put({ url, savedAt: Date.now(), rows });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally { db?.close(); }
  }
  const state = {
    all: [], filtered: [], page: 0, major: "", minor: "", query: "",
    classification: "all", sort: "index", searchTarget: "all", favoritesOnly: false, favorites: new Set(), polarity: new Map(), worksQuery: "", authorsQuery: "",
    selected: new Map(), expressionLevels: new Map(), activeScreen: "dictionary-screen", works: [], authors: [], reviewRows: [], ambiguousRows: [], columnWidths: [48,42,220,190,150,150,150,180,90,100]
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const keyOf = row => [row.source, row.index, row.tag].join("::");
  function baseExpressionLevel(row) {
    const value = String(row.ero_level ?? "").trim();
    return /^[0-4]$/.test(value) ? Number(value) : null;
  }
  function expressionLevelFor(row) {
    const key = keyOf(row);
    return state.expressionLevels.has(key) ? state.expressionLevels.get(key) : baseExpressionLevel(row);
  }
  function saveExpressionLevels() {
    try { localStorage.setItem(EXPRESSION_LEVELS_KEY, JSON.stringify([...state.expressionLevels.entries()])); } catch {}
  }
  const statusLabel = value => ({ verified:"確認済み", pending:"未確認", needs_review:"要確認", "needs-review":"要確認", provisional:"暫定", unverified:"未確認" })[value] || value || "—";

  function setMessage(message, error = false) {
    $(".tag-results").innerHTML = '<div class="empty-state' + (error ? ' load-error' : '') + '">' + escapeHTML(message) + '</div>';
  }
  async function loadCSV(file) {
    let cached = null;
    try { cached = await readCSVCache(file.url); } catch {}
    if (cached?.rows?.length && Date.now() - cached.savedAt < CSV_CACHE_TTL) {
      return cached.rows;
    }
    try {
      const response = await fetch(file.url, { cache: "no-store" });
      if (!response.ok) throw new Error(file.url + " の読み込みに失敗しました (HTTP " + response.status + ")");
      const rows = window.DictionaryCSV.parseCSV(await response.text());
      if (!rows.length) throw new Error(file.url + " にデータ行がありません。");
      const actual = Object.keys(rows[0]);
      if (actual.length !== HEADERS.length || HEADERS.some((header, i) => actual[i] !== header)) {
        throw new Error(file.url + " のCSVヘッダーが想定する12列と一致しません。");
      }
      const prepared = rows.map(row => ({ ...row, source: file.source, sourceLabel: file.label }));
      try { await writeCSVCache(file.url, prepared); } catch {}
      return prepared;
    } catch (error) {
      if (cached?.rows?.length) return cached.rows;
      throw error;
    }
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
    const text = [group.name, ...tags, ...group.titles.map(row => row.ja)].join(" ").toLocaleLowerCase();
    if (tags.some(tag => tag === "pokemon" || tag.startsWith("pokemon "))) return "ポケットモンスター";
    if (tags.some(tag => tag === "final fantasy" || tag.startsWith("final fantasy ") || tag === "dissidia final fantasy")) return "ファイナルファンタジー";
    if (tags.some(tag => tag === "fire emblem" || tag.startsWith("fire emblem ") || tag.startsWith("fire emblem:"))) return "ファイアーエムブレム";
    if (tags.some(tag => tag === "dragon quest" || tag.startsWith("dragon quest "))) return "ドラゴンクエスト";
    if (tags.some(tag => tag.startsWith("toaru ") || /とある/.test(text))) return "とあるシリーズ";
    if (tags.some(tag => tag === "sword art online" || tag.startsWith("sword art online:") || /\\bsao\\b/i.test(tag))) return "ソードアート・オンライン";
    if (tags.some(tag => tag === "the legend of zelda" || tag.startsWith("the legend of zelda:") || /ゼルダの伝説/.test(text))) return "ゼルダの伝説";
    if (tags.some(tag => tag.startsWith("tales of "))) return "テイルズ オブ シリーズ";
    if (/jojo|ジョジョ/.test(text)) return "ジョジョの奇妙な冒険";
    return "";
  }
  function genericSeriesGroups() {
    const manualRoots = new Set(["overwatch", "kemonofriends", "streetfighter", "idolmaster", "leagueoflegends", "touhou", "disney", "vocaloid", "yu-gi-oh!", "gundam", "neon genesis evangelion", "love live!", "persona", "dragon ball", "monster hunter (series)"]);
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
        (entry.tags.some(tag => /\\((?:touhou|touhou project)\\)/i.test(tag)) || /東方|touhou/i.test(entry.group.name)) ? "touhou" :
        (entry.tags.some(tag => /\\((?:vocaloid)\\)/i.test(tag) || /^(?:project diva(?: \\(series\\))?|project sekai)$/i.test(tag)) || /初音ミク|ボーカロイド/i.test(entry.group.name)) ? "vocaloid" :
        entry.tags.some(tag => /gundam/i.test(tag)) ? "gundam" :
        entry.tags.some(tag => /^(?:monster hunter(?:\\s|$))/i.test(tag) && !/^monster hunter \\(series\\)$/i.test(tag)) ? "monsterhunterseries" :
        entry.tags.some(tag => /^(?:evangelion:|rebuild of evangelion$)/i.test(tag)) ? "neon genesis evangelion" :
        entry.tags.some(tag => /^(?:marvel(?: cinematic universe)?|star wars|kingdom hearts|frozen(?: \\(disney\\))?)$/i.test(tag)) ? "disney" : "";
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
    return [...counts.entries()].sort((a,b) => key === "major" ? compareMajorCategories(a[0], b[0]) : a[0].localeCompare(b[0], "ja"));
  }
  function renderCategories() {
    const root = $(".category-tree");
    const majors = categoryCounts(state.all, "major");
    const favoriteCount = state.all.filter(row => state.favorites.has(keyOf(row))).length;
    root.innerHTML = '<button class="category-major-button' + (state.favoritesOnly ? ' active' : '') + '" data-favorites="true">お気に入り <span class="count">' + favoriteCount.toLocaleString("ja-JP") + '</span></button>' +
      '<button class="category-major-button' + (!state.major && !state.minor && !state.favoritesOnly ? ' active' : '') + '" data-major="">すべての分類 <span class="count">' + state.all.length.toLocaleString("ja-JP") + '</span></button>' +
      majors.map(([major,count]) => {
        const minors = categoryCounts(state.all.filter(row => row.major === major), "minor");
        return '<div class="category-major' + (state.major === major ? ' is-expanded' : '') + '><button class="category-major-button' + (state.major === major && !state.minor && !state.favoritesOnly ? ' active' : '') + '" data-major="' + escapeHTML(major) + '">' + escapeHTML(major) + '<span class="count">' + count.toLocaleString("ja-JP") + '</span></button>' +
          '<div class="category-minors">' + minors.map(([minor,n]) => '<button class="category-minor' + (state.minor === minor ? ' active' : '') + '" data-major="' + escapeHTML(major) + '" data-minor="' + escapeHTML(minor) + '">' + escapeHTML(minor) + '<span class="count">' + n.toLocaleString("ja-JP") + '</span></button>').join("") + '</div></div>';
      }).join("");
  }
  function matches(row) {
    if (state.major && row.major !== state.major) return false;
    if (state.minor && row.minor !== state.minor) return false;
    if (state.favoritesOnly && !state.favorites.has(keyOf(row))) return false;
    if (state.query) {
      const terms = state.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const fields = [row.tag,row.ja,row.aliases_json,row.major,row.minor,row.detail,row.workTitle];
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
    const headers = $$(".table-head-cell");
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
      const selected = state.selected.has(key);
      const polarity = selected ? (state.polarity.get(key) || "positive") : "none";
      const stateClass = polarity === "positive" ? "state-positive" : polarity === "negative" ? "state-negative" : "state-none";
      const stateIcon = polarity === "positive" ? "✓" : polarity === "negative" ? "×" : "";
      const stateLabel = polarity === "positive" ? "ポジティブ" : polarity === "negative" ? "ネガティブ" : "未指定";
      return '<div class="tag-row' + (selected ? ' is-selected' : '') + '" role="row" data-key="' + escapeHTML(key) + '">' +
        '<span class="tag-state-cell"><button type="button" class="tag-state-button ' + stateClass + '" data-row-state="' + escapeHTML(key) + '" aria-label="' + stateLabel + '（クリックで状態変更）" title="' + stateLabel + '：クリックで次の状態へ">' + stateIcon + '</button></span>' +
        '<span class="favorite-cell"><button type="button" class="favorite-button' + (state.favorites.has(key) ? ' is-favorite' : '') + '" data-favorite="' + escapeHTML(key) + '" aria-label="お気に入り切替" title="お気に入り">★</button></span>' +
        '<button type="button" class="tag-english tag-add-link" data-add="' + escapeHTML(key) + '" title="' + escapeHTML(row.tag) + '">' + escapeHTML(row.tag) + '</button>' +
        '<button type="button" class="tag-japanese tag-add-link" data-add="' + escapeHTML(key) + '" title="' + escapeHTML(row.ja) + '">' + escapeHTML(row.ja) + '</button>' +
        '<span class="tag-major" title="大分類">' + escapeHTML(row.major || "未分類") + '</span>' +
        '<span class="expression-level-cell" role="group" aria-label="表現レベル">' + [0,1,2,3,4].map(level => '<button type="button" class="expression-level-button' + (expressionLevelFor(row) === level ? ' is-active' : '') + '" data-expression-level="' + escapeHTML(key) + '" data-level="' + level + '" aria-pressed="' + (expressionLevelFor(row) === level ? 'true' : 'false') + '" title="表現レベル ' + level + '">' + level + '</button>').join("") + '</span>' +
        '<span class="tag-detail-cell"><button type="button" class="tag-detail-button" data-detail="' + escapeHTML(key) + '" aria-label="' + escapeHTML(row.tag) + ' の詳細" title="タグの詳細情報">ⓘ</button></span>' +
      '</div>';
    }).join("") : '<div class="empty-state">条件に一致するタグはありません。</div>';
    const start = Math.max(1, state.page - 2), end = Math.min(pages, Math.max(5, state.page + 3));
    let nums = "";
    for (let p = start; p <= end; p++) nums += '<button type="button" class="page-number' + (p - 1 === state.page ? ' active' : '') + '" data-page="' + (p - 1) + '" aria-current="' + (p - 1 === state.page ? 'page' : 'false') + '">' + p + '</button>';
    $(".result-heading .count").textContent = rows.length.toLocaleString("ja-JP") + " 件";
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
    if ($(".builder-controls input")?.checked) rows.sort((a,b) => compareMajorCategories(a.major || "", b.major || "") || Number(a.index) - Number(b.index));
    return rows;
  }
  function renderSelectedTagList() {
    const root = $("#selected-tag-list");
    if (!root) return;
    const rows = promptTags();
    if (!rows.length) {
      root.innerHTML = '<p class="empty-state">まだタグが選択されていません。</p>';
      return;
    }
    const ordered = $(".builder-controls input")?.checked;
    root.innerHTML = rows.map((row,index) => {
      const key = keyOf(row), polarity = state.polarity.get(key) || "positive";
      const stateLabel = polarity === "negative" ? "ネガティブ" : "ポジティブ";
      return '<div class="selected-tag-item" data-key="' + escapeHTML(key) + '">' +
        '<div class="selected-tag-copy"><strong>' + escapeHTML(row.ja || row.tag) + '</strong><small>' + escapeHTML(row.tag) + '</small><small class="selected-tag-state">' + stateLabel + '</small></div>' +
        '<div class="selected-tag-actions"><button type="button" data-move="-1" data-key="' + escapeHTML(key) + '" aria-label="上へ移動"' + (ordered || index === 0 ? ' disabled' : '') + '>↑</button><button type="button" data-move="1" data-key="' + escapeHTML(key) + '" aria-label="下へ移動"' + (ordered || index === rows.length - 1 ? ' disabled' : '') + '>↓</button><button type="button" data-remove-selected="' + escapeHTML(key) + '" aria-label="削除">×</button></div></div>';
    }).join("");
    root.classList.toggle("is-sorted", Boolean(ordered));
  }
  function renderEditor() {
    const rows = promptTags();
    const positiveRows = rows.filter(row => (state.polarity.get(keyOf(row)) || "positive") === "positive");
    const negativeRows = rows.filter(row => state.polarity.get(keyOf(row)) === "negative");
    const positive = $("#positive-output"), negative = $("#negative-output");
    if (positive && document.activeElement !== positive) positive.value = positiveRows.map(row => row.tag).join(", ");
    if (negative && document.activeElement !== negative) negative.value = negativeRows.map(row => row.tag).join(", ");
    renderSelectedTagList();
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
  function addRow(row) {
    const key = keyOf(row);
    state.selected.set(key, row);
    state.polarity.set(key, state.polarity.get(key) || "positive");
    renderRows();
    renderEditor();
  }
  function toggleRow(row) {
    const key = keyOf(row);
    if (state.selected.has(key)) {
      state.selected.delete(key);
      state.polarity.delete(key);
    } else {
      state.selected.set(key, row);
      state.polarity.set(key, "positive");
    }
    renderRows();
    renderEditor();
  }
  function cycleRowState(row) {
    const key = keyOf(row);
    if (!state.selected.has(key)) {
      state.selected.set(key, row);
      state.polarity.set(key, "positive");
    } else if (state.polarity.get(key) === "positive") {
      state.polarity.set(key, "negative");
    } else {
      state.selected.delete(key);
      state.polarity.delete(key);
    }
    renderRows();
    renderEditor();
  }
  function showTagDetail(row) {
    const dialog = $("#tag-detail-dialog");
    if (!dialog || !row) return;
    const aliases = parseAliases(row.aliases_json);
    const related = state.all.filter(item => item !== row && row.major && item.major === row.major && (row.minor ? item.minor === row.minor : true)).slice(0,8);
    const fields = [["大分類",row.major],["中分類",row.minor],["小分類",row.detail],["別名",aliases.join("、")],["説明",row.description || ""],["表現レベル", expressionLevelFor(row) === null ? "未判定" : String(expressionLevelFor(row))],["年齢判定",row.age_safety],["翻訳状態",statusLabel(row.translation_status)],["分類確認",statusLabel(row.classification_review_status)]].filter(([,value]) => value);
    $(".tag-detail-content").innerHTML =
      '<div class="tag-detail-main"><strong>' + escapeHTML(row.tag) + '</strong><span>' + escapeHTML(row.ja) + '</span></div>' +
      '<dl class="tag-detail-fields">' + fields.map(([label,value]) => '<div><dt>' + escapeHTML(label) + '</dt><dd>' + escapeHTML(value) + '</dd></div>').join("") + '</dl>' +
      (related.length ? '<section class="detail-related"><h3>同じ分類のタグ</h3><div>' + related.map(item => '<button type="button" data-add="' + escapeHTML(keyOf(item)) + '">' + escapeHTML(item.ja || item.tag) + '<small>' + escapeHTML(item.tag) + '</small></button>').join("") + '</div></section>' : '');
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open","");
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

    $("#favorites-only").addEventListener("change", event => { state.favoritesOnly = event.target.checked; state.major = ""; state.minor = ""; renderCategories(); applyFilters(); });
    try { state.favorites = new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]")); } catch { state.favorites = new Set(); }
    try {
      const savedLevels = JSON.parse(localStorage.getItem(EXPRESSION_LEVELS_KEY) || "[]");
      if (Array.isArray(savedLevels)) savedLevels.forEach(([key, value]) => { if (typeof key === "string" && (value === null || [0,1,2,3,4].includes(value))) state.expressionLevels.set(key, value); });
    } catch { state.expressionLevels = new Map(); }
    const categoryToggle = $(".category-mobile-toggle");
    const setCategoryPanelOpen = open => {
      categoryToggle.setAttribute("aria-expanded", String(open));
      categoryToggle.querySelector("span").textContent = state.major ? state.major + " · " + (open ? "閉じる" : "開く") : (open ? "閉じる" : "タップして開閉");
    };
    categoryToggle.addEventListener("click", () => {
      setCategoryPanelOpen(categoryToggle.getAttribute("aria-expanded") !== "true");
    });
    $(".category-tree").addEventListener("click", event => {
      const favoriteCategory = event.target.closest("[data-favorites]");
      if (favoriteCategory) {
        state.favoritesOnly = !state.favoritesOnly;
        state.major = ""; state.minor = "";
        $("#favorites-only").checked = state.favoritesOnly;
        renderCategories(); applyFilters(); setCategoryPanelOpen(false);
        return;
      }
      const button = event.target.closest("[data-major]");
      if (!button) return;
      const isMinor = button.hasAttribute("data-minor");
      state.major = button.dataset.major || ""; state.minor = isMinor ? (button.dataset.minor || "") : "";
      state.favoritesOnly = false; $("#favorites-only").checked = false;
      renderCategories(); applyFilters();
      if (isMinor) setCategoryPanelOpen(false); else setCategoryPanelOpen(true);
    });
    $(".categories-panel .text-button").addEventListener("click", () => { state.major = ""; state.minor = ""; renderCategories(); applyFilters(); setCategoryPanelOpen(false); });
    $(".search-row > .button").addEventListener("click", () => {
      search.value = ""; state.query = ""; state.major = ""; state.minor = ""; state.favoritesOnly = false; $("#favorites-only").checked = false;
      renderCategories(); applyFilters();
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
      const favorite = event.target.closest("[data-favorite]");
      if (favorite) {
        const key = favorite.dataset.favorite;
        if (state.favorites.has(key)) state.favorites.delete(key); else state.favorites.add(key);
        try { localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites])); } catch {}
        renderCategories();
        if (state.favoritesOnly) applyFilters(); else renderRows();
        return;
      }
      const levelButton = event.target.closest("[data-expression-level]");
      if (levelButton) {
        const key = levelButton.dataset.expressionLevel;
        const level = Number(levelButton.dataset.level);
        const row = state.all.find(item => keyOf(item) === key);
        if (row) {
          state.expressionLevels.set(key, expressionLevelFor(row) === level ? null : level);
          saveExpressionLevels();
          renderRows();
        }
        return;
      }
      const detail = event.target.closest("[data-detail]");
      if (detail) {
        const row = state.all.find(item => keyOf(item) === detail.dataset.detail);
        if (row) showTagDetail(row);
        return;
      }
      const stateButton = event.target.closest("[data-row-state]");
      if (stateButton) {
        const row = state.all.find(item => keyOf(item) === stateButton.dataset.rowState);
        if (row) cycleRowState(row);
        return;
      }
      const add = event.target.closest("[data-add]");
      if (add) {
        const row = state.all.find(item => keyOf(item) === add.dataset.add);
        if (row) toggleRow(row);
      }
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
    $("#selected-tag-list").addEventListener("click", event => {
      const remove = event.target.closest("[data-remove-selected]");
      if (remove) {
        state.selected.delete(remove.dataset.removeSelected); state.polarity.delete(remove.dataset.removeSelected);
        renderRows(); renderEditor(); return;
      }
      const move = event.target.closest("[data-move]");
      if (!move || move.disabled || $(".builder-controls input").checked) return;
      const entries = [...state.selected.entries()];
      const index = entries.findIndex(([key]) => key === move.dataset.key);
      const target = index + Number(move.dataset.move);
      if (index < 0 || target < 0 || target >= entries.length) return;
      [entries[index],entries[target]] = [entries[target],entries[index]];
      state.selected = new Map(entries); renderEditor();
    });
    $("#tag-detail-dialog").addEventListener("click", event => {
      if (event.target === $("#tag-detail-dialog") || event.target.closest(".detail-close")) {
        $("#tag-detail-dialog").close(); return;
      }
      const add = event.target.closest("[data-add]");
      if (add) {
        const row = state.all.find(item => keyOf(item) === add.dataset.add);
        if (row) addRow(row);
      }
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
    dock.querySelector('[data-action="clear-selection"]').addEventListener("click", () => { state.selected.clear(); state.polarity.clear(); renderRows(); renderEditor(); });
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
      renderCategories(); bindControls(); applyFilters(); renderEditor();
    } catch (error) {
      console.error(error);
      setMessage("CSVの読み込みに失敗しました。GitHub Pages上で開いているか、CSVファイルの配置と12列ヘッダーを確認してください。詳細: " + error.message, true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
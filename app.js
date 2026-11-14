(() => {
  "use strict";
  const DATA_FILES = [
    { url: "./dictionary-working.csv", source: "dictionary-working.csv", label: "一般" },
    { url: "./characters-working.csv", source: "characters-working.csv", label: "作品・人物" }
  ];
  const PAGE_SIZE = 150;
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
  const USER_DATA_KEY = "ptd-user-data-v2";
  const LEGACY_FAVORITES_KEY = "ptd-favorites-v1";
  const LEGACY_EXPRESSION_LEVELS_KEY = "ptd-expression-levels-v1";
  const LEGACY_BUILDER_STATE_KEY = "ptd-builder-state-v1";
  const CSV_CACHE_DB = "ptd-csv-cache-v2";

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
    all: [], filtered: [], page: 0, major: "", minor: "", query: "", queryTerms: [],
    classification: "all", sort: "index", searchTarget: "all", favoritesOnly: false, favorites: new Set(), polarity: new Map(), worksQuery: "", authorsQuery: "",
    selected: new Map(), expressionLevels: new Map(), promptPositive: "", promptNegative: "", promptItemsPositive: [], promptItemsNegative: [], promptMode: null, activeBubble: null, selectionRestored: false, columnFilters: { major: new Set(), level: new Set(), translation: new Set(), classification: new Set() }, sortDirection: "asc", activeScreen: "dictionary-screen", works: [], authors: [], reviewRows: [], ambiguousRows: [], relatedIndexesReady: false, hiddenMajorCategories: new Set(), columnWidths: [30, 26, 210, 170, 130, 34, 26], columnWidthMode: "desktop"
  };
  let skipLocationWrite = false;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  // 統合データセット内で一意なCSVのtag値を識別子として使う。source/index/ファイル名には依存しない。
  const keyOf = row => String(row.tag ?? "");
  function baseExpressionLevel(row) {
    const value = String(row.ero_level ?? "").trim();
    return /^[0-4]$/.test(value) ? Number(value) : null;
  }
  function expressionLevelFor(row) {
    const key = keyOf(row);
    return state.expressionLevels.has(key) ? state.expressionLevels.get(key) : baseExpressionLevel(row);
  }
  function readUserDataV2() {
    const raw = localStorage.getItem(USER_DATA_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== 2 || typeof data !== "object") throw new Error("ユーザー保存データの形式が不正です。");
    return data;
  }
  function writeUserDataV2(patch) {
    try {
      const current = readUserDataV2() || { schemaVersion: 2, favorites: [], expressionLevels: [], builderState: null, migration: null };
      localStorage.setItem(USER_DATA_KEY, JSON.stringify({ ...current, ...patch, schemaVersion: 2 }));
    } catch (error) { console.warn("ユーザー設定を保存できませんでした。", error); }
  }
  function saveExpressionLevels() {
    writeUserDataV2({ expressionLevels: [...state.expressionLevels.entries()] });
  }
  function legacyTagFromKey(key) {
    if (typeof key !== "string") return null;
    const first = key.indexOf("::");
    const second = first < 0 ? -1 : key.indexOf("::", first + 2);
    return second < 0 ? null : key.slice(second + 2);
  }
  function migrateLegacyUserData() {
    const current = readUserDataV2();
    if (current) return current;

    const rowsByTag = new Map();
    const duplicateTags = new Set();
    state.all.forEach(row => {
      const tag = String(row.tag ?? "");
      if (rowsByTag.has(tag)) duplicateTags.add(tag);
      else rowsByTag.set(tag, row);
    });
    duplicateTags.forEach(tag => rowsByTag.delete(tag));

    const unresolved = [];
    const mapLegacyKey = (key, kind) => {
      const tag = legacyTagFromKey(key);
      if (tag !== null && rowsByTag.has(tag)) return tag;
      unresolved.push({ kind, legacyKey: String(key ?? ""), tag: tag ?? "" });
      return null;
    };
    const readLegacy = (key, fallback, kind) => {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        unresolved.push({ kind, legacyKey: key, tag: "", reason: "旧データをJSONとして読み取れません" });
        return fallback;
      }
    };

    const oldFavorites = readLegacy(LEGACY_FAVORITES_KEY, [], "favorite");
    const favorites = [];
    if (Array.isArray(oldFavorites)) oldFavorites.forEach(key => {
      const mapped = mapLegacyKey(key, "favorite");
      if (mapped !== null && !favorites.includes(mapped)) favorites.push(mapped);
    });
    else unresolved.push({ kind: "favorite", legacyKey: LEGACY_FAVORITES_KEY, tag: "", reason: "旧データの形式が配列ではありません" });

    const oldLevels = readLegacy(LEGACY_EXPRESSION_LEVELS_KEY, [], "expressionLevel");
    const expressionLevels = [];
    if (Array.isArray(oldLevels)) oldLevels.forEach(entry => {
      if (!Array.isArray(entry) || entry.length < 2 || !(entry[1] === null || [0,1,2,3,4].includes(entry[1]))) {
        unresolved.push({ kind: "expressionLevel", legacyKey: String(entry?.[0] ?? ""), tag: "", reason: "旧データの項目形式が不正です" });
        return;
      }
      const mapped = mapLegacyKey(entry[0], "expressionLevel");
      if (mapped !== null) expressionLevels.push([mapped, entry[1]]);
    });
    else unresolved.push({ kind: "expressionLevel", legacyKey: LEGACY_EXPRESSION_LEVELS_KEY, tag: "", reason: "旧データの形式が配列ではありません" });

    const oldBuilder = readLegacy(LEGACY_BUILDER_STATE_KEY, null, "builder");
    let builderState = null;
    if (oldBuilder && typeof oldBuilder === "object" && !Array.isArray(oldBuilder)) {
      const selected = [];
      if (Array.isArray(oldBuilder.selected)) oldBuilder.selected.forEach(key => {
        const mapped = mapLegacyKey(key, "selected");
        if (mapped !== null && !selected.includes(mapped)) selected.push(mapped);
      });
      const selectedSet = new Set(selected);
      const polarity = [];
      if (Array.isArray(oldBuilder.polarity)) oldBuilder.polarity.forEach(entry => {
        if (!Array.isArray(entry) || entry.length < 2 || !["positive", "negative"].includes(entry[1])) {
          unresolved.push({ kind: "polarity", legacyKey: String(entry?.[0] ?? ""), tag: "", reason: "旧データの項目形式が不正です" });
          return;
        }
        const mapped = mapLegacyKey(entry[0], "polarity");
        if (mapped !== null) {
          if (selectedSet.has(mapped)) polarity.push([mapped, entry[1]]);
          else unresolved.push({ kind: "polarity", legacyKey: String(entry[0]), tag: mapped, reason: "対応する選択タグがありません" });
        }
      });
      builderState = {
        selected, polarity,
        positiveExtra: typeof oldBuilder.positiveExtra === "string" ? oldBuilder.positiveExtra : "",
        negativeExtra: typeof oldBuilder.negativeExtra === "string" ? oldBuilder.negativeExtra : "",
        escapeParentheses: oldBuilder.escapeParentheses === true,
        applyWeight: oldBuilder.applyWeight === true,
        weightValue: Number.isFinite(Number(oldBuilder.weightValue)) ? Math.max(0.1, Math.min(2, Number(oldBuilder.weightValue))) : 1.2
      };
    } else if (oldBuilder !== null) {
      unresolved.push({ kind: "builder", legacyKey: LEGACY_BUILDER_STATE_KEY, tag: "", reason: "旧データの形式がオブジェクトではありません" });
    }

    const migrated = {
      schemaVersion: 2, favorites, expressionLevels, builderState,
      migration: { completedAt: new Date().toISOString(), unresolved }
    };
    // 1つのlocalStorageキーへ一括保存する。旧キーは復旧確認まで残す。
    localStorage.setItem(USER_DATA_KEY, JSON.stringify(migrated));
    return migrated;
  }
  function renderMigrationReport(data) {
    const panel = $("#migration-unresolved-panel");
    if (!panel) return;
    const items = Array.isArray(data?.migration?.unresolved) ? data.migration.unresolved : [];
    panel.hidden = items.length === 0;
    const summary = $("#migration-unresolved-summary");
    const list = $("#migration-unresolved-list");
    if (summary) summary.textContent = "移行できなかった設定：" + items.length + "件（確認が必要）";
    const kindLabels = { favorite: "お気に入り", expressionLevel: "表現レベル", selected: "選択タグ", polarity: "出力区分", builder: "ビルダー設定" };
    if (list) list.innerHTML = items.map(item =>
      "<li><strong>" + escapeHTML(kindLabels[item.kind] || item.kind || "不明") + "</strong> · " + escapeHTML(item.tag || item.legacyKey || "識別情報なし") + (item.reason ? " — " + escapeHTML(item.reason) : "") + "</li>"
    ).join("");
  }
  const statusLabel = value => ({ verified:"確認済み", pending:"未確認", needs_review:"要確認", "needs-review":"要確認", provisional:"暫定", unverified:"未確認" })[value] || value || "—";

  function setMessage(message, error = false) {
    $(".tag-results").innerHTML = '<div class="empty-state' + (error ? ' load-error' : '') + '">' + escapeHTML(message) + '</div>';
  }
  async function fetchCSV(file, cachedRows = null) {
    const response = await fetch(file.url, { cache: "no-cache" });
    if (!response.ok) throw new Error(file.url + " の読み込みに失敗しました (HTTP " + response.status + ")");
    const rows = window.DictionaryCSV.parseCSV(await response.text());
    if (!rows.length) throw new Error(file.url + " にデータ行がありません。");
    const actual = Object.keys(rows[0]);
    if (actual.length !== HEADERS.length || HEADERS.some((header, i) => actual[i] !== header)) {
      throw new Error(file.url + " のCSVヘッダーが想定する12列と一致しません。");
    }
    const prepared = rows.map(row => ({ ...row, source: file.source, sourceLabel: file.label }));
    const unchanged = cachedRows && prepared.length === cachedRows.length && prepared.every((row, index) =>
      row.source === cachedRows[index].source &&
      row.sourceLabel === cachedRows[index].sourceLabel &&
      HEADERS.every(header => row[header] === cachedRows[index][header])
    );
    if (unchanged) return null;
    try { await writeCSVCache(file.url, prepared); } catch {}
    return prepared;
  }
  async function loadCSV(file) {
    let cached = null;
    try { cached = await readCSVCache(file.url); } catch {}
    if (cached?.rows?.length) {
      // キャッシュを先に返す。バックグラウンド取得では変更があった場合だけ新しい行を返す。
      return { rows: cached.rows, refresh: fetchCSV(file, cached.rows).catch(error => {
        console.warn(file.url + " のバックグラウンド更新に失敗しました。キャッシュを継続使用します。", error);
        return null;
      }) };
    }
    // 初回だけはCSV取得完了後に表示する。
    return { rows: await fetchCSV(file), refresh: Promise.resolve(null) };
  }
  const normalizeWorkName = value => String(value || "").normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase().replace(/[\s・:：!！?？"'’~〜\-‐‑–—_/／（）()\[\]「」『』.。、☆★]/g, "");
  function parseAliases(value) {
    try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }
  // 全角・半角、英字大小、アクセント、句読点や区切り文字の違いを吸収する検索用正規化。
  function normalizeSearchText(value) {
    return String(value ?? "").normalize("NFKC").normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u30a1-\u30f6]/g, char => String.fromCharCode(char.charCodeAt(0) - 0x60))
      .toLocaleLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  }
  function prepareSearchIndex() {
    state.all.forEach(row => {
      const promptFields = [row.tag, row.ja, ...parseAliases(row.aliases_json)];
      row._promptSearchFields = promptFields.map(normalizeSearchText);
      row._searchText = normalizeSearchText([
        ...promptFields, row.major, row.minor, row.detail
      ].join(" "));
    });
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
  function ensureRelatedIndexes() {
    if (state.relatedIndexesReady) return;
    buildRelatedIndexes();
    state.relatedIndexesReady = true;
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
    if (tags.some(tag => tag === "sword art online" || tag.startsWith("sword art online:") || /\bsao\b/i.test(tag))) return "ソードアート・オンライン";
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
      const rootTag = tags.find(tag => /\(series\)\s*$/i.test(tag) || manualRoots.has(normalizeWorkName(tag)));
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
      const forcedRootKey = entry.tags.some(tag => /^arcane:\s*league of legends$/i.test(tag)) ? "leagueoflegends" :
        entry.tags.some(tag => /^gakuen idolmaster$/i.test(tag)) ? "idolmaster" :
        (entry.tags.some(tag => /\((?:touhou|touhou project)\)/i.test(tag)) || /東方|touhou/i.test(entry.group.name)) ? "touhou" :
        (entry.tags.some(tag => /\((?:vocaloid)\)/i.test(tag) || /^(?:project diva(?: \(series\))?|project sekai)$/i.test(tag)) || /初音ミク|ボーカロイド/i.test(entry.group.name)) ? "vocaloid" :
        entry.tags.some(tag => /gundam/i.test(tag)) ? "gundam" :
        entry.tags.some(tag => /^(?:monster hunter(?:\s|$))/i.test(tag) && !/^monster hunter \(series\)$/i.test(tag)) ? "monsterhunterseries" :
        entry.tags.some(tag => /^(?:evangelion:|rebuild of evangelion$)/i.test(tag)) ? "neon genesis evangelion" :
        entry.tags.some(tag => /^(?:marvel(?: cinematic universe)?|star wars|kingdom hearts|frozen(?: \(disney\))?)$/i.test(tag)) ? "disney" : "";
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
  function renderCategories() {
    const root = $(".category-tree");
    const majorCounts = new Map();
    let favoriteCount = 0;
    state.all.forEach(row => {
      if (state.favorites.has(keyOf(row))) favoriteCount++;
      if (!row.major) return;
      let entry = majorCounts.get(row.major);
      if (!entry) { entry = { count: 0, minors: new Map() }; majorCounts.set(row.major, entry); }
      entry.count++;
      if (row.minor) entry.minors.set(row.minor, (entry.minors.get(row.minor) || 0) + 1);
    });
    const majors = [...majorCounts.entries()].sort((a,b) => compareMajorCategories(a[0], b[0]));
    const visibleMajors = majors.filter(([major]) => !state.hiddenMajorCategories.has(major));
    const hiddenMajors = majors.filter(([major]) => state.hiddenMajorCategories.has(major));
    const renderMajor = ([major,entry]) => {
      const minors = [...entry.minors.entries()].sort((a,b) => a[0].localeCompare(b[0], "ja"));
      return '<div class="category-major"><div class="category-major-row"><button class="category-major-button' + (state.major === major && !state.minor && !state.favoritesOnly ? ' active' : '') + '" data-major="' + escapeHTML(major) + '">' + escapeHTML(major) + '<span class="count">' + entry.count.toLocaleString("ja-JP") + '</span></button><label class="category-visibility" title="この分類の表示・非表示"><input type="checkbox" data-category-visible="' + escapeHTML(major) + '" checked aria-label="' + escapeHTML(major) + 'を表示">表示</label></div>' +
        '<div class="category-minors">' + minors.map(([minor,n]) => '<button class="category-minor' + (state.minor === minor ? ' active' : '') + '" data-major="' + escapeHTML(major) + '" data-minor="' + escapeHTML(minor) + '">' + escapeHTML(minor) + '<span class="count">' + n.toLocaleString("ja-JP") + '</span></button>').join("") + '</div></div>';
    };
    root.innerHTML = '<button class="category-major-button' + (state.favoritesOnly ? ' active' : '') + '" data-favorites="true">お気に入り <span class="count">' + favoriteCount.toLocaleString("ja-JP") + '</span></button>' +
      '<button class="category-major-button' + (!state.major && !state.minor && !state.favoritesOnly ? ' active' : '') + '" data-major="">すべての分類 <span class="count">' + state.all.length.toLocaleString("ja-JP") + '</span></button>' +
      visibleMajors.map(renderMajor).join("") +
      (hiddenMajors.length ? '<details class="category-hidden-list"><summary>非表示の分類 <span class="count">' + hiddenMajors.length + '件</span></summary><div>' + hiddenMajors.map(([major]) => '<label class="category-visibility"><input type="checkbox" data-category-visible="' + escapeHTML(major) + '" aria-label="' + escapeHTML(major) + 'を表示">' + escapeHTML(major) + '</label>').join("") + '<button type="button" class="category-show-all" data-show-all-categories>すべて表示</button></div></details>' : '');
  }
  function matches(row) {
    if (state.major && row.major !== state.major) return false;
    if (state.minor && row.minor !== state.minor) return false;
    if (state.favoritesOnly && !state.favorites.has(keyOf(row))) return false;
    const filters = state.columnFilters;
    if (filters.major.size && !filters.major.has(row.major || "未分類")) return false;
    const level = expressionLevelFor(row);
    if (filters.level.size && !filters.level.has(level === null ? "未設定" : String(level))) return false;
    if (filters.translation.size && !filters.translation.has(row.translation_status || "未設定")) return false;
    if (filters.classification.size && !filters.classification.has(row.classification_review_status || "未設定")) return false;
    if (state.queryTerms.length && !state.queryTerms.every(term => (row._searchText || "").includes(term))) return false;
    return true;
  }
  const COLUMN_WIDTH_KEYS = {
    desktop: "ptd-dictionary-column-widths-v6-desktop",
    mobile: "ptd-dictionary-column-widths-v6-mobile"
  };
  const COLUMN_DEFAULTS = {
    desktop: [30, 26, 210, 170, 130, 34, 26],
    mobile: [24, 22, 160, 140, 110, 32, 22]
  };
  const COLUMN_MIN_WIDTHS = [24, 22, 90, 90, 72, 30, 22];
  const COLUMN_MAX_WIDTHS = [64, 56, 520, 520, 360, 56, 56];
  function currentColumnMode() {
    return window.matchMedia("(max-width: 760px)").matches ? "mobile" : "desktop";
  }
  function applyColumnWidths() {
    const scroller = $(".table-horizontal-scroll");
    if (!scroller) return;
    scroller.style.setProperty("--tag-list-columns", state.columnWidths.map(width => width + "px").join(" "));
  }
  function saveColumnWidths() {
    try { localStorage.setItem(COLUMN_WIDTH_KEYS[state.columnWidthMode], JSON.stringify(state.columnWidths)); } catch {}
  }
  function loadColumnWidths(mode = currentColumnMode()) {
    state.columnWidthMode = mode;
    const defaults = COLUMN_DEFAULTS[mode];
    let widths = defaults;
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTH_KEYS[mode]) || "null");
      if (Array.isArray(saved) && saved.length === defaults.length && saved.every(Number.isFinite)) {
        widths = saved.map((width, index) => Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTHS[index], Math.round(width))));
      }
    } catch {}
    state.columnWidths = [...widths];
    applyColumnWidths();
    $$(".column-resize").forEach((handle, index) => handle.setAttribute("aria-valuenow", String(state.columnWidths[index])));
  }
  function setupColumnResizers() {
    const headers = $$(".table-head-cell");
    headers.forEach((cell, index) => {
      const handle = document.createElement("span");
      handle.className = "column-resize";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", (cell.textContent.trim() || ["状態","お気に入り","タグ（英語）","日本語訳","大分類","表現レベル","詳細"][index]) + "列の幅を変更");
      handle.setAttribute("aria-valuemin", String(COLUMN_MIN_WIDTHS[index]));
      handle.setAttribute("aria-valuemax", String(COLUMN_MAX_WIDTHS[index]));
      cell.append(handle);
      const resizeTo = width => {
        state.columnWidths[index] = Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTHS[index], Math.round(width)));
        handle.setAttribute("aria-valuenow", String(state.columnWidths[index]));
        applyColumnWidths();
        saveColumnWidths();
      };
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = state.columnWidths[index];
        const move = e => resizeTo(startWidth + e.clientX - startX);
        const finish = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      });
      handle.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        resizeTo(state.columnWidths[index] + (event.key === "ArrowRight" ? 10 : -10));
      });
    });
    loadColumnWidths();
    window.matchMedia("(max-width: 760px)").addEventListener("change", () => loadColumnWidths());
    $(".column-width-reset")?.addEventListener("click", () => {
      state.columnWidths = [...COLUMN_DEFAULTS[state.columnWidthMode]];
      applyColumnWidths();
      saveColumnWidths();
      $$(".column-resize").forEach((handle, index) => handle.setAttribute("aria-valuenow", String(state.columnWidths[index])));
    });
  }
  function renderTableTools() {
    const cells = {
      favorites: $('.table-head-cell[data-column="favorites"] [data-menu-content]'),
      tag: $('.table-head-cell[data-column="tag"] [data-menu-content]'),
      ja: $('.table-head-cell[data-column="ja"] [data-menu-content]'),
      major: $('.table-head-cell[data-column="major"] [data-menu-content]'),
      level: $('.table-head-cell[data-column="level"] [data-menu-content]')
    };
    const checkboxGroup = (key, values, labelMap = value => value) =>
      '<fieldset class="column-filter-group"><legend>' + (key === "major" ? "大分類で絞り込む" : "表現レベルで絞り込む") + '</legend>' +
      '<div class="column-filter-options">' + values.map(value =>
        '<label><input type="checkbox" data-filter-group="' + key + '" value="' + escapeHTML(value) + '"' +
        (state.columnFilters[key].has(value) ? ' checked' : '') + '> ' + escapeHTML(labelMap(value)) + '</label>'
      ).join("") + '</div><button type="button" class="column-filter-clear" data-filter-clear="' + key + '">この列の絞り込みを解除</button></fieldset>';
    const sortOptions = field => {
      const labels = { tag: ["A → Z", "Z → A"], ja: ["あ → ん", "ん → あ"], major: ["分類順（昇順）", "分類順（降順）"], level: ["低い順（0 → 4）", "高い順（4 → 0）"] };
      return '<div class="column-sort-options"><strong>並び替え</strong>' +
        labels[field].map((label, index) => '<button type="button" data-sort-field="' + field + '" data-sort-direction="' + (index === 0 ? 'asc' : 'desc') + '"' +
          (state.sort === field && state.sortDirection === (index === 0 ? "asc" : "desc") ? ' aria-pressed="true"' : '') + '>' + label + '</button>').join("") +
        '</div>';
    };
    if (cells.favorites) cells.favorites.innerHTML =
      '<label class="column-favorite-filter"><input type="checkbox" data-filter-favorites' + (state.favoritesOnly ? ' checked' : '') + '> お気に入りのみ</label>';
    if (cells.tag) cells.tag.innerHTML = sortOptions("tag");
    if (cells.ja) cells.ja.innerHTML = sortOptions("ja");
    if (cells.major) {
      const majors = [...new Set(state.all.map(row => row.major || "未分類"))].sort(compareMajorCategories);
      cells.major.innerHTML = sortOptions("major") + checkboxGroup("major", majors);
    }
    if (cells.level) cells.level.innerHTML =
      sortOptions("level") + checkboxGroup("level", ["0","1","2","3","4","未設定"], value => value === "未設定" ? "未設定" : "レベル " + value);
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
        '<span class="expression-level-cell"><span class="expression-level-value' + (expressionLevelFor(row) === null ? ' is-unset' : ' level-' + expressionLevelFor(row)) + '" aria-label="表現ランク ' + (expressionLevelFor(row) === null ? '未設定' : expressionLevelFor(row)) + '" title="表現ランク ' + (expressionLevelFor(row) === null ? '未設定' : expressionLevelFor(row)) + '">' + (expressionLevelFor(row) === null ? '—' : expressionLevelFor(row)) + '</span></span>' +
        '<span class="tag-detail-cell"><button type="button" class="tag-detail-button" data-detail="' + escapeHTML(key) + '" aria-label="' + escapeHTML(row.tag) + ' の詳細" title="タグの詳細情報">ⓘ</button></span>' +
      '</div>';
    }).join("") : '<div class="empty-state">条件に一致するタグはありません。</div>';
    const start = Math.max(1, state.page - 2), end = Math.min(pages, Math.max(5, state.page + 3));
    let nums = "";
    for (let p = start; p <= end; p++) nums += '<button type="button" class="page-number' + (p - 1 === state.page ? ' active' : '') + '" data-page="' + (p - 1) + '" aria-current="' + (p - 1 === state.page ? 'page' : 'false') + '">' + p + '</button>';
    $(".result-heading .count").textContent = rows.length.toLocaleString("ja-JP") + " 件";
    $(".pagination").innerHTML = '<button class="page-number page-arrow" type="button" data-page="prev"' + (state.page === 0 ? ' disabled' : '') + '>前へ</button>' + (start > 1 ? '<span class="page-ellipsis">…</span>' : '') + nums + (end < pages ? '<span class="page-ellipsis">…</span><button class="page-number" type="button" data-page="' + (pages - 1) + '">' + pages + '</button>' : '') + '<button class="page-number page-arrow" type="button" data-page="next"' + (state.page >= pages - 1 ? ' disabled' : '') + '>次へ</button><span class="page-total">' + rows.length.toLocaleString("ja-JP") + '件</span>';
  }
  function resetDictionarySearch() {
    const search = $(".search-row .searchbox input");
    if (search) search.value = "";
    state.query = "";
    state.queryTerms = [];
    state.major = "";
    state.minor = "";
    state.favoritesOnly = false;
    $("#favorites-only").checked = false;
    Object.values(state.columnFilters).forEach(values => values.clear());
    state.sort = "index";
    state.sortDirection = "asc";
    renderCategories();
    renderTableTools();
    applyFilters();
    writeLocationState("replace");
  }
  function applyFilters() {
    state.filtered = state.all.filter(matches);
    const direction = state.sortDirection === "desc" ? -1 : 1;
    const compareText = (left, right, locale = "ja") => String(left || "").localeCompare(String(right || ""), locale, { numeric: true, sensitivity: "base" });
    if (state.sort === "index") state.filtered.sort((a,b) => direction * (Number(a.index) - Number(b.index)));
    else if (state.sort === "tag") state.filtered.sort((a,b) => direction * compareText(a.tag, b.tag, "en"));
    else if (state.sort === "ja") state.filtered.sort((a,b) => direction * compareText(a.ja, b.ja));
    else if (state.sort === "major") state.filtered.sort((a,b) => direction * (compareMajorCategories(a.major || "", b.major || "") || compareText(a.tag, b.tag, "en")));
    else if (state.sort === "level") state.filtered.sort((a,b) => {
      const left = expressionLevelFor(a), right = expressionLevelFor(b);
      return direction * ((left === null ? 99 : left) - (right === null ? 99 : right));
    });
    else if (state.sort === "favorites") state.filtered.sort((a,b) => direction * (Number(state.favorites.has(keyOf(b))) - Number(state.favorites.has(keyOf(a)))));
    // 元の順は読み込み時のindex順を維持する。
    state.page = 0;
    renderRows();
    writeLocationState("replace");
  }
  const promptItemsFor = polarity => polarity === "negative" ? state.promptItemsNegative : state.promptItemsPositive;
  const promptStateKey = polarity => polarity === "negative" ? "promptNegative" : "promptPositive";
  function splitPromptText(value) {
    const text = String(value || "");
    const parts = [];
    let start = 0, depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && depth > 0) depth--;
      else if (text[i] === "," && depth === 0) {
        const part = text.slice(start, i).trim();
        if (part) parts.push(part);
        start = i + 1;
      }
    }
    const tail = text.slice(start).trim();
    if (tail) parts.push(tail);
    return parts;
  }
  function parsePromptItem(value) {
    let text = String(value || "").trim(), weight = null;
    const weighted = text.match(/^\((.*):([0-9]+(?:\.[0-9]+)?)\)$/);
    if (weighted) {
      const number = Number(weighted[2]);
      if (Number.isFinite(number) && number >= 0.1 && number <= 2) {
        text = weighted[1].trim();
        weight = Math.round(number * 100) / 100;
      }
    }
    const row = state.all.find(item => item.tag === text);
    return { text, weight, key: row ? keyOf(row) : null };
  }
  function parsePromptItems(value) {
    return splitPromptText(value).map(parsePromptItem).filter(item => item.text);
  }
  function formatPromptWeight(value) {
    return Number(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }
  function serializePromptItems(items) {
    return items.map(item => item.weight === null || item.weight === undefined
      ? item.text
      : "(" + item.text + ":" + formatPromptWeight(item.weight) + ")").join(", ");
  }
  function setPromptItems(polarity, items) {
    if (polarity === "negative") state.promptItemsNegative = items;
    else state.promptItemsPositive = items;
    state[promptStateKey(polarity)] = serializePromptItems(items);
  }
  function ensurePromptItems(polarity) {
    const items = promptItemsFor(polarity);
    if (!Array.isArray(items) || (!items.length && state[promptStateKey(polarity)])) {
      const parsed = parsePromptItems(state[promptStateKey(polarity)]);
      if (polarity === "negative") state.promptItemsNegative = parsed;
      else state.promptItemsPositive = parsed;
      return parsed;
    }
    return items;
  }
  function appendPromptTag(polarity, tag) {
    const items = ensurePromptItems(polarity);
    if (!items.some(item => item.text === tag)) {
      const row = state.all.find(item => item.tag === tag);
      items.push({ text: tag, weight: null, key: row ? keyOf(row) : null });
    }
    setPromptItems(polarity, items);
    const output = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    if (output && state.promptMode !== polarity) output.value = state[promptStateKey(polarity)];
  }
  function removePromptTag(polarity, tag) {
    const items = ensurePromptItems(polarity).filter(item => item.text !== tag);
    setPromptItems(polarity, items);
    const output = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    if (output && state.promptMode !== polarity) output.value = state[promptStateKey(polarity)];
  }
  function saveBuilderState() {
    writeUserDataV2({ builderState: {
      selected: [...state.selected.keys()], polarity: [...state.polarity.entries()],
      promptPositive: state.promptPositive, promptNegative: state.promptNegative,
      promptItemsPositive: state.promptItemsPositive, promptItemsNegative: state.promptItemsNegative
    } });
  }
  function restoreBuilderState() {
    if (state.selectionRestored) return;
    state.selectionRestored = true;
    try {
      const saved = readUserDataV2()?.builderState || null;
      if (saved && typeof saved === "object") {
        const rowsByKey = new Map(state.all.map(row => [keyOf(row), row]));
        if (Array.isArray(saved.selected)) saved.selected.forEach(key => {
          const row = rowsByKey.get(key);
          if (row) state.selected.set(key, row);
        });
        if (Array.isArray(saved.polarity)) saved.polarity.forEach(([key, value]) => {
          if (state.selected.has(key) && (value === "positive" || value === "negative")) state.polarity.set(key, value);
        });
        state.selected.forEach((row, key) => { if (!state.polarity.has(key)) state.polarity.set(key, "positive"); });
        if (typeof saved.promptPositive === "string" && typeof saved.promptNegative === "string") {
          state.promptPositive = saved.promptPositive;
          state.promptNegative = saved.promptNegative;
        } else {
          const positive = [], negative = [];
          state.selected.forEach((row, key) => (state.polarity.get(key) === "negative" ? negative : positive).push(row.tag));
          if (typeof saved.positiveExtra === "string" && saved.positiveExtra.trim()) positive.push(saved.positiveExtra.trim());
          if (typeof saved.negativeExtra === "string" && saved.negativeExtra.trim()) negative.push(saved.negativeExtra.trim());
          state.promptPositive = positive.join(", ");
          state.promptNegative = negative.join(", ");
        }
        const restoreItems = (savedItems, text) => Array.isArray(savedItems)
          ? savedItems.filter(item => item && typeof item.text === "string" && item.text.trim()).map(item => ({
              text: item.text.trim(),
              weight: item.weight === null || item.weight === undefined || !Number.isFinite(Number(item.weight)) ? null : Math.max(0.1, Math.min(2, Math.round(Number(item.weight) * 100) / 100)),
              key: typeof item.key === "string" && rowsByKey.has(item.key) ? item.key : null
            }))
          : parsePromptItems(text);
        state.promptItemsPositive = restoreItems(saved.promptItemsPositive, state.promptPositive);
        state.promptItemsNegative = restoreItems(saved.promptItemsNegative, state.promptNegative);
        state.promptPositive = serializePromptItems(state.promptItemsPositive);
        state.promptNegative = serializePromptItems(state.promptItemsNegative);
      }
    } catch (error) { console.warn("プロンプト編集内容を復元できませんでした。", error); }
    $("#positive-output").value = state.promptPositive;
    $("#negative-output").value = state.promptNegative;
  }
  function promptCandidates(query) {
    const normalized = normalizeSearchText(query);
    if (!normalized || normalized.length < 1) return [];
    return state.all.map(row => {
      const fields = row._promptSearchFields || [row.tag, row.ja, ...parseAliases(row.aliases_json)].map(normalizeSearchText);
      let score = 99;
      fields.forEach(field => {
        if (field === normalized) score = Math.min(score, 0);
        else if (field.startsWith(normalized)) score = Math.min(score, 1);
        else if (field.includes(normalized)) score = Math.min(score, 2);
      });
      return { row, score };
    }).filter(item => item.score < 99)
      .sort((a, b) => a.score - b.score || a.row.tag.localeCompare(b.row.tag, "en"))
      .slice(0, 8).map(item => item.row);
  }
  function currentPromptSegment(textarea) {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const start = value.lastIndexOf(",", Math.max(0, cursor - 1)) + 1;
    const nextComma = value.indexOf(",", cursor);
    return { start, end: nextComma < 0 ? value.length : nextComma, query: value.slice(start, cursor).trim() };
  }
  function renderPromptAutocomplete(polarity) {
    if (state.promptMode !== polarity) return;
    const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    const panel = $("[data-autocomplete='" + polarity + "']");
    if (!textarea || !panel) return;
    const segment = currentPromptSegment(textarea);
    const candidates = promptCandidates(segment.query);
    panel.innerHTML = candidates.map(row =>
      '<button class="prompt-autocomplete-option" type="button" role="option" data-autocomplete-tag="' + escapeHTML(row.tag) + '"><strong>' + escapeHTML(row.tag) + '</strong><small>' + escapeHTML(row.ja) + '</small></button>'
    ).join("");
    panel.hidden = candidates.length === 0;
  }
  function applyPromptAutocomplete(polarity, tag) {
    const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    if (!textarea) return;
    const value = textarea.value;
    const segment = currentPromptSegment(textarea);
    const prefix = value.slice(0, segment.start);
    const suffix = value.slice(segment.end);
    const nextValue = prefix + (prefix && !prefix.endsWith(",") ? ", " : prefix.endsWith(",") ? " " : "") + tag + (suffix ? suffix : ", ");
    textarea.value = nextValue;
    state[promptStateKey(polarity)] = nextValue;
    const parsed = parsePromptItems(nextValue);
    if (polarity === "negative") state.promptItemsNegative = parsed; else state.promptItemsPositive = parsed;
    syncSelectedToPromptItems(polarity, parsed);
    renderEditor();
    renderPromptAutocomplete(polarity);
    const caret = nextValue.length;
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
  }
  function updatePromptDatalist(query) {
    const list = $("#prompt-tag-datalist");
    if (!list) return;
    list.innerHTML = promptCandidates(query).map(row =>
      '<option value="' + escapeHTML(row.tag) + '">' + escapeHTML(row.ja) + '</option>'
    ).join("");
  }
  function renderPromptBubbles(polarity) {
    const view = $("[data-bubble-view='" + polarity + "']");
    const toolbar = $("[data-bubble-toolbar='" + polarity + "']");
    const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    const items = ensurePromptItems(polarity);
    const active = state.activeBubble?.polarity === polarity ? state.activeBubble : null;
    if (!view || !toolbar || !textarea) return;
    view.hidden = state.promptMode === polarity;
    textarea.hidden = state.promptMode !== polarity;
    const panel = $("[data-autocomplete='" + polarity + "']");
    if (panel && state.promptMode !== polarity) panel.hidden = true;
    view.innerHTML = items.map((item, index) =>
      '<div class="prompt-bubble' + (active && active.index === index ? ' is-active' : '') + '" role="button" tabindex="0" draggable="true" aria-pressed="' + String(Boolean(active && active.index === index)) + '" data-bubble-index="' + index + '" data-bubble-polarity="' + polarity + '">' +
        '<span class="prompt-bubble-text">' + escapeHTML(item.text) + '</span>' +
        (item.weight !== null && item.weight !== undefined ? '<small class="prompt-bubble-weight">' + escapeHTML(formatPromptWeight(item.weight)) + '</small>' : '') +
      '</div>'
    ).join("") + '<button class="prompt-bubble-add" type="button" data-bubble-add="' + polarity + '" aria-label="手動タグを追加">＋</button><span class="prompt-bubble-blank">空き領域をタップしてテキスト入力</span>';
    toolbar.hidden = !active;
    const weight = toolbar.querySelector("[data-bubble-weight]");
    const editInput = toolbar.querySelector("[data-bubble-edit-input]");
    const editing = Boolean(active?.editing);
    const creating = Boolean(active?.creating);
    if (weight) {
      weight.hidden = !active || creating || editing;
      weight.value = active && !creating && items[active.index] && items[active.index].weight !== null
        ? formatPromptWeight(items[active.index].weight) : "1.00";
    }
    if (editInput) {
      editInput.hidden = !editing;
      if (editing && document.activeElement !== editInput) editInput.value = creating ? (editInput.value || "") : (items[active.index]?.text || "");
    }
    ["save-edit","cancel-edit"].forEach(action => {
      const button = toolbar.querySelector('[data-bubble-action="' + action + '"]');
      if (button) button.hidden = !editing;
    });
    ["edit","move","move-up","move-down","delete","clear-weight"].forEach(action => {
      const button = toolbar.querySelector('[data-bubble-action="' + action + '"]');
      if (button) button.hidden = !active || editing || creating;
    });
    const move = toolbar.querySelector('[data-bubble-action="move"]');
    if (move) move.textContent = polarity === "positive" ? "Negativeへ" : "Positiveへ";
  }
  function renderEditor() {
    saveBuilderState();
    const rows = [...state.selected.values()], count = state.selected.size;
    $$(".stats strong")[1].textContent = String(count);
    const countLabel = $(".selected-dock-count");
    if (countLabel) countLabel.textContent = count + " 件選択中";
    const chips = $(".selected-dock-tags");
    if (chips) chips.innerHTML = rows.slice(0, 8).map(row => '<span class="selected-dock-chip"><span title="' + escapeHTML(row.tag) + '">' + escapeHTML(row.tag) + '</span><button class="selected-dock-remove" type="button" data-remove="' + escapeHTML(keyOf(row)) + '" aria-label="削除">×</button></span>').join("") + (count > 8 ? '<span class="selected-dock-more">+' + (count - 8) + '件</span>' : "");
    const dock = $(".selected-dock"); if (dock) dock.hidden = count === 0;
    if (state.promptMode !== "positive") $("#positive-output").value = state.promptPositive;
    if (state.promptMode !== "negative") $("#negative-output").value = state.promptNegative;
    renderPromptBubbles("positive");
    renderPromptBubbles("negative");
    const positive = $("#positive-output"), negative = $("#negative-output");
    $('[data-action="copy-positive"]').disabled = !positive?.value;
    $('[data-action="save-positive"]').disabled = !positive?.value;
    $('[data-action="copy-negative"]').disabled = !negative?.value;
    $('[data-action="save-negative"]').disabled = !negative?.value;
  }
  function enterPromptTextMode(polarity) {
    state.promptMode = polarity;
    state.activeBubble = null;
    renderEditor();
    const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    if (textarea) {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    }
  }
  function commitPromptTextMode(polarity) {
    if (state.promptMode !== polarity) return;
    const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
    const parsed = parsePromptItems(textarea?.value || "");
    setPromptItems(polarity, parsed);
    syncSelectedToPromptItems(polarity, parsed);
    state.promptMode = null;
    state.activeBubble = null;
    renderEditor();
  }
  function syncSelectedToPromptItems(polarity, items) {
    const present = new Set(items.map(item => item.key).filter(Boolean));
    items.forEach(item => {
      if (!item.key) return;
      const row = state.all.find(candidate => keyOf(candidate) === item.key);
      if (row) {
        state.selected.set(item.key, row);
        state.polarity.set(item.key, polarity);
      }
    });
    [...state.selected.keys()].forEach(key => {
      if (state.polarity.get(key) === polarity && !present.has(key)) {
        state.selected.delete(key);
        state.polarity.delete(key);
      }
    });
  }
  function syncPromptTextInput(polarity, value) {
    state[promptStateKey(polarity)] = value;
    const parsed = parsePromptItems(value);
    if (polarity === "negative") state.promptItemsNegative = parsed;
    else state.promptItemsPositive = parsed;
    syncSelectedToPromptItems(polarity, parsed);
    renderEditor();
    renderPromptAutocomplete(polarity);
    const hasValue = Boolean(value.trim());
    $('[data-action="copy-' + polarity + '"]').disabled = !hasValue;
    $('[data-action="save-' + polarity + '"]').disabled = !hasValue;
  }
  function selectPromptBubble(polarity, index) {
    state.activeBubble = { polarity, index, editing: false, creating: false };
    renderEditor();
  }
  function reorderPromptBubble(polarity, from, to) {
    const items = ensurePromptItems(polarity);
    if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) return;
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item);
    setPromptItems(polarity, items);
    state.activeBubble = { polarity, index: to, editing: false, creating: false };
    renderEditor();
  }
  function changePromptWeight(polarity, index, delta) {
    const items = ensurePromptItems(polarity);
    if (!items[index]) return;
    const current = items[index].weight === null || items[index].weight === undefined ? 1 : Number(items[index].weight);
    items[index].weight = Math.max(0.1, Math.min(2, Math.round((current + delta) * 100) / 100));
    setPromptItems(polarity, items);
    state.activeBubble = { polarity, index, editing: false, creating: false };
    renderEditor();
  }
  function movePromptBubble(polarity, index) {
    const source = ensurePromptItems(polarity);
    if (!source[index]) return;
    const targetPolarity = polarity === "positive" ? "negative" : "positive";
    const [item] = source.splice(index, 1);
    const target = ensurePromptItems(targetPolarity);
    target.push(item);
    setPromptItems(polarity, source);
    setPromptItems(targetPolarity, target);
    if (item.key && state.selected.has(item.key)) state.polarity.set(item.key, targetPolarity);
    state.activeBubble = null;
    renderRows();
    renderEditor();
  }
  function deletePromptBubble(polarity, index) {
    const items = ensurePromptItems(polarity);
    const [removed] = items.splice(index, 1);
    if (removed?.key) {
      state.selected.delete(removed.key);
      state.polarity.delete(removed.key);
    }
    setPromptItems(polarity, items);
    state.activeBubble = null;
    renderRows();
    renderEditor();
  }
  function savePromptBubbleEdit(polarity) {
    const toolbar = $("[data-bubble-toolbar='" + polarity + "']");
    const input = toolbar?.querySelector("[data-bubble-edit-input]");
    const active = state.activeBubble;
    const text = String(input?.value || "").trim();
    if (!active || active.polarity !== polarity || !text) return;
    if (text.includes(",")) {
      window.alert("タグ内のカンマは区切り文字として扱われます。カンマを含まない表記を入力してください。");
      return;
    }
    const items = ensurePromptItems(polarity);
    const matchingRow = state.all.find(row => row.tag === text) || null;
    if (active.creating) {
      items.push({ text, weight: null, key: matchingRow ? keyOf(matchingRow) : null });
      if (matchingRow) { state.selected.set(keyOf(matchingRow), matchingRow); state.polarity.set(keyOf(matchingRow), polarity); }
    } else if (items[active.index]) {
      const old = items[active.index];
      if (old.key && old.text !== text) {
        state.selected.delete(old.key);
        state.polarity.delete(old.key);
      }
      const nextKey = old.text === text ? old.key : (matchingRow ? keyOf(matchingRow) : null);
      items[active.index] = { ...old, text, key: nextKey };
      if (nextKey && matchingRow) { state.selected.set(nextKey, matchingRow); state.polarity.set(nextKey, polarity); }
    }
    setPromptItems(polarity, items);
    state.activeBubble = { polarity, index: active.creating ? items.length - 1 : active.index, editing: false, creating: false };
    renderRows();
    renderEditor();
  }
  function addRow(row) {
    const key = keyOf(row);
    if (!state.selected.has(key)) {
      state.selected.set(key, row); state.polarity.set(key, "positive");
      appendPromptTag("positive", row.tag);
    }
    renderRows(); renderEditor();
  }
  function toggleRow(row) {
    const key = keyOf(row);
    if (state.selected.has(key)) {
      removePromptTag(state.polarity.get(key) || "positive", row.tag);
      state.selected.delete(key); state.polarity.delete(key);
    } else {
      state.selected.set(key, row); state.polarity.set(key, "positive");
      appendPromptTag("positive", row.tag);
    }
    renderRows(); renderEditor();
  }
  function cycleRowState(row) {
    const key = keyOf(row);
    if (!state.selected.has(key)) {
      state.selected.set(key, row); state.polarity.set(key, "positive");
      appendPromptTag("positive", row.tag);
    } else if (state.polarity.get(key) === "positive") {
      removePromptTag("positive", row.tag); state.polarity.set(key, "negative");
      appendPromptTag("negative", row.tag);
    } else {
      removePromptTag("negative", row.tag);
      state.selected.delete(key); state.polarity.delete(key);
    }
    renderRows(); renderEditor();
  }
  function showTagDetail(row) {
    const dialog = $("#tag-detail-dialog");
    if (!dialog || !row) return;
    const aliases = parseAliases(row.aliases_json);
    const related = state.all.filter(item => item !== row && row.major && item.major === row.major && (row.minor ? item.minor === row.minor : true)).slice(0,8);
    const fields = [["大分類",row.major],["中分類",row.minor],["小分類",row.detail],["別名",aliases.join("、")],["表現レベル", expressionLevelFor(row) === null ? "未判定" : String(expressionLevelFor(row))],["年齢判定",row.age_safety],["翻訳状態",statusLabel(row.translation_status)],["分類確認",statusLabel(row.classification_review_status)]].filter(([,value]) => value);
    $(".tag-detail-content").innerHTML =
      '<div class="tag-detail-main"><strong>' + escapeHTML(row.tag) + '</strong><span>' + escapeHTML(row.ja) + '</span></div>' +
      '<dl class="tag-detail-fields">' + fields.map(([label,value]) => '<div><dt>' + escapeHTML(label) + '</dt><dd>' + escapeHTML(value) + '</dd></div>').join("") + '</dl>' +
      (related.length ? '<section class="detail-related"><h3>同じ分類のタグ</h3><div>' + related.map(item => '<button type="button" data-add="' + escapeHTML(keyOf(item)) + '">' + escapeHTML(item.ja || item.tag) + '<small>' + escapeHTML(item.tag) + '</small></button>').join("") + '</div></section>' : '');
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open","");
  }
  function writeLocationState(mode = "replace") {
    if (skipLocationWrite) return;
    const params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.major) params.set("major", state.major);
    if (state.minor) params.set("minor", state.minor);
    if (state.favoritesOnly) params.set("favorites", "1");
    if (state.worksQuery) params.set("works", state.worksQuery);
    if (state.authorsQuery) params.set("authors", state.authorsQuery);
    const hash = "#" + state.activeScreen + (params.toString() ? "?" + params.toString() : "");
    if (window.location.hash === hash) return;
    if (mode === "push") history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  }
  function restoreLocationState() {
    const raw = window.location.hash.replace(/^#/, "");
    const [screenPart, queryPart = ""] = raw.split("?");
    const allowed = ["dictionary-screen", "works-screen", "authors-screen", "editor-screen"];
    const screen = allowed.includes(screenPart) ? screenPart : "dictionary-screen";
    const params = new URLSearchParams(queryPart);
    state.query = params.get("q") || "";
    state.major = params.get("major") || "";
    state.minor = params.get("minor") || "";
    state.favoritesOnly = params.get("favorites") === "1";
    state.worksQuery = params.get("works") || "";
    state.authorsQuery = params.get("authors") || "";
    $("#works-search").value = state.worksQuery;
    $("#authors-search").value = state.authorsQuery;
    const search = $(".search-row .searchbox input");
    if (search) search.value = state.query;
    $("#favorites-only").checked = state.favoritesOnly;
    state.queryTerms = state.query.split(/\s+/).map(normalizeSearchText).filter(Boolean);
    renderCategories();
    renderTableTools();
    setScreen(screen, { historyMode: "none" });
    applyFilters();
  }
  function setScreen(id, options = {}) {
    state.activeScreen = id;
    $$(".app-screen").forEach(screen => screen.hidden = screen.id !== id);
    $$(".screen-tab").forEach(tab => {
      const active = tab.getAttribute("href") === "#" + id;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    });
    if (id === "works-screen") { ensureRelatedIndexes(); renderWorkList(); }
    if (id === "authors-screen") { ensureRelatedIndexes(); renderAuthorList(); }
    if (id === "editor-screen") renderEditor();
    if (options.historyMode !== "none") writeLocationState(options.historyMode || "push");
  }
  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function copyText(text) {
    if (!text) return;
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const area = document.createElement("textarea");
      area.value = text; document.body.append(area); area.select();
      const copied = document.execCommand("copy"); area.remove(); return copied;
    }
  }
  function bindTableTools() {
    const root = $(".table-head");
    if (!root) return;
    root.addEventListener("click", event => {
      const sort = event.target.closest("[data-sort-field]");
      if (sort) {
        state.sort = sort.dataset.sortField;
        state.sortDirection = sort.dataset.sortDirection;
        root.querySelectorAll("details[open]").forEach(menu => { menu.open = false; });
        renderTableTools();
        applyFilters();
        return;
      }
      const clear = event.target.closest("[data-filter-clear]");
      if (clear) {
        state.columnFilters[clear.dataset.filterClear].clear();
        renderTableTools();
        applyFilters();
      }
    });
    root.addEventListener("click", event => {
      const summary = event.target.closest(".column-menu > summary");
      if (!summary) return;
      requestAnimationFrame(() => {
        const menu = summary.parentElement;
        if (!menu.open) return;
        const panel = menu.querySelector(".column-menu-panel");
        if (!panel) return;
        const rect = summary.getBoundingClientRect();
        const width = Math.min(panel.scrollWidth || 240, window.innerWidth - 20);
        const height = Math.min(panel.scrollHeight || 180, window.innerHeight - 20);
        panel.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - width - 10)) + "px";
        panel.style.right = "auto";
        panel.style.top = Math.max(10, Math.min(rect.bottom + 5, window.innerHeight - height - 10)) + "px";
      });
    });
    root.addEventListener("change", event => {
      const input = event.target.closest("[data-filter-group]");
      if (input) {
        const values = state.columnFilters[input.dataset.filterGroup];
        if (input.checked) values.add(input.value); else values.delete(input.value);
        applyFilters();
        return;
      }
      const favorite = event.target.closest("[data-filter-favorites]");
      if (favorite) {
        state.favoritesOnly = favorite.checked;
        $("#favorites-only").checked = favorite.checked;
        applyFilters();
      }
    });
  }
  function bindControls() {
    $("#works-search").addEventListener("input", event => { state.worksQuery = event.target.value.trim().toLocaleLowerCase(); renderWorkList(); writeLocationState("replace"); });
    $("#authors-search").addEventListener("input", event => { state.authorsQuery = event.target.value.trim().toLocaleLowerCase(); renderAuthorList(); writeLocationState("replace"); });
    $$(".related-list").forEach(root => root.addEventListener("change", event => {
      const input = event.target.closest(".related-select");
      if (!input) return;
      const row = state.all.find(item => keyOf(item) === input.dataset.key);
      if (!row) return;
      if (input.checked) {
        state.selected.set(input.dataset.key, row); state.polarity.set(input.dataset.key, "positive");
        appendPromptTag("positive", row.tag);
      } else {
        removePromptTag(state.polarity.get(input.dataset.key) || "positive", row.tag);
        state.selected.delete(input.dataset.key); state.polarity.delete(input.dataset.key);
      }
      renderEditor();
    }));
    const search = $(".search-row .searchbox input");
    let searchDebounceTimer = null;
    const applySearchInput = () => {
      state.query = search.value.trim();
      state.queryTerms = state.query.split(/\s+/).map(normalizeSearchText).filter(Boolean);
      applyFilters();
      writeLocationState("replace");
    };
    const scheduleSearch = () => {
      window.clearTimeout(searchDebounceTimer);
      searchDebounceTimer = window.setTimeout(applySearchInput, 120);
    };
    search.addEventListener("compositionstart", () => window.clearTimeout(searchDebounceTimer));
    search.addEventListener("compositionend", scheduleSearch);
    search.addEventListener("input", event => {
      if (event.isComposing) return;
      scheduleSearch();
    });

    $("#favorites-only").addEventListener("change", event => { state.favoritesOnly = event.target.checked; state.major = ""; state.minor = ""; renderCategories(); renderTableTools(); applyFilters(); });
    // ユーザー設定はCSV読み込み後、統合データセットに対して移行・復元する。
    const categoryToggle = $(".category-mobile-toggle");
    const setCategoryPanelOpen = open => {
      categoryToggle.setAttribute("aria-expanded", String(open));
      categoryToggle.querySelector("span").textContent = state.major ? state.major + " · " + (open ? "閉じる" : "開く") : (open ? "閉じる" : "タップして開閉");
    };
    categoryToggle.addEventListener("click", () => {
      setCategoryPanelOpen(categoryToggle.getAttribute("aria-expanded") !== "true");
    });
    $(".category-tree").addEventListener("change", event => {
      const visibility = event.target.closest("[data-category-visible]");
      if (!visibility) return;
      const major = visibility.dataset.categoryVisible;
      if (visibility.checked) state.hiddenMajorCategories.delete(major);
      else state.hiddenMajorCategories.add(major);
      writeUserDataV2({ hiddenMajorCategories: [...state.hiddenMajorCategories] });
      renderCategories();
    });
    $(".category-tree").addEventListener("click", event => {
      const showAll = event.target.closest("[data-show-all-categories]");
      if (showAll) {
        state.hiddenMajorCategories.clear();
        writeUserDataV2({ hiddenMajorCategories: [] });
        renderCategories();
        return;
      }
      const favoriteCategory = event.target.closest("[data-favorites]");
      if (favoriteCategory) {
        state.favoritesOnly = !state.favoritesOnly;
        state.major = ""; state.minor = "";
        $("#favorites-only").checked = state.favoritesOnly;
        renderCategories(); renderTableTools(); applyFilters(); setCategoryPanelOpen(false);
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
    $(".search-row > .button").addEventListener("click", resetDictionarySearch);
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
        writeUserDataV2({ favorites: [...state.favorites] });
        renderCategories();
        if (state.favoritesOnly) applyFilters(); else renderRows();
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
    window.addEventListener("keydown", event => {
      const target = event.target;
      const isTyping = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === "/" && !isTyping && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        $(".search-row .searchbox input").focus();
      }
      if (event.key === "Escape") {
        const dialog = $("#tag-detail-dialog");
        if (dialog?.open) dialog.close();
        $$(".column-menu[open]").forEach(menu => { menu.open = false; });
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
      const row = state.all.find(item => keyOf(item) === button.dataset.remove);
      if (row) removePromptTag(state.polarity.get(button.dataset.remove) || "positive", row.tag);
      state.selected.delete(button.dataset.remove); state.polarity.delete(button.dataset.remove);
      renderRows(); renderEditor();
    });
    $(".selected-dock-actions [data-action='open-editor']").addEventListener("click", () => setScreen("editor-screen"));
    $(".editor-builder-panel .text-button").addEventListener("click", () => {
      if (!state.selected.size && !state.promptPositive && !state.promptNegative) return;
      if (!window.confirm("選択タグとプロンプト本文をすべて解除しますか？")) return;
      state.selected.clear(); state.polarity.clear();
      state.promptPositive = ""; state.promptNegative = "";
      $("#positive-output").value = ""; $("#negative-output").value = "";
      renderRows(); renderEditor();
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
    ["positive","negative"].forEach(polarity => {
      const textarea = $(polarity === "negative" ? "#negative-output" : "#positive-output");
      textarea.addEventListener("input", event => {
        if (!event.isComposing) syncPromptTextInput(polarity, event.target.value);
      });
      textarea.addEventListener("compositionend", event => syncPromptTextInput(polarity, event.target.value));
      textarea.addEventListener("keydown", event => {
        const panel = $("[data-autocomplete='" + polarity + "']");
        const option = panel?.querySelector(".prompt-autocomplete-option");
        if (event.key === "Escape" && panel && !panel.hidden) { panel.hidden = true; event.stopPropagation(); }
        else if (event.key === "ArrowDown" && option && !panel.hidden) { event.preventDefault(); option.focus(); }
        else if (event.key === "Enter" && option && !panel.hidden) { event.preventDefault(); applyPromptAutocomplete(polarity, option.dataset.autocompleteTag); }
      });
      $("[data-autocomplete='" + polarity + "']").addEventListener("keydown", event => {
        const options = [...event.currentTarget.querySelectorAll(".prompt-autocomplete-option")];
        const index = options.indexOf(document.activeElement);
        if (event.key === "ArrowDown" && options.length) { event.preventDefault(); options[Math.min(options.length - 1, index + 1)].focus(); }
        else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); if (index <= 0) textarea.focus(); else options[index - 1].focus(); }
        else if (event.key === "Escape") { event.preventDefault(); event.currentTarget.hidden = true; textarea.focus(); }
      });
      const region = $("[data-prompt-region='" + polarity + "']");
      region.addEventListener("click", event => {
        const option = event.target.closest("[data-autocomplete-tag]");
        if (option) { applyPromptAutocomplete(polarity, option.dataset.autocompleteTag); return; }
        if (event.target.closest("textarea")) return;
        if (event.target.closest(".prompt-bubble-add")) {
          state.activeBubble = { polarity, index: -1, editing: true, creating: true };
          renderEditor();
          const input = $("[data-bubble-toolbar='" + polarity + "'] [data-bubble-edit-input]");
          if (input) { input.value = ""; input.hidden = false; input.focus(); }
          return;
        }
        const bubble = event.target.closest("[data-bubble-index]");
        if (bubble) { selectPromptBubble(polarity, Number(bubble.dataset.bubbleIndex)); return; }
        if (state.promptMode !== polarity) enterPromptTextMode(polarity);
      });
      region.addEventListener("keydown", event => {
        const bubble = event.target.closest("[data-bubble-index]");
        if (!bubble) return;
        const index = Number(bubble.dataset.bubbleIndex);
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectPromptBubble(polarity, index); }
        else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); deletePromptBubble(polarity, index); }
        else if (event.key === "Escape") { state.activeBubble = null; renderEditor(); }
        else if (event.ctrlKey && event.key === "ArrowUp") { event.preventDefault(); changePromptWeight(polarity, index, 0.1); }
        else if (event.ctrlKey && event.key === "ArrowDown") { event.preventDefault(); changePromptWeight(polarity, index, -0.1); }
        else if (event.ctrlKey && event.key === "ArrowLeft") { event.preventDefault(); reorderPromptBubble(polarity, index, index - 1); }
        else if (event.ctrlKey && event.key === "ArrowRight") { event.preventDefault(); reorderPromptBubble(polarity, index, index + 1); }
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const bubbles = [...region.querySelectorAll("[data-bubble-index]")];
          const next = bubbles[index + (event.key === "ArrowRight" ? 1 : -1)];
          if (next) { event.preventDefault(); next.focus(); }
        }
      });
      region.addEventListener("dragstart", event => {
        const bubble = event.target.closest("[data-bubble-index]");
        if (!bubble || !event.dataTransfer) return;
        event.dataTransfer.setData("text/plain", JSON.stringify({ polarity, index: Number(bubble.dataset.bubbleIndex) }));
        event.dataTransfer.effectAllowed = "move";
      });
      region.addEventListener("dragover", event => { if (event.target.closest("[data-bubble-index]")) event.preventDefault(); });
      region.addEventListener("drop", event => {
        const targetBubble = event.target.closest("[data-bubble-index]");
        if (!targetBubble || !event.dataTransfer) return;
        event.preventDefault();
        try {
          const source = JSON.parse(event.dataTransfer.getData("text/plain"));
          const targetIndex = Number(targetBubble.dataset.bubbleIndex);
          if (source.polarity === polarity) reorderPromptBubble(polarity, source.index, targetIndex);
          else {
            const moved = ensurePromptItems(source.polarity).splice(source.index, 1)[0];
            if (!moved) return;
            ensurePromptItems(polarity).splice(targetIndex, 0, moved);
            setPromptItems(source.polarity, ensurePromptItems(source.polarity));
            setPromptItems(polarity, ensurePromptItems(polarity));
            if (moved.key && state.selected.has(moved.key)) state.polarity.set(moved.key, polarity);
            state.activeBubble = null;
            renderRows(); renderEditor();
          }
        } catch {}
      });
    });
    let longPressTimer = null;
    $(".editor-builder-panel").addEventListener("pointerdown", event => {
      const bubble = event.target.closest("[data-bubble-index]");
      if (!bubble || event.pointerType !== "touch") return;
      const polarity = bubble.dataset.bubblePolarity;
      const index = Number(bubble.dataset.bubbleIndex);
      longPressTimer = window.setTimeout(() => selectPromptBubble(polarity, index), 500);
    });
    ["pointerup","pointercancel","pointerleave"].forEach(type => $(".editor-builder-panel").addEventListener(type, () => {
      if (longPressTimer) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }));
    $(".editor-builder-panel").addEventListener("click", event => {
      const actionButton = event.target.closest("[data-bubble-action]");
      if (!actionButton) return;
      const toolbar = actionButton.closest("[data-bubble-toolbar]");
      const polarity = toolbar?.dataset.bubbleToolbar;
      const active = state.activeBubble;
      if (!polarity || !active || active.polarity !== polarity) return;
      const action = actionButton.dataset.bubbleAction;
      if (action === "edit") {
        state.activeBubble = { ...active, editing: true };
        renderEditor();
        const input = toolbar.querySelector("[data-bubble-edit-input]");
        if (input) { input.hidden = false; input.value = ensurePromptItems(polarity)[active.index]?.text || ""; input.focus(); }
      } else if (action === "save-edit") savePromptBubbleEdit(polarity);
      else if (action === "cancel-edit") {
        state.activeBubble = active.creating ? null : { ...active, editing: false, creating: false };
        renderEditor();
      }
      else if (action === "clear-weight") {
        const items = ensurePromptItems(polarity);
        if (items[active.index]) { items[active.index].weight = null; setPromptItems(polarity, items); renderEditor(); }
      }
      else if (action === "move") movePromptBubble(polarity, active.index);
      else if (action === "move-up") reorderPromptBubble(polarity, active.index, active.index - 1);
      else if (action === "move-down") reorderPromptBubble(polarity, active.index, active.index + 1);
      else if (action === "delete") deletePromptBubble(polarity, active.index);
    });
    $(".editor-builder-panel").addEventListener("change", event => {
      const weightInput = event.target.closest("[data-bubble-weight]");
      if (weightInput && state.activeBubble && !state.activeBubble.creating) {
        const { polarity, index } = state.activeBubble;
        const value = Number(weightInput.value);
        if (!Number.isFinite(value) || value < 0.1 || value > 2) {
          window.alert("重みは0.1〜2.0の範囲で入力してください。");
          renderEditor();
          return;
        }
        const items = ensurePromptItems(polarity);
        if (items[index]) { items[index].weight = Math.round(value * 100) / 100; setPromptItems(polarity, items); renderEditor(); }
      }
    });
    $(".editor-builder-panel").addEventListener("input", event => {
      const editInput = event.target.closest("[data-bubble-edit-input]");
      if (editInput) updatePromptDatalist(editInput.value);
    });
    $(".editor-builder-panel").addEventListener("keydown", event => {
      const editInput = event.target.closest("[data-bubble-edit-input]");
      if (!editInput) return;
      const toolbar = editInput.closest("[data-bubble-toolbar]");
      const polarity = toolbar?.dataset.bubbleToolbar;
      if (event.key === "Enter") { event.preventDefault(); savePromptBubbleEdit(polarity); }
      if (event.key === "Escape") { event.preventDefault(); state.activeBubble = null; renderEditor(); }
    });
    document.addEventListener("pointerdown", event => {
      if (state.promptMode && !event.target.closest(".prompt-editor-region")) commitPromptTextMode(state.promptMode);
    }, true);

    $$("[data-action]").forEach(button => button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const target = action.includes("negative") ? $("#negative-output") : $("#positive-output");
      if (action.startsWith("copy")) {
        const copied = await copyText(target.value);
        if (copied) {
          const original = button.textContent;
          button.textContent = "コピーしました";
          button.disabled = true;
          window.setTimeout(() => { button.textContent = original; button.disabled = !target.value; }, 1400);
        } else button.textContent = "コピー失敗";
      }
      if (action.startsWith("save")) downloadText(action.includes("negative") ? "negative-prompt.txt" : "positive-prompt.txt", target.value);
    }));
  }
  function createDock() {
    const dock = document.createElement("aside");
    dock.className = "selected-dock"; dock.hidden = true;
    dock.innerHTML = '<div class="selected-dock-content"><strong class="selected-dock-count">0 件選択中</strong><div class="selected-dock-tags"></div></div><div class="selected-dock-actions"><button class="button button-primary" type="button" data-action="open-editor">プロンプト編集へ</button><button class="button button-quiet" type="button" data-action="clear-selection">全解除</button></div>';
    document.body.append(dock);
    dock.querySelector('[data-action="clear-selection"]').addEventListener("click", () => {
      if (!state.selected.size && !state.promptPositive && !state.promptNegative) return;
      if (!window.confirm("選択タグとプロンプト本文をすべて解除しますか？")) return;
      state.selected.clear(); state.polarity.clear();
      state.promptPositive = ""; state.promptNegative = "";
      $("#positive-output").value = ""; $("#negative-output").value = "";
      renderRows(); renderEditor();
    });
  }
  async function init() {
    setScreen("dictionary-screen", { historyMode: "none" });
    setMessage("CSVデータを読み込んでいます…");
    createDock();
    setupColumnResizers();
    try {
      const loaded = await Promise.all(DATA_FILES.map(loadCSV));
      const applyLoadedData = rowsByFile => {
        state.all = rowsByFile.flat();
        state.all.sort((a,b) => Number(a.index) - Number(b.index));
        prepareSearchIndex();
        const userData = migrateLegacyUserData();
        state.favorites = new Set(Array.isArray(userData.favorites) ? userData.favorites.filter(key => typeof key === "string") : []);
        state.hiddenMajorCategories = new Set(Array.isArray(userData.hiddenMajorCategories) ? userData.hiddenMajorCategories.filter(value => typeof value === "string") : []);
        state.expressionLevels = new Map(Array.isArray(userData.expressionLevels) ? userData.expressionLevels.filter(entry => Array.isArray(entry) && typeof entry[0] === "string" && (entry[1] === null || [0,1,2,3,4].includes(entry[1])) ) : []);
        renderMigrationReport(userData);
        if (!state.selectionRestored) restoreBuilderState();
        else {
          const rowsByKey = new Map(state.all.map(row => [keyOf(row), row]));
          state.selected = new Map([...state.selected.keys()].map(key => [key, rowsByKey.get(key)]).filter(([, row]) => row));
          state.polarity = new Map([...state.polarity].filter(([key]) => state.selected.has(key)));
        }
        state.relatedIndexesReady = false;
        state.works = []; state.authors = []; state.reviewRows = []; state.ambiguousRows = [];
        if (state.query) ensureRelatedIndexes();
        $(".stats strong").textContent = state.all.length.toLocaleString("ja-JP");
        renderCategories();
        renderTableTools();
        applyFilters();
        renderEditor();
      };
      // 操作イベントと保存済み設定を先に読み込み、CSVの表示処理を最小化する。
      bindControls();
      bindTableTools();
      // キャッシュ（または初回取得分）を一覧へ直接反映する。
      skipLocationWrite = true;
      applyLoadedData(loaded.map(item => item.rows));
      skipLocationWrite = false;
      restoreLocationState();
      window.addEventListener("popstate", restoreLocationState);
      // 最新CSVは裏で確認し、実データに差分があったファイルだけ差し替える。
      Promise.all(loaded.map(item => item.refresh)).then(refreshed => {
        if (refreshed.some(Boolean)) {
          const currentPage = state.page;
          applyLoadedData(loaded.map((item, index) => refreshed[index] || item.rows));
          state.page = Math.min(currentPage, Math.max(0, Math.ceil(state.filtered.length / PAGE_SIZE) - 1));
          renderRows();
          if (state.activeScreen === "works-screen") { ensureRelatedIndexes(); renderWorkList(); }
          if (state.activeScreen === "authors-screen") { ensureRelatedIndexes(); renderAuthorList(); }
        }
      });
    } catch (error) {
      console.error(error);
      setMessage("CSVの読み込みに失敗しました。GitHub Pages上で開いているか、CSVファイルの配置と12列ヘッダーを確認してください。詳細: " + error.message, true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
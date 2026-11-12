(() => {
  "use strict";
  const DATA_FILES = [
    { url: "./dictionary-working.csv", source: "dictionary-working.csv" },
    { url: "./characters-working.csv", source: "characters-working.csv" }
  ];
  const PAGE_SIZE = 100;
  const state = { all: [], filtered: [], page: 0, major: "", minor: "", query: "", classification: "all", review: "all", sort: "index" };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
  const csvHeaders = ["index","tag","ja","major","minor","detail","aliases_json","translation_status","ero_level","ero_review_status","classification_review_status","age_safety"];
  function statusLabel(value) {
    return ({ verified:"確認済み", pending:"未確認", needs_review:"要確認", "needs-review":"要確認", provisional:"暫定", unverified:"未確認" })[value] || value || "—";
  }
  function setMessage(message, error = false) {
    const target = $(".tag-results");
    target.innerHTML = '<div class="empty-state' + (error ? ' load-error' : '') + '">' + escapeHTML(message) + '</div>';
  }
  async function loadCSV(file) {
    const response = await fetch(file.url, { cache: "no-store" });
    if (!response.ok) throw new Error(file.url + " の読み込みに失敗しました (HTTP " + response.status + ")");
    const text = await response.text();
    const rows = window.DictionaryCSV.parseCSV(text);
    if (!rows.length) throw new Error(file.url + " にデータ行がありません。");
    const actual = Object.keys(rows[0]);
    if (csvHeaders.some((header, i) => actual[i] !== header) || actual.length !== csvHeaders.length) {
      throw new Error(file.url + " のCSVヘッダーが想定する12列と一致しません。");
    }
    return rows.map(row => ({ ...row, source: file.source }));
  }
  function categoryCounts(rows, key) {
    const counts = new Map();
    rows.forEach(row => { const value = row[key]; if (value) counts.set(value, (counts.get(value) || 0) + 1); });
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
    if (state.review === "unconfirmed" && !["pending","unverified",""].includes(row.translation_status) && !["pending","unverified",""].includes(row.classification_review_status)) return false;
    if (state.review === "needs" && !["needs_review","needs-review"].includes(row.translation_status) && !["needs_review","needs-review"].includes(row.classification_review_status) && !["needs_review","needs-review"].includes(row.ero_review_status)) return false;
    if (state.query) {
      const q = state.query.toLocaleLowerCase();
      const values = [row.tag,row.ja,row.major,row.minor,row.detail,row.aliases_json].join(" ").toLocaleLowerCase();
      if (!values.includes(q)) return false;
    }
    return true;
  }
  function renderRows() {
    const rows = state.filtered;
    const start = state.page * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);
    $(".tag-results").innerHTML = pageRows.length ? pageRows.map(row => '<div class="tag-row" role="row">' +
      '<span class="row-index">' + escapeHTML(row.index) + '</span>' +
      '<span class="tag-english">' + escapeHTML(row.tag) + '</span>' +
      '<span class="tag-japanese">' + escapeHTML(row.ja) + '</span>' +
      '<span class="tag-category">' + escapeHTML(row.major || "—") + '</span>' +
      '<span class="tag-category">' + escapeHTML(row.minor || "—") + '</span>' +
      '<span class="tag-category">' + escapeHTML(row.detail || "—") + '</span>' +
      '<span class="tag-category alias-cell">' + escapeHTML(row.aliases_json || "—") + '</span>' +
      '<span class="tag-category">' + escapeHTML(statusLabel(row.translation_status)) + '</span>' +
      '<span class="tag-category">' + escapeHTML(row.ero_level || "0") + '</span>' +
      '<span class="tag-category">' + escapeHTML(row.source === "characters-working.csv" ? "作品・人物" : "一般") + '</span>' +
      '</div>').join("") : '<div class="empty-state">条件に一致するタグはありません。</div>';
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    $(".count").textContent = rows.length.toLocaleString("ja-JP") + " 件";
    const pager = $(".pagination");
    pager.innerHTML = '<button class="button button-quiet" type="button" data-page="prev"' + (state.page === 0 ? " disabled" : "") + '>前へ</button><span>' + (state.page + 1) + " / " + pages + " ページ（" + rows.length.toLocaleString("ja-JP") + "件）</span><button class=\"button button-quiet\" type=\"button\" data-page=\"next\"" + (state.page + 1 >= pages ? " disabled" : "") + '>次へ</button>';
  }
  function applyFilters() {
    state.filtered = state.all.filter(matches);
    if (state.sort === "tag") state.filtered.sort((a,b) => a.tag.localeCompare(b.tag));
    else if (state.sort === "ja") state.filtered.sort((a,b) => a.ja.localeCompare(b.ja, "ja"));
    else state.filtered.sort((a,b) => Number(a.index) - Number(b.index));
    state.page = 0;
    renderRows();
  }
  function updateStats() {
    const stats = $$(".stats strong");
    if (stats[0]) stats[0].textContent = state.all.length.toLocaleString("ja-JP");
    if (stats[1]) stats[1].textContent = "0";
  }
  function bindControls() {
    const search = $(".searchbox input");
    search.addEventListener("input", () => { state.query = search.value.trim(); applyFilters(); });
    const selects = $$(".search-row select");
    selects[0].addEventListener("change", () => { state.classification = selects[0].selectedIndex === 1 ? "classified" : selects[0].selectedIndex === 2 ? "unclassified" : "all"; applyFilters(); });
    selects[1].addEventListener("change", () => { state.review = selects[1].selectedIndex === 1 ? "unconfirmed" : selects[1].selectedIndex === 2 ? "needs" : "all"; applyFilters(); });
    selects[2].addEventListener("change", () => { state.sort = selects[2].selectedIndex === 1 ? "tag" : selects[2].selectedIndex === 2 ? "ja" : "index"; applyFilters(); });
    $(".category-tree").addEventListener("click", event => {
      const button = event.target.closest("[data-major]");
      if (!button) return;
      state.major = button.dataset.major || "";
      state.minor = button.dataset.minor || "";
      renderCategories();
      applyFilters();
    });
    $(".categories-panel .text-button").addEventListener("click", () => { state.major = ""; state.minor = ""; renderCategories(); applyFilters(); });
    $(".search-row > .button").addEventListener("click", () => {
      search.value = ""; state.query = ""; state.major = ""; state.minor = ""; state.classification = "all"; state.review = "all"; state.sort = "index";
      selects.forEach(select => select.selectedIndex = 0);
      renderCategories(); applyFilters();
    });
    $(".pagination").addEventListener("click", event => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page += button.dataset.page === "next" ? 1 : -1;
      renderRows();
    });
  }
  async function init() {
    setMessage("CSVデータを読み込んでいます…");
    try {
      const loaded = await Promise.all(DATA_FILES.map(loadCSV));
      state.all = loaded.flat();
      updateStats();
      renderCategories();
      bindControls();
      applyFilters();
    } catch (error) {
      console.error(error);
      setMessage("CSVの読み込みに失敗しました。GitHub Pages上で開いているか、CSVファイルの配置と12列ヘッダーを確認してください。詳細: " + error.message, true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
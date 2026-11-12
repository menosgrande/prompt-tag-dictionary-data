(() => {
  "use strict";
  const DATA_FILES = [
    { url: "./dictionary-working.csv", source: "dictionary-working.csv", label: "一般" },
    { url: "./characters-working.csv", source: "characters-working.csv", label: "作品・人物" }
  ];
  const PAGE_SIZE = 100;
  const HEADERS = ["index","tag","ja","major","minor","detail","aliases_json","translation_status","ero_level","ero_review_status","classification_review_status","age_safety"];
  const state = {
    all: [], filtered: [], page: 0, major: "", minor: "", query: "",
    classification: "all", sort: "index",
    selected: new Map(), activeScreen: "dictionary-screen", columnWidths: [50,70,220,190,150,150,150,180,90,100]
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
    if (state.query) {
      const q = state.query.toLocaleLowerCase();
      if (![row.tag,row.ja,row.major,row.minor,row.detail,row.aliases_json].join(" ").toLocaleLowerCase().includes(q)) return false;
    }
    return true;
  }
  const COLUMN_WIDTHS_KEY = "ptd-dictionary-column-widths-v3";
  const COLUMN_MIN_WIDTHS = [42, 56, 100, 100, 90, 90, 90, 100, 70, 90];
  const COLUMN_MAX_WIDTH = 520;
  function applyColumnWidths() {
    $(".table-scroll-shell").style.setProperty("--tag-list-columns", state.columnWidths.map(width => width + "px").join(" "));
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
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || "null");
      if (Array.isArray(saved) && saved.length === headers.length && saved.every(Number.isFinite)) {
        state.columnWidths = saved.map((width, index) => Math.max(COLUMN_MIN_WIDTHS[index], Math.min(COLUMN_MAX_WIDTH, Math.round(width))));
      }
    } catch {}
    applyColumnWidths();
  }
  function renderRows() {
    const rows = state.filtered;
    const pageRows = rows.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
    $(".tag-results").innerHTML = pageRows.length ? pageRows.map(row => {
      const key = keyOf(row);
      let aliases = row.aliases_json || "";
      try {
        const parsed = JSON.parse(aliases);
        if (Array.isArray(parsed)) aliases = parsed.join("、");
      } catch {}
      return '<div class="tag-row" role="row" data-source="' + escapeHTML(row.source) + '">' +
        '<span class="tag-select-cell"><input type="checkbox" class="tag-select" data-key="' + escapeHTML(key) + '" aria-label="' + escapeHTML(row.tag) + 'を選択"' + (state.selected.has(key) ? ' checked' : '') + '></span>' +
        '<span class="tag-category" title="' + escapeHTML(row.index) + '">' + escapeHTML(row.index) + '</span>' +
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
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    $(".count").textContent = rows.length.toLocaleString("ja-JP") + " 件";
    $(".pagination").innerHTML = `<button class="button button-quiet" type="button" data-page="prev"${state.page === 0 ? " disabled" : ""}>前へ</button><span>${state.page + 1} / ${pages} ページ（${rows.length.toLocaleString("ja-JP")}件）</span><button class="button button-quiet" type="button" data-page="next"${state.page + 1 >= pages ? " disabled" : ""}>次へ</button>`;
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
    if ($(".builder-controls input")?.checked) {
      rows.sort((a,b) => (a.major || "").localeCompare(b.major || "", "ja") || Number(a.index) - Number(b.index));
    }
    return rows;
  }
  function renderEditor() {
    const rows = promptTags();
    const positive = $("#positive-output");
    if (positive && document.activeElement !== positive) positive.value = rows.map(row => row.tag).join(", ");
    const count = state.selected.size;
    $$(".stats strong")[1].textContent = String(count);
    const countLabel = $(".selected-dock-count");
    if (countLabel) countLabel.textContent = count + " 件選択中";
    const chips = $(".selected-dock-tags");
    if (chips) chips.innerHTML = rows.slice(0, 8).map(row => '<span class="selected-dock-chip"><span title="' + escapeHTML(row.tag) + '">' + escapeHTML(row.tag) + '</span><button class="selected-dock-remove" type="button" data-remove="' + escapeHTML(keyOf(row)) + '" aria-label="削除">×</button></span>').join("") + (count > 8 ? '<span class="selected-dock-more">+' + (count - 8) + '件</span>' : '');
    const dock = $(".selected-dock");
    if (dock) dock.hidden = count === 0;
    const copyPositive = $('[data-action="copy-positive"]');
    const savePositive = $('[data-action="save-positive"]');
    if (copyPositive) copyPositive.disabled = !positive?.value;
    if (savePositive) savePositive.disabled = !positive?.value;
  }
  function setScreen(id) {
    state.activeScreen = id;
    $$(".app-screen").forEach(screen => screen.hidden = screen.id !== id);
    $$(".screen-tab").forEach(tab => {
      const active = tab.getAttribute("href") === "#" + id;
      tab.classList.toggle("active", active);
      if (active) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
    });
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
    const search = $(".searchbox input");
    search.addEventListener("input", () => { state.query = search.value.trim(); applyFilters(); });
    const selects = $(".search-row select");
    selects[0].addEventListener("change", () => { state.classification = selects[0].selectedIndex === 1 ? "classified" : selects[0].selectedIndex === 2 ? "unclassified" : "all"; applyFilters(); });
    selects[1].addEventListener("change", () => { state.sort = selects[1].selectedIndex === 1 ? "tag" : selects[1].selectedIndex === 2 ? "ja" : "index"; applyFilters(); });
    $(".category-tree").addEventListener("click", event => {
      const button = event.target.closest("[data-major]");
      if (!button) return;
      state.major = button.dataset.major || ""; state.minor = button.dataset.minor || "";
      renderCategories(); applyFilters();
    });
    $(".categories-panel .text-button").addEventListener("click", () => { state.major = ""; state.minor = ""; renderCategories(); applyFilters(); });
    $(".search-row > .button").addEventListener("click", () => {
      search.value = ""; state.query = ""; state.major = ""; state.minor = ""; state.classification = "all"; state.sort = "index";
      selects.forEach(select => select.selectedIndex = 0); renderCategories(); applyFilters();
    });
    $(".pagination").addEventListener("click", event => {
      const button = event.target.closest("[data-page]");
      if (!button || button.disabled) return;
      state.page += button.dataset.page === "next" ? 1 : -1; renderRows();
    });
    $(".tag-results").addEventListener("change", event => {
      const input = event.target.closest(".tag-select");
      if (!input) return;
      const row = state.filtered.find(item => keyOf(item) === input.dataset.key) || state.all.find(item => keyOf(item) === input.dataset.key);
      if (!row) return;
      if (input.checked) state.selected.set(input.dataset.key, row); else state.selected.delete(input.dataset.key);
      renderEditor();
    });
    $(".screen-nav").addEventListener("click", event => {
      const tab = event.target.closest(".screen-tab");
      if (!tab) return;
      event.preventDefault(); setScreen(tab.hash.slice(1));
    });
    $(".selected-dock").addEventListener("click", event => {
      const button = event.target.closest("[data-remove]");
      if (!button) return;
      state.selected.delete(button.dataset.remove); renderRows(); renderEditor();
    });
    $(".selected-dock-actions [data-action='open-editor']").addEventListener("click", () => setScreen("editor-screen"));
    $(".editor-builder-panel .text-button").addEventListener("click", () => {
      state.selected.clear(); renderRows(); renderEditor();
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
      if (row) { addRow(row); addInput.value = ""; updateAddButton(); }
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
      $$(".stats strong")[0].textContent = state.all.length.toLocaleString("ja-JP");
      renderCategories(); setupColumnResizers(); bindControls(); applyFilters(); renderEditor();
    } catch (error) {
      console.error(error);
      setMessage("CSVの読み込みに失敗しました。GitHub Pages上で開いているか、CSVファイルの配置と12列ヘッダーを確認してください。詳細: " + error.message, true);
    }
  }
  document.addEventListener("DOMContentLoaded", init);
})();
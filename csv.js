(() => {
  "use strict";
  function parseCSV(text) {
    const input = String(text).replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i], next = input[i + 1];
      if (quoted) {
        if (ch === '"' && next === '"') { field += '"'; i++; }
        else if (ch === '"') quoted = false;
        else field += ch;
      } else if (ch === '"' && field === "") quoted = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && next === "\n") i++;
        row.push(field); field = "";
        if (row.some(value => value !== "")) rows.push(row);
        row = [];
      } else field += ch;
    }
    if (field !== "" || row.length) {
      row.push(field);
      if (row.some(value => value !== "")) rows.push(row);
    }
    if (!rows.length) return [];
    const headers = rows.shift();
    return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
  }
  window.DictionaryCSV = { parseCSV };
})();
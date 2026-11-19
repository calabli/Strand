const MAX_RECORDS = 1000;
const summary = document.getElementById("summary");
const records = document.getElementById("records");

function render(message) {
  const zh = message.lang === "zh";
  document.documentElement.lang = zh ? "zh-CN" : "en";
  const rows = new TextDecoder().decode(message.bytes).split(/\r?\n/);
  const fragment = document.createDocumentFragment();
  let count = 0;
  rows.forEach((source, index) => {
    if (!source.trim() || ++count > MAX_RECORDS) return;
    const row = document.createElement("details");
    const title = document.createElement("summary");
    const body = document.createElement("pre");
    try {
      const parsed = JSON.parse(source);
      const singleLine = JSON.stringify(parsed);
      title.textContent = `${index + 1} · ${singleLine.length > 140 ? singleLine.slice(0, 137) + "…" : singleLine}`;
      body.textContent = JSON.stringify(parsed, null, 2);
    } catch {
      row.dataset.invalid = "";
      title.textContent = `${index + 1} · ${zh ? "无效的 JSON" : "Invalid JSON"}`;
      body.textContent = source;
    }
    row.append(title, body);
    fragment.append(row);
  });
  records.replaceChildren(fragment);
  const note = count > MAX_RECORDS ? (zh ? `，显示前 ${MAX_RECORDS} 条` : `, first ${MAX_RECORDS} shown`) : "";
  summary.textContent = zh ? `${message.name} · ${count} 条${note}` : `${message.name} · ${count} records${note}`;
}

window.addEventListener("message", ({ source, data }) => {
  if (source !== parent || !data) return;
  if (data.type === "strand:file" || data.type === "strand:theme") document.documentElement.dataset.theme = data.theme;
  if (data.type === "strand:file" && data.bytes instanceof ArrayBuffer) render(data);
});
parent.postMessage({ type: "strand:ready" }, "*");

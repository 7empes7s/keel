// Reads one "Technical details" field out of rendered markup by the label the page
// passes (data-field), so tests check the stored value without depending on the
// plain label or the panel's layout.
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The <dd> content of every field whose label is `label`, or ends with it. */
export function recordValues(html: string, label: string, { endsWith = false } = {}): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`data-field="${endsWith ? "[^\"]*" : ""}${escapeAttribute(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
  for (const match of html.matchAll(pattern)) {
    const start = html.indexOf("<dd>", match.index);
    const end = html.indexOf("</dd>", start);
    if (start >= 0 && end > start) values.push(html.slice(start + 4, end));
  }
  return values;
}

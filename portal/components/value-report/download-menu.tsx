"use client";

import { Icon } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { useLiveSearchParams } from "@/lib/use-view-state";

// The value report's one Download menu: a spreadsheet (.csv), an Excel workbook
// (.xlsx), a PDF through the browser's print dialog, or the data file for tools
// (.json). Every file covers the period and owner the page shows. Outlined, not amber.
export function DownloadMenu() {
  const params = useLiveSearchParams();
  const file = (format: string) => {
    const query = new URLSearchParams();
    const period = params?.get("period");
    const entity = params?.get("entity");
    if (period) query.set("period", period);
    if (entity) query.set("entity", entity);
    query.set("format", format);
    return `/api/reports/value?${query.toString()}`;
  };
  return (
    <Popover
      button={<><Icon name="save" />Download<Icon className="picker-chevron" name="chevron-down" /></>}
      buttonClassName="btn vr-download"
      label="Download this report"
      panelClassName="vr-download-panel"
      title="Download this report"
    >
      {(close) => (
        <ul className="vr-download-list">
          <li><a download href={file("csv")} onClick={() => close()}><Icon name="page" /><span><b>Spreadsheet (.csv)</b><small>Every count, request and check</small></span></a></li>
          <li><a download href={file("xlsx")} onClick={() => close()}><Icon name="page" /><span><b>Excel workbook (.xlsx)</b><small>One sheet each for the summary, requests, checks and time saved</small></span></a></li>
          <li><button onClick={() => { close(); setTimeout(() => window.print(), 0); }} type="button"><Icon name="page" /><span><b>PDF</b><small>Opens the print dialog: choose Save as PDF</small></span></button></li>
          <li><a download href={file("json")} onClick={() => close()}><Icon name="page" /><span><b>Data file for tools (.json)</b><small>With the counting rules and the report digest</small></span></a></li>
        </ul>
      )}
    </Popover>
  );
}

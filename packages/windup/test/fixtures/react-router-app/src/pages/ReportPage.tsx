export function ReportPage({ kind }: { kind: string }) {
  return (
    <div>
      <button id="export-report" data-testid="report-export">Export</button>
      <input name="period" data-testid="report-period" />
    </div>
  );
}

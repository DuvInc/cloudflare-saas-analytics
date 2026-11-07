/** Label and value pairs in a sheet or a panel. */
export function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="flex flex-col gap-3 text-sm sm:grid sm:grid-cols-[minmax(7rem,auto)_1fr] sm:gap-x-4 sm:gap-y-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 sm:contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v ?? "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

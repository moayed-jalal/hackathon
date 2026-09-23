export function CodeBlock({ title, children }: { title?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-[#0b1220] shadow-lg">
      {title && (
        <div className="flex items-center gap-1.5 border-b border-slate-800 px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-rose-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/70" />
          <span className="ml-2 font-mono text-[11px] text-slate-400">{title}</span>
        </div>
      )}
      <pre className="overflow-x-auto px-4 py-4 text-[12.5px] leading-relaxed text-slate-200">
        <code>{children}</code>
      </pre>
    </div>
  );
}

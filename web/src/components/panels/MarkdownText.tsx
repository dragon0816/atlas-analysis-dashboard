import { Fragment, createElement, type ReactNode } from "react";

/** Small, safe Markdown subset: text is always escaped and raw HTML is never interpreted. */
export function MarkdownText({ text }: { text: string }) {
  const inline = (value: string): ReactNode[] => value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-slate-800 px-1 text-sky-200">{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link && (/^https?:\/\//i.test(link[2]) || /^mailto:/i.test(link[2]) || /^\/(?!\/)/.test(link[2]))) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
  const lines = text.split("\n"), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const code: string[] = []; const key = i;
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      blocks.push(<pre key={key} className="overflow-auto rounded bg-slate-950 p-2 text-xs"><code>{code.join("\n")}</code></pre>);
    } else if (/^#{1,6}\s/.test(line)) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)!;
      blocks.push(createElement(`h${heading[1].length}`, { key: i, className: "font-semibold text-slate-100" }, inline(heading[2])));
    } else if (/^\s*[-*]\s/.test(line)) blocks.push(<div key={i} className="flex gap-2"><span aria-hidden>•</span><span>{inline(line.replace(/^\s*[-*]\s+/, ""))}</span></div>);
    else if (!line.trim()) blocks.push(<div key={i} className="h-2" />);
    else blocks.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="space-y-1">{blocks}</div>;
}

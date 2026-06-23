/**
 * Minimal, dependency-free Markdown renderer for assistant replies (Phase X.M).
 *
 * Supports the subset Claude uses in short answers: headings, bold, italic,
 * inline code, fenced code blocks, and unordered / ordered lists. HTML is escaped
 * FIRST (the model output is untrusted), then a small set of inline/blocks rules
 * is applied — so there is no XSS surface despite using dangerouslySetInnerHTML.
 * We deliberately avoid pulling in react-markdown + remark for a demo widget.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // Order matters: protect inline code first, then bold, then italic, then links.
  return s
    .replace(/`([^`]+)`/g, '<code class="rounded bg-secondary px-1 py-0.5 text-[0.85em]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer" class="underline">$1</a>',
    );
}

function toHtml(src: string): string {
  const lines = escapeHtml(src).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    if (line.trim().startsWith("```")) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++; // skip closing fence
      out.push(
        `<pre class="overflow-x-auto rounded-md bg-secondary p-2 text-[0.8rem]"><code>${buf.join("\n")}</code></pre>`,
      );
      continue;
    }

    // Headings
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1]!.length;
      const size = level === 1 ? "text-sm" : "text-[0.8rem]";
      out.push(`<p class="mt-1 mb-0.5 font-semibold ${size}">${inline(h[2]!)}</p>`);
      i++;
      continue;
    }

    // Unordered list item
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        out.push('<ul class="ml-4 list-disc space-y-0.5">');
        listType = "ul";
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      i++;
      continue;
    }

    // Ordered list item
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (listType !== "ol") {
        closeList();
        out.push('<ol class="ml-4 list-decimal space-y-0.5">');
        listType = "ol";
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // Paragraph
    closeList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeList();
  return out.join("");
}

export function Markdown({ text }: { text: string }) {
  return (
    <div
      className="space-y-1.5 text-sm leading-relaxed [&_a]:text-primary [&_li]:leading-relaxed"
      dangerouslySetInnerHTML={{ __html: toHtml(text) }}
    />
  );
}

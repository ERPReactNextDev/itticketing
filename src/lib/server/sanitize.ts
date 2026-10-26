/**
 * Minimal, dependency-free HTML sanitiser for inbound email bodies.
 *
 * Inbound mail is untrusted input that will later be rendered in the ticket
 * timeline, so it must be stripped of anything executable: script/style/iframe
 * tags, event handlers, javascript: and data: URLs, and object/embed/form.
 *
 * This is intentionally allowlist-based. If a tag is not on the list it is
 * removed along with its contents for dangerous tags, or unwrapped for merely
 * unknown ones (so the readable text survives).
 */

const DANGEROUS_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
  "svg",
  "math",
]);

/** Tags whose text content is kept but the tag itself is dropped. */
const STRIP_WITH_CONTENT = DANGEROUS_TAGS;

const ALLOWED_TAGS = new Set([
  "a", "b", "strong", "i", "em", "u", "s", "strike",
  "p", "br", "hr", "div", "span",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "img",
  "figure", "figcaption",
]);

function stripDangerousBlocks(html: string): string {
  let out = html;
  for (const tag of STRIP_WITH_CONTENT) {
    // Paired tags with content.
    out = out.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      "",
    );
    // Self-closing / unclosed.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), "");
  }
  return out;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

/** Removes on* handlers, javascript:/data: URLs and srcdoc from attributes. */
function scrubAttributes(tagText: string): string {
  return tagText
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*(?:javascript|data|vbscript):[^"]*"|'\s*(?:javascript|data|vbscript):[^']*'|(?:javascript|data|vbscript):[^\s>]*)/gi, '$1="#"')
    .replace(/\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

function sanitizeTags(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g,
    (match, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) return "";
      if (match.startsWith("</")) return `</${name}>`;

      const scrubbed = scrubAttributes(attrs);
      // Void elements have no closing tag.
      const isVoid = ["br", "hr", "img"].includes(name);
      return isVoid
        ? `<${name}${scrubbed}>`
        : `<${name}${scrubbed}>`;
    },
  );
}

/** Sanitises an HTML body. Returns markup safe to inject. */
export function sanitizeHtml(input: string): string {
  if (!input) return "";
  let html = String(input);
  html = stripComments(html);
  html = stripDangerousBlocks(html);
  html = sanitizeTags(html);
  // Any leftover angle brackets that did not form a known tag.
  return html
    .replace(/<(?![a-zA-Z/])/g, "&lt;")
    .trim();
}

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&hellip;": "...",
  "&mdash;": "-",
  "&ndash;": "-",
};

/**
 * Converts an HTML body to a plain-text fallback.
 *
 * Block-level tags become newlines so the ticket description and the email
 * timeline both render readably even when the HTML part is dropped.
 */
export function htmlToText(input: string): string {
  if (!input) return "";
  let text = String(input);

  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  text = text.replace(/<\s*br\s*\/?\s*>/gi, "\n");
  text = text.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, "\n");
  text = text.replace(/<\s*\/\s*(td|th)\s*>/gi, "\t");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/gi, " ");

  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text.replace(/&#(\d+);/g, (_m, code: string) => {
    const num = Number(code);
    return Number.isFinite(num) ? String.fromCharCode(num) : "";
  });

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Normalises an inbound body: keeps the plain text as the source of truth and
 * sanitises the HTML part.
 */
export function normalizeInboundBody(input: {
  text?: string | null;
  html?: string | null;
}): { textBody: string; htmlBody: string } {
  const textBody = (input.text ?? "").replace(/\r\n/g, "\n").trim();
  const htmlBody = sanitizeHtml(input.html ?? "");
  if (textBody) return { textBody, htmlBody };
  // HTML-only mail: derive the text so the ticket is never empty.
  return { textBody: htmlToText(htmlBody), htmlBody };
}

/** Clamps free-text fields coming from untrusted input. */
export function clamp(value: string, max: number): string {
  return String(value ?? "").slice(0, max);
}

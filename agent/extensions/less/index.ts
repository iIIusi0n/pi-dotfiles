import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  SessionEntry,
  Theme,
  ToolExecutionOptions,
} from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";

/**
 * /less — view the current session in a read-only, less-style pager.
 *
 * A full-screen overlay renders the session transcript using pi's own
 * chat components (user/assistant messages, tool executions, bash
 * executions, compaction summaries, custom messages), so the pager
 * looks exactly like the normal session view. It never mutates the
 * session.
 *
 * Keys (a subset of Unix less):
 *   q / Esc / Ctrl+C   quit pager
 *   j / Ctrl+N, down    scroll down one line
 *   k / Ctrl+P, up      scroll up one line
 *   d / Ctrl+D, PgDn    scroll half a page down
 *   u / Ctrl+U, PgUp    scroll half a page up
 *   f / Space / Ctrl+F  scroll a full page down
 *   b / Ctrl+B          scroll a full page up
 *   g / Home            jump to top
 *   G / End              jump to bottom
 *   /pattern             search forward (Enter, Esc to cancel)
 *   ?pattern             search backward
 *   n / N               next / previous match
 */

interface CacheLine {
  /** Final styled visible line. */
  line: string;
  /** Plain text of the line, used for search matching. */
  search: string;
}

/** Cap long tool output in the pager. */
const MAX_OUTPUT_CHARS = 8000;

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return (
    text.slice(0, MAX_OUTPUT_CHARS) +
    `\n… (${text.length - MAX_OUTPUT_CHARS} more chars truncated)`
  );
}

function pushComponentLines(components: Component[], width: number, out: CacheLine[]): void {
  for (const c of components) {
    if (components.indexOf(c) > 0) out.push({ line: "", search: "" });
    for (const l of c.render(width)) {
      out.push({ line: l, search: stripTerminalSequences(l) });
    }
  }
}

/**
 * Build the transcript with pi's own session renderers, mirroring the
 * interactive mode's renderSessionItems() replay logic.
 */
function buildComponents(
  branch: SessionEntry[],
  tui: TUI,
  cwd: string,
  toolOutputExpanded: boolean,
): Component[] {
  const mdTheme = getMarkdownTheme();
  const outputPad = 1;
  const components: Component[] = [];
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const toolOptions: ToolExecutionOptions | undefined = {
    showImages: false,
    imageWidthCells: 48,
  };

  const add = (c: Component) => {
    components.push(c);
  };

  for (const entry of branch) {
    if (entry.type !== "message") {
      if (entry.type === "compaction") {
        add(new CompactionSummaryMessageComponent(
          {
            role: "compactionSummary",
            summary: entry.summary,
            tokensBefore: entry.tokensBefore,
            timestamp: Date.parse(entry.timestamp) || 0,
          },
          mdTheme,
        ));
      } else if (entry.type === "branch_summary") {
        add(new BranchSummaryMessageComponent(
          {
            role: "branchSummary",
            summary: entry.summary,
            fromId: entry.fromId,
            timestamp: Date.parse(entry.timestamp) || 0,
          },
          mdTheme,
        ));
      } else if (entry.type === "custom_message" && entry.display) {
        add(new CustomMessageComponent(
          {
            role: "custom",
            customType: entry.customType,
            content: entry.content,
            display: entry.display,
            details: entry.details,
            timestamp: Date.parse(entry.timestamp) || 0,
          },
          undefined,
          mdTheme,
          outputPad,
        ));
      }
      continue;
    }

    const message = entry.message;
    switch (message.role) {
      case "bashExecution": {
        const component = new BashExecutionComponent(
          message.command,
          tui,
          message.excludeFromContext,
        );
        const output = message.output ?? "";
        const capped = capOutput(output);
        if (capped) component.appendOutput(capped);
        component.setComplete(
          message.exitCode,
          message.cancelled,
          message.truncated
            ? {
                content: capped,
                truncated: true,
                truncatedBy: "bytes",
                totalLines: output.split("\n").length,
                totalBytes: output.length,
                outputLines: capped.split("\n").length,
                outputBytes: capped.length,
                lastLinePartial: false,
                firstLineExceedsLimit: false,
                maxLines: Infinity,
                maxBytes: MAX_OUTPUT_CHARS,
              }
            : undefined,
          message.fullOutputPath,
        );
        add(component);
        break;
      }
      case "user": {
        const content = message.content;
        const text =
          typeof content === "string"
            ? content
            : content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("\n");
        if (text.trim()) {
          const skillBlock = parseSkillBlock(text);
          if (skillBlock) {
            add(new SkillInvocationMessageComponent(skillBlock, mdTheme));
            if (skillBlock.userMessage) {
              add(new UserMessageComponent(skillBlock.userMessage, mdTheme, outputPad));
            }
          } else {
            add(new UserMessageComponent(text, mdTheme, outputPad));
          }
        }
        break;
      }
      case "assistant": {
        add(new AssistantMessageComponent(
          message,
          false, // hideThinkingBlock
          mdTheme,
          undefined, // hiddenThinkingLabel: default
          outputPad,
        ));
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const component = new ToolExecutionComponent(
            content.name,
            content.id,
            content.arguments,
            toolOptions,
            undefined, // tool definition: fall back to generic rendering
            tui,
            cwd,
          );
          component.setExpanded(toolOutputExpanded);
          add(component);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            component.updateResult({
              content: [{ type: "text", text: message.errorMessage || "Error" }],
              isError: true,
            });
          } else {
            pendingTools.set(content.id, component);
          }
        }
        break;
      }
      case "toolResult": {
        const component = pendingTools.get(message.toolCallId);
        if (component) {
          component.updateResult({
            content: message.content.map((c) =>
              c.type === "text" ? { ...c, text: capOutput(c.text) } : c,
            ),
            isError: message.isError,
            details: message.details,
          });
          pendingTools.delete(message.toolCallId);
        }
        break;
      }
      default:
        break;
    }
  }

  // Unmatched tool calls (interrupted runs): already added, nothing to do
  pendingTools.clear();

  return components;
}

interface Cache {
  width: number;
  lines: CacheLine[];
  /** Line indices matching the current query; only valid when query is set. */
  matches: number[];
  query: string;
}

export class LessPager implements Component {
  focused = false;
  private top = 0;
  private query = "";
  private curMatch: number | null = null;
  private searchFailed = false;
  private searching = false;
  private searchBuf = "";
  private searchDir = 1;
  private cache: Cache | null = null;
  private closed = false;
  private lastWidth = 80;
  private components: Component[] = [];

  constructor(
    private tui: TUI,
    private theme: Theme,
    private branch: SessionEntry[],
    private cwd: string,
    private toolOutputExpanded: boolean,
    private title: string,
    private done: () => void,
  ) {}

  private viewHeight(): number {
    // title line + status line
    return Math.max(4, this.tui.terminal.rows - 2);
  }

  private build(width: number): CacheLine[] {
    const out: CacheLine[] = [];
    if (this.components.length === 0) {
      this.components = buildComponents(this.branch, this.tui, this.cwd, this.toolOutputExpanded);
    }
    pushComponentLines(this.components, width, out);
    if (out.length === 0) out.push({ line: "(empty session)", search: "(empty session)" });
    return out;
  }

  private getCache(width: number): Cache {
    if (this.cache && this.cache.width === width && this.cache.query === this.query) return this.cache;
    const lines = this.build(width);
    const matches =
      this.query === ""
        ? []
        : lines
            .map((l, i) => (l.search.toLowerCase().includes(this.query.toLowerCase()) ? i : -1))
            .filter((i) => i >= 0);
    this.cache = { width, lines, matches, query: this.query };
    return this.cache;
  }

  /** Scroll so line idx is visible. */
  private scrollTo(idx: number): void {
    const view = this.viewHeight();
    if (idx < this.top) this.top = idx;
    else if (idx >= this.top + view) this.top = idx - view + 1;
    this.top = Math.max(0, this.top);
    this.tui.requestRender();
  }

  private findMatch(): void {
    const { matches } = this.getCache(this.lastWidth);
    this.searchFailed = matches.length === 0;
    if (matches.length === 0) {
      this.curMatch = null;
      return;
    }
    const view = this.viewHeight();
    let idx: number;
    if (this.searchDir > 0) {
      // /: first match at or below the top of the view, else first overall
      idx = (matches.find((i) => i >= this.top) ?? matches[0]) as number;
    } else {
      // ?: last match at or above the bottom of the view, else last overall
      idx = matches.findLast((i) => i <= this.top + view - 1) ?? (matches[matches.length - 1] as number);
    }
    this.curMatch = idx;
    this.scrollTo(idx);
  }

  private stepMatch(dir: 1 | -1): void {
    const { matches } = this.getCache(this.lastWidth);
    this.searchFailed = matches.length === 0;
    if (matches.length === 0) {
      this.curMatch = null;
      return;
    }
    const from = this.curMatch ?? (dir > 0 ? this.top : this.top + this.viewHeight() - 1);
    let idx: number | undefined =
      dir > 0 ? matches.find((i) => i > from) : matches.findLast((i) => i < from);
    if (idx === undefined) idx = dir > 0 ? matches[0] : (matches[matches.length - 1] as number);
    this.curMatch = idx;
    this.scrollTo(idx);
  }

  handleInput(data: string): void {
    if (this.closed) return;

    // Search prompt mode
    if (this.searching) {
      if (matchesKey(data, "escape")) {
        this.searching = false;
      } else if (matchesKey(data, "return")) {
        this.searching = false;
        this.query = this.searchBuf;
        this.findMatch();
      } else if (matchesKey(data, "backspace")) {
        this.searchBuf = this.searchBuf.slice(0, -1);
      } else if (data.length === 1 && data >= " " && data !== "\x1b") {
        this.searchBuf += data;
      } else {
        return;
      }
      this.tui.requestRender();
      return;
    }

    const quit = () => {
      if (this.closed) return;
      this.closed = true;
      this.done();
    };

    // Quit: q / Esc / Ctrl+C
    if (
      data === "q" ||
      data === "Q" ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "\x03"
    ) {
      quit();
      return;
    }

    const view = this.viewHeight();
    const total = this.getCache(this.lastWidth).lines.length;

    if (
      data === "j" ||
      data === "J" ||
      matchesKey(data, "down") ||
      matchesKey(data, "ctrl+n")
    ) {
      this.top = Math.min(this.top + 1, Math.max(0, total - 1));
    } else if (
      data === "k" ||
      data === "K" ||
      matchesKey(data, "up") ||
      matchesKey(data, "ctrl+p")
    ) {
      this.top = Math.max(this.top - 1, 0);
    } else if (data === "d" || matchesKey(data, "ctrl+d") || matchesKey(data, "pageDown")) {
      this.top = Math.min(this.top + Math.floor(view / 2), Math.max(0, total - 1));
    } else if (data === "u" || matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp")) {
      this.top = Math.max(this.top - Math.floor(view / 2), 0);
    } else if (data === "f" || matchesKey(data, "space") || matchesKey(data, "ctrl+f")) {
      this.top = Math.min(this.top + view, Math.max(0, total - 1));
    } else if (data === "b" || matchesKey(data, "ctrl+b")) {
      this.top = Math.max(this.top - view, 0);
    } else if (data === "g" || matchesKey(data, "home")) {
      this.top = 0;
    } else if (data === "G" || matchesKey(data, "end")) {
      this.top = Math.max(0, total - 1);
    } else if (data === "/" || data === "?") {
      this.searching = true;
      this.searchBuf = "";
      this.searchDir = data === "/" ? 1 : -1;
    } else if (data === "n") {
      if (this.query) this.stepMatch(1);
    } else if (data === "N") {
      if (this.query) this.stepMatch(-1);
    } else {
      return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Apply search decoration to a cached line. */
  private decorate(line: CacheLine, idx: number, matches: number[]): string {
    if (!this.query || !matches.includes(idx)) return line.line;
    const styled = line.line;
    const plain = line.search;
    // Map each plain-text char to its offset in the styled string (ANSI codes
    // shift offsets, so a query cannot be located by scanning the styled line)
    const map: number[] = new Array(plain.length);
    let si = 0;
    for (let pi = 0; pi < plain.length; pi++) {
      while (si < styled.length && styled.charCodeAt(si) === 0x1b) {
        const m = styled.indexOf("m", si + 1);
        const b = styled.indexOf("\x07", si + 1);
        const end = m < 0 ? b : b < 0 ? m : Math.min(m, b);
        if (end < 0) {
          si = styled.length;
          break;
        }
        si = end + 1;
      }
      map[pi] = si++;
    }
    const isCurrent = idx === this.curMatch;
    const lower = plain.toLowerCase();
    const ql = this.query.toLowerCase();
    let out = "";
    let prev = 0;
    let pi = 0;
    for (;;) {
      const at = lower.indexOf(ql, pi);
      if (at < 0) {
        out += styled.slice(prev);
        break;
      }
      const sStart = map[at];
      const sEnd =
        at + this.query.length - 1 < plain.length
          ? map[at + this.query.length - 1] + 1
          : sStart;
      const piece = styled.slice(sStart, sEnd);
      const highlighted = this.theme.fg("searchMatchText", this.theme.underline(piece));
      out += styled.slice(prev, sStart);
      out += isCurrent ? this.theme.inverse(highlighted) : highlighted;
      prev = sEnd;
      pi = at + ql.length;
    }
    return out;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const cache = this.getCache(width);
    const { lines, matches } = cache;
    const view = this.viewHeight();
    const total = lines.length;
    this.top = Math.max(0, Math.min(this.top, total - 1));

    const out: string[] = [];

    // Top bar
    out.push(this.theme.fg("dim", `──  /less  ${this.title}  ──  read-only  ──`));

    // Viewport
    let end = this.top;
    for (; end < Math.min(total, this.top + view); end++) {
      out.push(this.decorate(lines[end], end, matches));
    }
    while (out.length < view + 1) out.push("");

    // Bottom line: search prompt or status bar
    if (this.searching) {
      out.push(this.theme.bold(`/${this.searchBuf}`));
    } else {
      const endLine = Math.min(total, this.top + view);
      const pct = total <= 1 ? 100 : Math.round(((this.top + 1) / total) * 100);
      const pos = this.top === 0 ? "TOP" : endLine >= total ? "BOT" : `${pct}%`;
      const seg = [pos, `${this.top + 1}–${endLine}/${total}`];
      if (this.query) {
        const count = matches.length;
        const here =
          this.curMatch !== null && matches.includes(this.curMatch)
            ? matches.indexOf(this.curMatch) + 1
            : 0;
        seg.push(count === 0 ? `/${this.query} 0/0 (no match)` : `/${this.query} ${here}/${count}`);
      }
      const help = " q:quit  j/k:scroll  d/u:half-page  space/b:page  g/G:top/bot  /?:search  n/N:match";
      out.push(truncateToWidth(this.theme.fg("dim", seg.join(" · ") + help), width, ""));
    }

    return out;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("less", {
    description: "View the session transcript in a read-only less-style pager (q or Ctrl+C to quit)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/less requires interactive mode", "error");
        return;
      }
      const branch = ctx.sessionManager.getBranch();
      const cwd = ctx.cwd;
      const expanded = ctx.ui.getToolsExpanded();
      const title = ctx.sessionManager.getSessionName() || ctx.sessionManager.getSessionId().slice(0, 8);
      let done: (result: undefined) => void = () => {};
      await ctx.ui.custom(
        (tui, theme, _keybindings, d) => {
          done = d;
          return new LessPager(tui, theme, branch, cwd, expanded, title, () => done(undefined));
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            row: 0,
            col: 0,
            width: "100%",
            maxHeight: "100%",
          },
        },
      );
    },
  });
}

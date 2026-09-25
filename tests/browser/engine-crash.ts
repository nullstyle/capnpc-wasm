// Engine crashes in the browser suite (test.ts): a page whose content process
// died, or a browser that disconnected before the driver closed it. A crash is
// not a stall, so the stall budget (soak-stalls.ts) does not cover it; the run
// fails with the evidence the driver still holds once the page is gone: the
// step, the soak cycle, the last trace events of the page's workers that
// reached the driver, and on macOS the newest crash report the engine's
// processes left in ~/Library/Logs/DiagnosticReports.

/** A crash as the driver saw it. */
export interface EngineCrash {
  /** What happened, e.g. "the main page crashed" or "the browser disconnected". */
  event: string;
  /** The step the driver was on (deadline.ts labels). */
  step: string;
  /** The recovery soak's cycle, when the crash came during the soak. */
  cycle: number | null;
  /** The page whose worker trace to report. */
  page: string;
}

/**
 * Worker trace events mirrored from the pages to the driver as they happen
 * (the pages call capnpTraceSink), so a trace outlives a crashed page.
 */
export class TraceMirror {
  #pages = new Map<string, string[][]>();

  record(page: string, worker: number, event: string): void {
    let workers = this.#pages.get(page);
    if (!workers) this.#pages.set(page, workers = []);
    const events = workers[worker] ??= [];
    events.push(event);
    if (events.length > 60) events.splice(0, 20);
  }

  /** The page's most recently created worker that reported anything. */
  last(page: string): { worker: number; events: string[] } | null {
    const workers = this.#pages.get(page) ?? [];
    for (let worker = workers.length - 1; worker >= 0; worker--) {
      if (workers[worker]?.length) {
        return { worker, events: [...workers[worker]] };
      }
    }
    return null;
  }
}

/** Whether Playwright's error says the page, its context or the browser is gone. */
export function closedTargetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Target (page, context or browser has been closed|crashed)|Browser has been closed|Page crashed/i
    .test(message);
}

/** Crash report names by engine: the process names the engines run under. */
const reportNames: Record<string, RegExp> = {
  webkit: /^(com\.apple\.WebKit\.|Playwright|MiniBrowser)/,
  chromium:
    /^(Chromium|Google Chrome|chrome|chrome-headless-shell|headless_shell)/i,
  firefox: /^(firefox|plugin-container|Nightly)/i,
};

/** Where macOS writes crash reports; null on other systems. */
export function crashReportDirectory(
  os: string = Deno.build.os,
  home: string | undefined = Deno.env.get("HOME"),
): string | null {
  return os === "darwin" && home
    ? `${home}/Library/Logs/DiagnosticReports`
    : null;
}

/** A crash report file: its name and modification time (ms since the epoch). */
export interface ReportEntry {
  name: string;
  time: number;
}

/** The files in a crash report directory; throws if it cannot be read. */
async function listReports(directory: string): Promise<ReportEntry[]> {
  const entries: ReportEntry[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (!entry.isFile) continue;
    const stat = await Deno.stat(`${directory}/${entry.name}`);
    entries.push({ name: entry.name, time: stat.mtime?.getTime() ?? 0 });
  }
  return entries;
}

/**
 * The newest crash report of the engine's processes written at or after
 * `since` (ms since the epoch). The system writes a report some seconds after
 * the process died, so this waits up to `waitMs` for one to appear.
 */
export async function latestCrashReport(
  engine: string,
  since: number,
  {
    directory = crashReportDirectory(),
    waitMs = 10_000,
    pollMs = 500,
    list = listReports,
  }: {
    directory?: string | null;
    waitMs?: number;
    pollMs?: number;
    list?: (directory: string) => Promise<ReportEntry[]>;
  } = {},
): Promise<string | null> {
  const names = reportNames[engine];
  if (directory === null || !names) return null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let entries: ReportEntry[];
    try {
      entries = await list(directory);
    } catch {
      return null;
    }
    const newest = entries
      .filter((entry) => names.test(entry.name) && entry.time >= since)
      .sort((a, b) => b.time - a.time)[0];
    if (newest) return `${directory}/${newest.name}`;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * One line from a macOS crash report (.ips: a JSON header line, then a JSON
 * body): the process, the exception and signal, and the top frames of the
 * thread that crashed.
 */
export function summarizeCrashReport(text: string): string {
  type Frame = { imageIndex?: number; symbol?: string; imageOffset?: number };
  type Thread = {
    triggered?: boolean;
    name?: string;
    queue?: string;
    frames?: Frame[];
  };
  let header: { app_name?: string };
  let body: {
    procName?: string;
    exception?: { type?: string; signal?: string; subtype?: string };
    termination?: { namespace?: string; indicator?: string };
    faultingThread?: number;
    threads?: Thread[];
    usedImages?: { name?: string }[];
  };
  try {
    const newline = text.indexOf("\n");
    header = JSON.parse(text.slice(0, newline));
    body = JSON.parse(text.slice(newline + 1));
  } catch {
    return "an unreadable crash report";
  }
  const exception = [
    body.exception?.type,
    body.exception?.signal,
    body.exception?.subtype,
  ].filter(Boolean).join(" ");
  const termination = [body.termination?.namespace, body.termination?.indicator]
    .filter(Boolean).join(" ");
  const threads = body.threads ?? [];
  const thread = threads.find((candidate) => candidate.triggered) ??
    threads[body.faultingThread ?? 0];
  const frames = (thread?.frames ?? []).slice(0, 8).map((frame) =>
    `${body.usedImages?.[frame.imageIndex ?? -1]?.name ?? "?"}!${
      frame.symbol ?? `+${frame.imageOffset}`
    }`
  );
  return `${body.procName ?? header.app_name ?? "?"}: ${
    exception || "no exception"
  }${termination ? ` (${termination})` : ""}; ${
    thread?.name ?? thread?.queue ?? "the crashed thread"
  }: ${frames.join(" < ") || "no frames"}`;
}

function place(crash: EngineCrash): string {
  return `${crash.step}${
    crash.cycle === null ? "" : ` (soak cycle ${crash.cycle})`
  }`;
}

/** The OBSERVED line for a crash, with its evidence. */
export function crashObservation(
  engine: string,
  crash: EngineCrash,
  trace: { worker: number; events: string[] } | null,
  report: string | null,
  directory: string | null = crashReportDirectory(),
): string {
  return `OBSERVED ${engine} engine crash: ${crash.event} during ${
    place(crash)
  }; the last worker trace that reached the driver (${
    trace === null ? "none" : `${crash.page} page, worker ${trace.worker}`
  }): ${JSON.stringify(trace?.events ?? [])}; crash report: ${
    report ?? (directory === null
      ? "not collected on this system"
      : `none written to ${directory} since the run started`)
  }`;
}

/** The failure message: an engine crash, which the stall budget does not cover. */
export function crashFailure(engine: string, crash: EngineCrash): string {
  return `${engine}: engine crash: ${crash.event} during ${
    place(crash)
  }; a crash is not a stall, and the stall budget does not cover it`;
}

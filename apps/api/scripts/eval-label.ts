/**
 * Label eval cases by hand (no Meta calls):
 *   pnpm eval-label              # walk the draft cases, then the unlabelled site photos in samples/
 *   pnpm eval-label --no-open    # don't open photos in the image viewer
 *
 * 1. Each draft case in samples/eval/cases.json: the photo opens, the draft labels are shown, and you
 *    [c] confirm, [e] edit field by field, or [s] skip.
 * 2. Each real site photo in samples/ that no case uses yet (stock images like images(3).jpg are skipped):
 *    which BOQ, then one question per BOQ item (stage, cast columns visible, plinth beams, walls + material),
 *    false positives present, notes.
 * Confirmed and new cases get labelled_by: "human"; everything else stays "draft". The file is saved after every
 * case, so [q] or Ctrl+C loses nothing. Only human-labelled cases count in the eval's headline numbers.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseCases } from "./eval-lib.js";
import { labelPhoto, reviewDraft, unlabelledPhotos, type BoqItemLite, type LabelIO, type RawCases } from "./eval-label-lib.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { cases: { type: "string", default: "samples/eval/cases.json" }, "no-open": { type: "boolean", default: false } },
});
const casesPath = join(repoRoot, args.cases!);

const BOQS = [
  { key: "d", path: "samples/boq-demo.json" },
  { key: "r", path: "samples/boq-demo-residence.json" },
].map((b) => ({ ...b, items: (JSON.parse(readFileSync(join(repoRoot, b.path), "utf8")) as { items: BoqItemLite[] }).items }));

const raw = JSON.parse(readFileSync(casesPath, "utf8")) as RawCases;
for (const c of raw.cases) c.labelled_by ??= "draft";
function save() {
  parseCases(JSON.stringify(raw)); // never write a file the eval can't read
  writeFileSync(casesPath, `${JSON.stringify(raw, null, 2)}\n`);
}
save();

const io = terminalIO(!args["no-open"]);
let quit = false;

const drafts = raw.cases.filter((c) => c.kind === "photos" && c.labelled_by !== "human");
io.print(`${drafts.length} draft photo case(s) to review, then the unlabelled photos. Saved after every case.`);
for (const c of drafts) {
  const r = await reviewDraft(c, io);
  if (r === "quit") {
    quit = true;
    break;
  }
  if (r) {
    raw.cases[raw.cases.indexOf(c)] = r;
    save();
    io.print("  saved (labelled_by: human)");
  } else io.print("  skipped (stays draft)");
}

if (!quit) {
  const photos = unlabelledPhotos(repoRoot, parseCases(JSON.stringify(raw)));
  io.print(`\n${photos.length} unlabelled site photo(s) in samples/.`);
  for (const photo of photos) {
    const ids = new Set(raw.cases.map((c) => String(c.id)));
    const r = await labelPhoto(photo, BOQS, ids, io);
    if (r === "quit") break;
    if (r) {
      raw.cases.push(r);
      save();
      io.print(`  saved as ${String(r.id)} (labelled_by: human)`);
    } else io.print("  skipped");
  }
}

const human = raw.cases.filter((c) => c.labelled_by === "human").length;
io.print(`\nDone: ${human} human-labelled case(s), ${raw.cases.length - human} draft. File: ${args.cases}`);
process.exit(0);

function terminalIO(openPhotos: boolean): LabelIO {
  const tty = process.stdin.isTTY;
  if (tty) emitKeypressEvents(process.stdin);
  // Piped input (tests, scripts): one shared reader, or the first question would swallow every buffered line.
  const queue: string[] = [];
  const waiting: ((l: string) => void)[] = [];
  let ended = false;
  if (!tty) {
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : queue.push(l)));
    rl.on("close", () => {
      ended = true;
      while (waiting.length) waiting.shift()!("q");
    });
  }
  const nextPiped = () => new Promise<string>((done) => (queue.length ? done(queue.shift()!) : ended ? done("q") : waiting.push(done)));
  const line = async (prompt: string, def?: string) => {
    let answer: string;
    if (tty) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      answer = await rl.question(prompt);
      rl.close();
    } else {
      process.stdout.write(prompt);
      answer = await nextPiped();
      process.stdout.write(`${answer}
`);
    }
    return answer === "" && def !== undefined ? def : answer;
  };
  return {
    print: (t) => console.log(t),
    line,
    async key(prompt, choices) {
      if (!tty) {
        for (;;) {
          const a = (await line(`${prompt} `)).trim().toLowerCase();
          if (choices.includes(a) || (a === "" && choices.includes(""))) return a;
          if (a && choices.includes(a[0]!)) return a[0]!;
        }
      }
      process.stdout.write(`${prompt} `);
      return new Promise((done) => {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean }) => {
          if (key?.ctrl && key.name === "c") {
            process.stdout.write("\nStopped (everything labelled so far is saved).\n");
            process.exit(130);
          }
          const k = key?.name === "return" ? "" : (str ?? "").toLowerCase();
          if (!choices.includes(k)) return;
          process.stdin.off("keypress", onKey);
          process.stdin.setRawMode(false);
          process.stdout.write(`${k || "↵"}\n`);
          done(k);
        };
        process.stdin.on("keypress", onKey);
      });
    },
    open(path) {
      if (!openPhotos) return;
      const full = join(repoRoot, path);
      const [cmd, argv] =
        process.platform === "win32" ? ["cmd", ["/c", "start", "", full]] : process.platform === "darwin" ? ["open", [full]] : ["xdg-open", [full]];
      spawn(cmd, argv, { detached: true, stdio: "ignore" }).unref();
    },
  };
}

// This preload runs only in the isolated Node regression below. Never execute a
// pattern-based signal, even when testing a revision that still requests one.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const execFileSync = childProcess.execFileSync;
childProcess.execFileSync = function (file, args, ...options) {
  if (file === "pkill" || file === "killall") {
    // A separate run can have this same argv. Evaluate the selector on a
    // simulated process table; neither process is signalled on the host.
    const selector = args.at(-1);
    const table = [
      { owner: "fixture", argv: `browser ${selector}` },
      { owner: "independent", argv: `browser ${selector}` },
    ];
    for (const row of table) {
      if (row.argv.includes(selector)) appendFileSync(process.env.OMOWRIGHT_SIGNAL_RECORD, `${row.owner}\n`);
    }
    return Buffer.alloc(0);
  }
  return execFileSync.call(this, file, args, ...options);
};
syncBuiltinESMExports();

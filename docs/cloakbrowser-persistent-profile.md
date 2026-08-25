# CloakBrowser persistent profiles

Use a persistent CloakBrowser profile when an automation job must keep its
browser state between runs, such as a Flex work-record runner on Sionic Mac.
The profile is a normal Chromium user-data directory owned by the machine that
runs the job.

## Requirements

- Bun or Node.js 20+
- OmOWright imported from this checkout
- CloakBrowser installed locally
- A stable, private profile directory

```bash
uv venv ~/.local/share/omowright-cloak
uv pip install --python ~/.local/share/omowright-cloak/bin/python \
  'cloakbrowser==0.5.7'
~/.local/share/omowright-cloak/bin/python -c \
  'import cloakbrowser; print(cloakbrowser.binary_info()["binary_path"])'
```

Do not assume the versioned Chromium directory. Resolve the binary path with
`cloakbrowser.binary_info()` on the machine that will run the job.

## Launch and reuse one profile

```js
import { connectPipe, compactSnapshot } from
  "/Users/yeongyu/local-workspaces/OmOWright/src/index.js";
import fs from "node:fs";

const profile = "/Users/yeongyu/.local/share/omowright-cloak/flex-profile";
const browserPath = "/Users/yeongyu/.cloakbrowser/<resolved>/Chromium.app/Contents/MacOS/Chromium";

fs.mkdirSync(profile, { recursive: true });

const browser = await connectPipe({
  browserPath,
  browserArgs: [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    `--user-data-dir=${profile}`,
  ],
  storageRoot: profile,
});

try {
  const page = await browser.newTab(
    "https://flex.team/time-tracking/my-time-off/dashboard",
  );
  console.log({
    url: await page.url(),
    title: await page.title(),
    snapshot: compactSnapshot(await page.snapshot({ interactive: true })),
  });
} finally {
  await browser.close();
}
```

The profile directory must remain in place after `browser.close()`. Closing the
browser releases the process; it does not delete the profile. The next run
passes the same `--user-data-dir` and reuses the state stored there.

Only one CloakBrowser process should use a given profile at a time. A stale
`SingletonLock` or a concurrently running process can make `connectPipe()` hang
or fail during startup. Use a separate profile for parallel jobs.

## Login state and cookies

Prefer logging in interactively in this same persistent profile, then reuse the
profile on later runs. A runner must detect a login page and stop with an
actionable status instead of guessing or looping.

Do **not** extract Google or 1Password cookies from another browser profile and
inject them into this profile. Google can invalidate the source session when
cookies are reused on a different device fingerprint, and 1Password sessions
depend on device-bound application state rather than cookies alone.

`injectCookies()` is available for ordinary cookie-based sites when the caller
explicitly provides an authorized export:

```js
import { injectCookies } from
  "/Users/yeongyu/local-workspaces/OmOWright/src/index.js";

await injectCookies(page, authorizedCookies);
```

Never print cookies, OAuth query strings, passwords, OTPs, tokens, or snapshots
of credential fields. Keep profile directories and cookie exports mode `0700`
or `0600` and outside the repository.

## Machine boundary for Flex

For company Flex automation, the browser process and persistent profile belong
on Sionic Mac. Reading a session transcript on another machine does not move
the browser execution boundary. A scheduler should invoke the runner locally
on Sionic Mac, for example through a LaunchAgent, and should not target an
Aside session on a different machine.

The runner should:

1. Start OmOWright with the stable CloakBrowser profile.
2. Navigate to Flex and inspect the current URL and accessible snapshot.
3. Stop and report `login_required` when the profile is logged out.
4. Confirm the date, holiday, leave, and current work state before mutating
   attendance records.
5. Click only the intended `지금 출근` or `지금 퇴근` control.
6. Verify the resulting state before exiting.

Keep the browser profile and the scheduler's logs on the same machine. Never
copy the profile to another host as a shortcut for authentication.

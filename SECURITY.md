# Security

## Reporting a vulnerability

Do not put exploit details in a public issue. Open an issue titled
"Security contact request" with no details, and the maintainer will reply with
a private channel. Fixes ship in the next release and are credited in its notes
unless you ask otherwise.

Only the latest published minor version gets security fixes.

## Threat model

omowright drives a Chromium-family browser over the Chrome DevTools Protocol
(CDP). Whoever holds a CDP connection controls that browser: every tab, its
cookies, storage and network. The question for each entry point is therefore
who else can reach the connection.

### Default: no listening port

`connectPipe()` and `connectCloakProfile()` without a `name` launch the
browser with `--remote-debugging-pipe` and talk to it over inherited file
descriptors. No TCP port is opened, so no other process can attach. A test
checks the live browser's sockets to keep it that way.

### Named instances: an unauthenticated local port, by design

`connectNamed(name)` and a named `connectCloakProfile()` exist so several
processes on one machine can share one browser. That needs an address other
processes can find, so a named browser listens on `127.0.0.1` with a
kernel-chosen port. **The port has no authentication: any local process or
user on that machine can drive the browser.**

This is deliberate and will not change into an authenticated port. A named
instance is an opt-in for a single machine whose local users and processes you
trust. If that does not hold (shared hosts, multi-user machines, untrusted code
running as you), use the pipe transport instead.

What the named path does protect:

- The port is bound to loopback only, never to a network interface.
- The registry is owner-only (directory mode `0700`, record files `0600`; on
  Windows a protected ACL). On Windows it refuses volumes without ACLs (FAT32,
  exFAT, shares without ACLs). Network filesystems are not supported.
- A registry record stores the browser's GUID, and an attach happens only while
  the endpoint answers with that GUID. So a reused pid on a rebound port is
  relaunched, never driven.

### Attaching to the user's own browser

`connect(url)` and `connectRunningBrowser()` attach to a browser that already
has remote debugging on. When the user turned it on from
`chrome://inspect/#remote-debugging`, Chrome asks them to allow each new
connection. A browser started with `--remote-debugging-port` asks nothing: like
a named instance, any local process can drive it. `connect(url)` accepts any CDP
endpoint, so the endpoint's own protection is the only protection. omowright
never turns remote debugging on in someone's profile.

### BrowserSkill and the MV3 bridge

`connectBrowserSkill` talks to the BrowserSkill daemon over its local IPC
socket and does not open a port. The opt-in bridge extension (`bridge/`)
talks only through Chrome native messaging, also without a socket. It asks for
eight permissions (`debugger`, `tabs`, `tabGroups`, `bookmarks`,
`history`, `downloads`, `notifications`, `nativeMessaging`); install it
only in a profile you are willing to have automated.

### Scoped endpoints

An app can hand omowright a limited browser behind a token
(`connect(url, { client: { authorizer } })`). `OMOWRIGHT_PAGE_CDP_METHODS`
lists every command the page API sends, so such an endpoint can allow exactly
those. The list includes `DOM.setFileInputFiles`, which puts a local file
into a page, so an endpoint should only pass paths the user chose.

### Out of scope

- CAPTCHA helpers are input and OCR aids with a human fallback, not a solver.
  omowright makes no claim about bypassing any provider.
- The CloakBrowser binary is a separately licensed third-party build. The
  install docs pin the Python wrapper version; omowright runs the binary it
  finds.
- Dependencies: CI fails on known advisories in production dependencies
  (`bun audit --prod`).

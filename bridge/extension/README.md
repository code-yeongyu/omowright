# OmOWright Cloak Bridge extension

Load this directory as an unpacked MV3 extension in the pinned CloakBrowser QA
profile. The resulting extension ID is installation-specific unless a stable
public manifest key is supplied at build time; pass that exact ID to
`installNativeMessagingHost`. Never install a wildcard origin or commit a
private extension key.

The worker is intentionally limited to fixed event forwarding and fixed
command bindings. Native host diagnostics belong on stderr; the native host's
stdout is length-prefixed protocol data only.

# Portable runtime and maintenance boundary

Source baseline: `yxie-bioc/Bioc-QMS` main `de860459c9ed566b3e446219bb70f92d135527cb`. This task received the repository; no second ZIP was supplied for comparison. Files were retrieved at the fixed commit and their Git blob hashes checked. Remote commits retain that baseline as parent through branch `codex/windows-portable`; main is not overwritten or merged.

## Packaging

Build on Windows x64 using `npm ci`, `npm run typecheck`, `npm test`, and `npm run package:windows`. The GitHub workflow performs these steps, creates a ZIP, extracts it, and tests the extracted runtime with the bundled Node executable and a PATH without developer tools. Linux `package:local` exists for implementation verification only and refuses to produce a Windows-labelled package. A CI Windows Server runner is not a clean Windows 10/11 desktop or a second physical LAN client.

Next.js standalone output is copied with symlinks dereferenced, including `.next/static`. Maintenance and worker code are bundled separately with esbuild. The package contains Node 24.22.1 from nodejs.org and PostgreSQL 17.11 EDB Windows binaries from the provider linked by postgresql.org. `packaging/runtimes.json` pins URLs and hashes. Node's official SHA256SUMS was checked when pinning, and Windows builds additionally check its Authenticode signature. The EDB archive hash is pinned from the retrieved upstream archive; this is a content pin, not an independent vendor signature. Original Node, PostgreSQL, EDB third-party and npm license files are retained. PostgreSQL DLLs remain replaceable dynamic libraries; applicable LGPL notices and upstream source locations are included. No binaries are committed to the repository.

Microsoft's C++ runtime is an OS prerequisite on machines lacking it. This project does not redistribute Microsoft runtime files under an assumed Visual Studio entitlement. The optional, user-initiated prerequisites helper downloads the pinned installer directly from Microsoft, checks SHA-256 and Microsoft's valid Authenticode signer, and launches the interactive vendor installer. It does not suppress UAC, change execution policy, disable security software, or install developer tools. Installer execution on a clean desktop must be checked separately. Normal app operation performs no package installation or binary download.

`release.json` records version, source commit, target, runtime pins and lockfile hash. `SHA256SUMS.json` inventories delivered files for corruption checks, not publisher authentication. The application launcher itself is not code signed; Windows/company execution policy can require IT review. Do not instruct users to disable protection.

## Runtime ownership

- Default state: `%LOCALAPPDATA%\BBC-QMS`; `BBC_DATA_HOME` is available to controlled test/maintenance processes.
- Program: the extracted version directory. Keep previous versions for rollback/restore.
- `instances/<name>/postgres`: native PostgreSQL data, always 127.0.0.1, SCRAM, randomly selected port. Each instance has separate random PostgreSQL credentials and files. Only one selected business instance is served by the controller.
- `instances/<name>/attachments`: private, immutable application file bytes.
- `instances/<name>/instance.json`: instance kind, network settings, release, upgrade/backup results.
- `instances/<name>/secrets.json`: owner/web/worker/bootstrap DB passwords; local maintenance only.
- `instances/<name>/demo-credentials.json`: randomized synthetic identities, only for demo instances.
- `instances/<name>/logs`: redacted web/worker diagnostics and PostgreSQL logs. PostgreSQL statement/parameter logging is disabled. App/worker logs rotate on startup above 1 MiB; establish a company log-retention policy.
- `backups`: application-consistent snapshot and referenced bytes. `recovery-checks`: retained independent restore checks; may contain confidential copies, so review retention and disk capacity.

The root directory receives a current-user/SYSTEM Windows ACL. Administrators can take ownership; local processes running as that user can read data. This is not an OS security sandbox between the trusted controller and the web process. The web and worker environments receive only their respective PostgreSQL login; maintenance/superuser credentials are not passed to either. Application roles are NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE; existing DB RLS, immutable guards and transaction audits remain in place.

The management HTTP server listens only on 127.0.0.1 with a random port and a random bearer token. The launcher gives the token to the local browser as a fragment, then the page keeps it in sessionStorage. This stores a local maintenance session only, never business data. Every maintenance action checks host, token and exact origin. Do not share this URL/token or use an untrusted local browser profile.

The launcher's controller lock is independent from PostgreSQL's PID file. Duplicate launches reuse a verified running controller; an unresponsive live PID is not killed. PostgreSQL PID files are never deleted by the product. A matching, authenticated cluster can be adopted after a controller crash only after verifying `data_directory`; other databases are not stopped. Web/worker children have IPC lifecycle handling and stop on controller disconnect. Graceful stop closes gateway, web and worker before `pg_ctl -m fast` stops the owned cluster. Failed stops leave a visible error rather than terminating arbitrary processes.

## Network

The gateway listens on loopback by default. LAN mode binds one explicitly selected RFC1918 IPv4 interface. An IP change invalidates configuration until corrected. Only configured origins/hosts are accepted; forwarded headers from clients are removed. The Next backend and database stay on loopback. A separate trusted internal host value permits health checks without allowing arbitrary browser origins. Cookies are HttpOnly/SameSite=Strict; Secure is enabled for HTTPS, disabled for loopback HTTP and clearly labelled synthetic LAN HTTP.

The gateway caps request bodies at 12 MiB while reading, limits request/header time, and supports only GET/HEAD/POST. API bodies are bounded again; private upload remains 10 MiB. No public tunnelling, router changes or automatic firewall changes occur. HTTPS uses an IT-provided PEM private key and chain, TLS >=1.2, hostname and validity checks, and a matching canonical origin. Certificate renewal and trusted distribution to clients remain company responsibilities. Do not expose this host to the public internet.

## Backup, restore and updates

Manual backups use the existing versioned REPEATABLE READ logical snapshot and hash-checked referenced attachments; sessions are intentionally excluded. Backups can be taken during operation because referenced file bytes are immutable. There is no automatic backup schedule in this release. Store approved off-device copies and adopt retention/RPO/RTO separately.

Restoration always creates a distinct empty instance; validates schema checksum, table counts, file hashes, revision/file relationships and container ledger balances; then records the restore maintenance event. The source package's exact source commit is recorded. Restore with the matching package before upgrading. Same-host verification does not establish off-host disaster recovery.

When a new package selects an existing instance, the old service is stopped. Before migrations, the previous package's maintenance module creates a backup and restores it into an independent empty target using the old migrations. Only a successful verification permits new migrations and web startup. If the old package was deleted, startup refuses rather than assuming compatibility. Failed migrations leave service unavailable and preserve the backup/upgrade result. Applied SQL files are immutable; `.gitattributes` pins LF bytes on Windows. No database major-version upgrade or destructive production migration is implemented.

## Remaining business adoption work

Existing sample QMS/EHS/inventory rules and phase-D limits remain as recorded in WORKFLOWS.md and STATUS.md. Clean bootstrap creates one technical administrator and worker, without approval qualifications or synthetic business records. It does not establish company qualification-grant authority, retention, reference data, approved SOP workflows, SSO/MFA, password recovery, antivirus or external integrations. Reference-data hierarchy administration still needs controlled setup. Production acceptance and support ownership remain necessary.

# Independent verification — `@junjiangao/dsh-plugin-remote-ssh`

**Task:** `task-7` (owner: `plugin-verifier`) — **verification round 4: documentation translation**.
**Verdict: PASS** — documentation-only change, no runtime file altered, frozen interface untouched, 0 defects, 0 regressions. D1 and D2 remain fixed.
**Verified revision** (`verification/out/plugin-revision.sha256`, 12 files): hashed before the final run and re-checked after; **the plugin source was never modified by the verifier**.

> **Note on wording.** A repo-wide search for the pre-rename package name must return nothing (task-5 item 4), so this report never spells that name out; it refers to "the pre-rename name" or "the `@local` scope". `verification/static-check.mjs` builds the search pattern from string parts for the same reason.

## Change history

| Round | Trigger | Runtime files | Outcome |
| --- | --- | --- | --- |
| 1 | initial build (`task-3`) | 11 bundle files | PASS, 2 low defects (D1 timeout caveat, D2 `scp` `-`-operand) |
| 2 | D1/D2 fixes | `lib/shell.js`, `lib/tools.js`, `README.md` | PASS — both defects fixed, 0 regressions |
| 3 | package rename (`task-4`) | 8 files, **all changes cosmetic** (proved by `git diff HEAD`) | PASS — frozen interface unchanged |
| **4** | **docs → Chinese (`task-6`) + Chinese rig README** | **none** (9 runtime files byte-identical to round 3) | **PASS — this report** |

## Round 4 — what changed

`task-6` changed exactly three files, and `git status --short` was `M README.md`, `M package.json`, `?? README.en.md`:

| File | round-3 sha256 | round-4 sha256 | Change |
| --- | --- | --- | --- |
| `README.md` | `6a5038d0a9550da6…` | `22b3f3c3fc177a629b8d5703256991c7f104ba00d7764841c3a5179d49548a5f` | rewritten in Simplified Chinese (6910 B), one-line link to `README.en.md` after the H1 |
| `README.en.md` | *(absent)* | `bd531d18048f49eff590d2a35b921764b527f0eedd96719f4500f8bd353783b4` | new (7138 B) — the previous English README plus one top note pointing at `README.md` |
| `package.json` | `d7a037272b34a0c8…` | `866d51fdc968344ecce3e382220cf5302782af4228a21d0fea6f0d85baf45634` | **only** `files` gained `"README.en.md"` (`git diff package.json` = 1 insertion, 1 deletion) |
| `tests/rig/README.md` | *(verifier-owned)* | translated to Simplified Chinese by me, structure/commands/paths/flags/JSON fields kept verbatim | `task-7` item 1 |

### Evidence that this was documentation-only

The 9 runtime files are **byte-identical** to the round-3 pin (machine-checked with `sha256sum -c verification/out/runtime-revision.sha256`, which was created for exactly this claim):

| Runtime file | sha256 (round 3 = round 4) |
| --- | --- |
| `index.js` | `c5932b93e66fb6295d65a5aeb0f2059d136177d78026f6600b867b3fe3f12445` |
| `cordis.patch.yml` | `bc186cde97f3812b9f3d893c7dc9929f917d74dfe95ebebe91573efc4c543ee2` |
| `icon.svg` | `83e3b88fb5231f9db5f440e9c253312944c9ff1e8c6c5208d09a503d1facd36b` |
| `lib/config.js` | `561d45a4b3980fec9d8ff80d95abcc7329df9798f6668465958be6424e455073` |
| `lib/hosts.js` | `8b1298e4c297c5dd58ca6ee7a2e677205878e26f362d992848f7dcd7dd182853` |
| `lib/shell.js` | `03c59857a062ac0b9c52a8d9a6448619d053e8f08bf76294d4ef9e2f57f3b0f1` |
| `lib/tools.js` | `688229060776c1ad00f2cce789a00d05b1f1eae120c3d73c9a79cdbdf3c419c1` |
| `locale/en.json` | `59b53ab17996bbc242a59f113daba944a2547f98db75d22a9fabbe4c65804d0b` |
| `locale/zh.json` | `d5954e51e27ff7c83e25c139c95749af99c930a323d8a24e781ec52a4fdddc1e` |

`tests/rig/*.mjs` is likewise unchanged: the rig self-test still passes 9/9 with the translated README alongside it, and no executable code was touched.

### Documentation audit (`node verification/docs-audit.mjs`, new in round 4)

Translation is exactly the kind of change that silently renames an identifier or breaks a table, so the Chinese README is checked against the English one mechanically — 13/13 PASS:

| Check | What it proves | Result |
| --- | --- | --- |
| D1 | `README.md` is predominantly Chinese (1106 CJK chars); `README.en.md` is English (0 CJK) and opens with its pointer to `README.md`; `README.md` links to `README.en.md` near the top | PASS |
| D2 | No unbalanced code fence; both READMEs have the same 3 fences with the same language tags in the same order | PASS |
| D3 | Inline backticks balance per paragraph (multi-line spans counted as one paragraph) in all three READMEs | PASS |
| D4 | Every ```yaml block parses with a real YAML parser, and the Chinese block is **deep-equal** (same keys **and** values) to the English one | PASS |
| D5 | The configuration override carries `id: remote-ssh` plus exactly the 8 config keys and all 9 host-entry keys, in order | PASS |
| D6 | Every markdown table has a consistent column count and a valid separator row: `README.md` 3 cols × 10 rows, `README.en.md` 3 cols × 10 rows, `tests/rig/README.md` 2 cols × 8 rows | PASS |
| D7 | The config-key table lists all eight keys as backticked first-column cells, in the identical English order (`hosts, connectTimeoutMs, commandTimeoutMs, maxOutputBytes, strictHostKeyChecking, allowedHosts, sshExecutable, scpExecutable`) | PASS |
| D8 | All four `### \`ssh_*\`` headings survive untranslated, in both READMEs, in the frozen order | PASS |
| D9 | Heading level sequence maps 1:1 (11 headings); H1 identical | PASS |
| D10 | 52 frozen identifiers (tools, params, result fields, config keys, host-entry keys, flags) appear verbatim in **both** READMEs | PASS |
| D11 | Code-span identifier sets are **identical**: 96 in each, `en-only = [none]`, `zh-only = [none]` ⇒ **no identifier was renamed or invented by the translation** | PASS |
| D12 | The Chinese rig README keeps 69 verbatim tokens (commands, flags, paths, JSON field names) and 15 JSON field names intact, with 552 CJK chars | PASS |
| D13 | `package.json` `files` includes both `README.md` and `README.en.md`, still lists every runtime file, and `dependencies` stays empty | PASS |

**Answering the Lead's specific concerns:** the Chinese Configuration YAML carries the **same keys and the same values** as the English one (D4/D5, deep-equal), the config-key table still lists **all eight** keys with exact backticked names in the same order (D7), and all four `### ssh_*` headings survived untranslated (D8).

### Round-4 defect search — no documentation defect found

Four checks failed on the **first** docs-audit run. All four were bugs in my newly written checker, not in the documents, and I verified each before changing the checker:

1. **D3** flagged `tests/rig/README.md:61-62` — that is a legitimate *multi-line* inline code span (`rig` 暴露 `` `{ host, port, … cleanup() }` ``); the check was per-line instead of per-paragraph.
2. **D7** expected 8 rows and got 9 — I sliced off only the header, not the `| --- |` separator row. The table genuinely has 8 data rows.
3. **D10** claimed `README.en.md` was missing 22 identifiers — they are inside multi-identifier spans such as `` `{ check?: boolean }` ``, which my span tokeniser returned whole. `grep` confirms every one is present in both files.
4. **D12** claimed the rig README lost `starterPid` — `git show HEAD:tests/rig/README.md | grep -c starterPid` returns **0**, so it was never documented in the English original either. Removing it from the required list (rather than "fixing" the translation) is the correct resolution.

After those fixes the audit is 13/13, and it is stable across repeated runs.

**Observations (informational, not defects):**

- `start.mjs` emits `starterPid` in its JSON line, but neither the English nor the Chinese rig README names it explicitly (the example is abbreviated with `...`). Pre-existing documentation gap, unchanged by the translation. Severity: informational.
- `README.en.md` uses a two-space continuation indent on some list items; harmless CommonMark lazy continuation, renders correctly.

## Reproduce

```sh
cd /work/Repos/github/dsh-plugin-remote-ssh
node --test tests/rig/selftest.mjs      # rig self-test   -> exit 0
node verification/static-check.mjs      # S1..S10         -> exit 0
node verification/e2e.mjs               # F0..A10         -> exit 0
node verification/docs-audit.mjs        # D1..D13         -> exit 0
```

Round-4 results: **selftest 9/9**, **static-check 10/10**, **e2e 28/28**, **docs-audit 13/13** — 0 failures, all four exit 0.

`S10-no-legacy-name` scans every repo file except `.git/` and `node_modules/`; it still passes with the two new/changed README files present (`0 files contain the pre-rename name`).

Raw outputs: `verification/out/{selftest,static-check,e2e,docs-audit}.txt` and `.json`.

## What ran as real code, and what (if anything) was stubbed

**Nothing is stubbed.**

| Component | Status |
| --- | --- |
| Plugin source (`index.js`, `lib/*.js`) | **real** — imported and executed as-is |
| `@deepseek-ai/dsh-tools` (`defineTool`, `validateJsonSchemaValue`, `assertSupportedJsonSchema`) | **real** — `verification/resolution/loader.mjs` is a Node `module.register()` hook mapping the two bare specifiers onto the genuine modules inside the dsh installation; it rewrites *only* those two |
| `@deepseek-ai/schemastery` (`z`) | **real** — same hook |
| `js-yaml`, `saxes` (used by static-check and docs-audit) | **real** — loaded from the dsh installation's own dependency tree |
| `ssh` / `scp` / `sshd` / `ssh-keygen` | **real** system OpenSSH 10.6p1 |
| Cordis `ctx` | **fake, by design** — `{ tools: { register } }`, the harness-shaped call path named in task-3 |
| Tool invocation | harness-shaped, using the **real** `validateJsonSchemaValue` on args *and* output, then the real `output.render` |
| `tests/rig` sshd | **real** sshd, real key auth, real SFTP/`scp`, real exit-code propagation |

## Static + syntax/load checks — 10/10

| Check | Result | Notes |
| --- | --- | --- |
| S1 package.json | PASS | name `@junjiangao/dsh-plugin-remote-ssh`, 1.0.0, private, `type: module`, `main: index.js`, `icon: ./icon.svg`, `dsh.bundle.patch: ./cordis.patch.yml`, `files` non-empty |
| S2 no runtime deps | PASS | `dependencies={}`; `peerDependencies` = the two installation-scope packages (see §Peer dependencies) |
| S3 referenced files exist | PASS | 5 concrete referenced paths exist |
| S4 cordis.patch.yml | PASS | top-level array, exactly one `insert` row: **`id: remote-ssh`**, `name: @junjiangao/dsh-plugin-remote-ssh`, `config: {}` |
| S5 locales | PASS | `en`/`zh` parse; distinct, non-placeholder `meta.title`/`meta.description`; zh contains CJK |
| S6 icon.svg | PASS | 1344 B (< 256 KiB), root `<svg>`, `viewBox`, 0 external refs |
| S7 syntax | PASS | 5 bundle `.js` files, 0 errors |
| S8 bare imports | PASS | only `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` |
| S9 harness contract | PASS | real `defineTool` accepts all four definitions; frozen param names and `required` sets match |
| S10 no legacy name | PASS | 0 files in the repo contain the pre-rename name |

## Functional + adversarial checks against the real rig — 28/28

| Check | Result | Notes (raw) |
| --- | --- | --- |
| F0 registration | PASS | 4 tools; `name=remote-ssh`, `inject=["tools"]` |
| F1 exec success | PASS | `exitCode=0`, stdout `RIG_OK` |
| F2 non-zero exit | PASS | `exitCode=42` propagated, no throw |
| F3 cwd + env | PASS | spaces and single quotes preserved |
| F4 stdin + pty | PASS | stdin delivered; pty → `/dev/pts/1` |
| F5 timeout | PASS | `timedOut=true`, returned in ~1.5 s |
| F6 truncation | PASS | stdout exactly 4096 B at cap 4096, `truncated=true` |
| F7 transfer round trip | PASS | 64 KiB byte-identical |
| F8 recursive transfer | PASS | dir tree round trip identical |
| F9 hosts listing | PASS | `resolvedSshExecutable=/usr/bin/ssh` |
| F10 hosts check | PASS | `reachable=true` + `latencyMs` |
| F11 allowedHosts | PASS | denial names `allowedHosts`; glob `r*` allowed |
| F12 raw target / alias | PASS | target passed verbatim; OpenSSH resolved it |
| F13 default `accept-new` | PASS | key pinned to the configured temp file; second call OK |
| F14 argv contract | PASS | ssh argv exact; scp argv `… -r -q -- a b` with `--` immediately before exactly two operands |
| F15 render/presentCall | PASS | text blocks; `presentCall` returns objects |
| F16 timeout-render caveat | PASS | caveat present on timeout, absent on success (D1 fix) |
| A1 metacharacters in `host` | PASS | 4 payloads inert; sentinel never created |
| A2 invalid env keys | PASS | rejected in <2 ms, no process spawned |
| A3 quoting | PASS | quotes preserved in command and cwd |
| A4 unreachable host | PASS | fails in ms, no hang |
| A5 abort signal | PASS | returns in ~408 ms |
| A6 `-`-prefixed path | PASS | upload **and** download byte-identical (D2 fix) |
| A7 nonexistent cwd | PASS | `exitCode=1`, command did not run |
| A8 output boundary | PASS | `maxOutputBytes: 1` honoured |
| A9 no `~/.ssh` writes | PASS | 9 files byte-identical; 0 of 25 checks wrote; `known_hosts` = `ab55f353…` |
| A10 no unhandled rejections | PASS | none |
| O1 remote outlives local kill | PASS | documented limitation, unchanged |

## Installed state — re-confirmed (no reinstall needed for a docs-only change)

`cordis_inspect_query` called with **no `input` argument**:

- `Tool/listTools` → 79 tools; all four present with parameter sets and `required` lists **identical to rounds 1–3** (`ssh_hosts[check]`; `ssh_exec[host,command,cwd,env,timeoutMs,pty,stdin] req[host,command]`; `ssh_upload[host,localPath,remotePath,recursive,timeoutMs] req[host,localPath,remotePath]`; `ssh_download` same as upload). Raw: `verification/out/installed-tools-ssh-raw.json`.
- Loader row id is still exactly `remote-ssh` (`cordis.patch.yml` line 24; S4 asserts it).
- Profile `dependencies` = exactly the three `@junjiangao` packages, with `@junjiangao/dsh-plugin-remote-ssh: link:/work/Repos/github/dsh-plugin-remote-ssh`.
- `dsh.profile.bundles` has 15 entries and ends with `@junjiangao/dsh-plugin-remote-ssh`.
- `node_modules/@junjiangao/dsh-plugin-remote-ssh` resolves to `/work/Repos/github/dsh-plugin-remote-ssh`.
- **No `@local` path anywhere in the profile** (`find` → 0 results); `node_modules` scopes are `@deepseek-ai`, `@junjiangao`, `@mars-sea`, `@standard-schema`.

## Peer dependencies (carried forward finding)

The original task-1 instruction said "declare NO dependencies **or peerDependencies**" — wrong for a workspace-linked bundle. The first install failed activation (`Cannot find package '@deepseek-ai/schemastery'`); adding `"peerDependencies": { "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/schemastery": "*" }` was the only change before it succeeded. The harness's `routeLinked` path resolves installation-scope packages only when the importing `package.json` lists them; pnpm explicitly will not supply peers to a linked dependency. Verified by install history plus the live registry; the *failing* install was not re-derived by me (that would need a `package.json` edit, outside my scope).

## Defect status after round 4

| ID | Severity | Status |
| --- | --- | --- |
| D1 — timed-out command may keep running remotely | was Low | **FIXED** (round 2, render caveat + README `## Known limitations`); asserted by F16 and O1 |
| D2 — `scp` operand beginning with `-` misparsed | was Low | **FIXED** (round 2, `-q -- src dst`); asserted by F14 and A6 |

**New defects in round 4: none**, at any severity. No documentation defect was found in the Chinese READMEs (D1–D13 all pass), and no runtime file changed.

## Unverified / limits

1. **Live dispatch from this session.** `Tool/listTools` shows the four tools as callable, but my session's declared function set predates the install, so I cannot dispatch a live `ssh_exec` from *this* session. The Lead's in-harness calls are corroboration, not independent evidence.
2. **`Config.listConfigs` paging is unavailable** — any `input` argument is rejected (`"input" must be an object`), so I could not filter the 217 live config entries for the `remote-ssh` row.
3. **The failing pre-peerDependencies install was not re-derived by me.**
4. **The plugin has never been run against a real remote host by me** — one read-only `MyOracleCloud` smoke check in round 1, plain OpenSSH, not the plugin.
5. **ProxyJump (`-J`) is argv-verified only** (no bastion available).
6. **Real `~/.ssh/config` alias resolution is simulated** via `ssh -F` through the plugin's own `sshExecutable`.
7. **`ssh_hosts` `check:true` unreachable branch** not exercised.
8. **No large-transfer/soak** — 64 KiB transfers; caps exercised at 4096 and 1.
9. **`scp --` portability** verified on OpenSSH 10.6p1 only.
10. **Linux only**; no macOS/Windows.
11. **`presentCall` card shape** asserted only as "non-null object, does not throw".
12. **D1's remote-survival behaviour is asserted, not fixed** — out of scope for the frozen interface.
13. **Translation quality is only checked mechanically.** The docs audit proves structural fidelity, identifier preservation, YAML equality and table integrity; it does **not** judge whether the Chinese prose is idiomatic, and it cannot detect a *meaning* error that keeps every identifier intact. A human Chinese reviewer would be needed for that.
14. **Historical audit logs** under `.plugin-manager/logs/operation-*/pnpm.log` still record the pre-rename name (inert; I did not modify the profile).

## Incident log — a write to the real `~/.ssh/known_hosts` (self-reported, fully reconciled)

- Round 1: my own non-hermetic test design (redirecting `$HOME`, which this OpenSSH ignores in favour of the passwd home) let `accept-new` append `[127.0.0.1]:37569 ssh-ed25519 …` to the real `~/.ssh/known_hosts`. **My harness's bug, not a plugin defect.**
- A second line (`127.0.0.1`, port 22, the system sshd) was **not** caused by my suite — no check in any round connected to port 22, and per-check attribution shows zero `~/.ssh` writes.
- My remediation restored the file to its then-current bytes after verifying the hash first; the Lead then removed a `localhost` line of their own. The **true pre-session baseline** is **3718 bytes / 19 lines / sha256 `ab55f353bf185fd6f579544775cdbbbe22df26f7855bdfb2040744cdce4a7c52`**.
- **Round 4:** `~/.ssh/known_hosts` matches that baseline exactly, before and after the suites.
- Harness fixes: F13 pins `UserKnownHostsFile` to a temp file, F12 injects a private `ssh -F` config, and every check is wrapped in a per-check `~/.ssh` fingerprint guard.

Also cleaned up: orphaned remote `sleep` processes from the timeout probes; no stray `sshd`; no leftover `/tmp/dsh-ssh-rig-*` or `/tmp/dsh-e2e-*` directories.

## Revision pins

`verification/out/plugin-revision.sha256` — **12 files**: `index.js`, `package.json`, `cordis.patch.yml`, `icon.svg`, `README.md`, `README.en.md`, `lib/*.js` (4), `locale/*.json` (2).

```
c5932b93e66fb6295d65a5aeb0f2059d136177d78026f6600b867b3fe3f12445  index.js
866d51fdc968344ecce3e382220cf5302782af4228a21d0fea6f0d85baf45634  package.json
bc186cde97f3812b9f3d893c7dc9929f917d74dfe95ebebe91573efc4c543ee2  cordis.patch.yml
83e3b88fb5231f9db5f440e9c253312944c9ff1e8c6c5208d09a503d1facd36b  icon.svg
22b3f3c3fc177a629b8d5703256991c7f104ba00d7764841c3a5179d49548a5f  README.md
bd531d18048f49eff590d2a35b921764b527f0eedd96719f4500f8bd353783b4  README.en.md
561d45a4b3980fec9d8ff80d95abcc7329df9798f6668465958be6424e455073  lib/config.js
8b1298e4c297c5dd58ca6ee7a2e677205878e26f362d992848f7dcd7dd182853  lib/hosts.js
03c59857a062ac0b9c52a8d9a6448619d053e8f08bf76294d4ef9e2f57f3b0f1  lib/shell.js
688229060776c1ad00f2cce789a00d05b1f1eae120c3d73c9a79cdbdf3c419c1  lib/tools.js
59b53ab17996bbc242a59f113daba944a2547f98db75d22a9fabbe4c65804d0b  locale/en.json
d5954e51e27ff7c83e25c139c95749af99c930a323d8a24e781ec52a4fdddc1e  locale/zh.json
```

`verification/out/runtime-revision.sha256` — the **9 runtime files** only; this is the machine-checkable form of "no runtime file changed".

## Appendix — raw output of `node --test tests/rig/selftest.mjs`

Verbatim copy of `verification/out/selftest.txt` from the final round-4 run (exit code 0):

```
✔ rig exposes sane coordinates (207.334532ms)
✔ sshd log reports the listening port (0.708602ms)
✔ ssh runs a remote command with BatchMode and exit code 0 (155.939803ms)
✔ ssh propagates a non-zero remote exit code (158.842057ms)
✔ ssh honours a working directory and exported environment (167.997727ms)
✔ scp uploads and downloads byte-identical content (340.678516ms)
✔ scp -r uploads and downloads a directory tree (339.265406ms)
✔ rig never touches ~/.ssh (1.008093ms)
✔ stop removes the temp dir, kills sshd and frees the port (30.821327ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1463.947804
```

## Appendix — raw output of `node verification/static-check.mjs`

Verbatim copy of `verification/out/static-check.txt` from the final round-4 run (exit code 0):

```
PASS  S1-package-json                    package.json parses and declares the frozen manifest fields (0ms)  name=@junjiangao/dsh-plugin-remote-ssh version=1.0.0 files=7 exports=.,./locale/*.json,./icon,./cordis.patch.yml,./package.json
PASS  S2-no-dependencies                 package.json declares NO dependencies; only installation-scope peerDependencies (0ms)  dependencies={} optionalDependencies={} peerDependencies={"@deepseek-ai/dsh-tools":"*","@deepseek-ai/schemastery":"*"}
PASS  S3-referenced-files-exist          every file referenced by main/exports/files exists on disk (0ms)  6 referenced paths exist
PASS  S4-cordis-patch                    cordis.patch.yml parses as YAML and inserts exactly one remote-ssh row (5ms)  insert: id=remote-ssh name=@junjiangao/dsh-plugin-remote-ssh config={}
PASS  S5-locales                         locale/en.json and locale/zh.json parse and carry real meta copy (1ms)  en="Remote SSH" zh="远程 SSH"
PASS  S6-icon-svg                        icon.svg is well-formed SVG < 256 KiB with a viewBox and no external references (2ms)  1344 bytes, root=<svg>, 15 elements, viewBox present, 0 external refs
PASS  S7-node-check                      every .js/.mjs file passes `node --check` (5 files) (204ms)  5 files checked, 0 syntax errors
PASS  S8-bare-imports                    the only bare imports are @deepseek-ai/dsh-tools and @deepseek-ai/schemastery (0ms)  @deepseek-ai/schemastery x1, @deepseek-ai/dsh-tools x1
PASS  S9-tool-definitions                the REAL harness defineTool accepts all four definitions with frozen params (15ms)  4 tools registered: ssh_download, ssh_exec, ssh_hosts, ssh_upload
PASS  S10-no-legacy-name                 no stale pre-rename package reference remains anywhere in the repo (0ms)  0 files contain the pre-rename name (scanned the whole repo except .git/ and node_modules/)

static-check: 10 passed, 0 failed, 10 total (230ms)
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/static-check.json
```

## Appendix — raw output of `node verification/e2e.mjs`

Verbatim copy of `verification/out/e2e.txt` from the final round-4 run (exit code 0):

```
PASS  F0-registration                    apply() registers the four frozen tools with harness-valid schemas (3ms)  tools=ssh_download,ssh_exec,ssh_hosts,ssh_upload name=remote-ssh inject=["tools"]
PASS  F1-exec-success                    ssh_exec runs a command: exitCode 0, stdout captured, not timed out (140ms)  exitCode=0 stdout="RIG_OK" durationMs=139
PASS  F2-exec-exit-code                  ssh_exec propagates a non-zero remote exit code without throwing (166ms)  exitCode=42 propagated
PASS  F3-exec-cwd-env                    ssh_exec applies cwd and env, including single quotes and spaces (139ms)  env+cwd applied, pwd=/tmp/dsh-ssh-rig-OvRRzC/e2e-cwd
PASS  F4-exec-stdin-pty                  ssh_exec honours stdin and pty (-tt) (269ms)  stdin ok; pty -> /dev/pts/1
PASS  F5-exec-timeout                    ssh_exec timeout: timedOut=true, returns promptly, local child killed (6617ms)  timedOut after 1507ms (wall 1508ms); remote pid(s) still alive at that point: "273216"
PASS  O1-remote-outlives-kill            OBSERVATION: killing the local ssh child does NOT stop the remote command (4677ms)  remote command kept running and created its marker ~3s after the 1s timeout killed the client (documented in REPORT.md as a limitation of client-side cancellation)
PASS  F6-output-truncation               output is capped at maxOutputBytes and flagged truncated (144ms)  stdout=4096B (cap 4096), truncated=true
PASS  F7-transfer-roundtrip              ssh_upload then ssh_download returns byte-identical content (331ms)  65536B round trip byte-identical (sha256 729512428e966388...)
PASS  F8-transfer-recursive              ssh_upload/ssh_download with recursive:true move a directory tree (318ms)  recursive tree round trip ok
PASS  F9-hosts-listing                   ssh_hosts lists configured hosts and reports the resolved ssh path (3ms)  1 host (rig -> xyzhuanjian@127.0.0.1:45939), resolved=/usr/bin/ssh
PASS  F10-hosts-check                    ssh_hosts check:true probes reachability and reports latency (161ms)  reachable=true latency=159ms
PASS  F11-allowed-hosts                  allowedHosts rejects a non-matching target and accepts a matching glob (161ms)  denied with "remote-ssh: host \"rig\" (target \"xyzhuanjian@127.0.0.1\") is not permitted by allo"...; glob "r*" allowed
PASS  F12-raw-target-alias               raw targets work with NO config entry, via an ssh_config alias (164ms)  unconfigured alias RigAlias resolved by OpenSSH itself (private -F config), target passed verbatim
PASS  F13-default-accept-new             default strictHostKeyChecking=accept-new pins the host key (335ms)  accept-new pinned the rig key into the configured UserKnownHostsFile (accept_new_known_hosts); second call OK
PASS  F14-argv-shape                     buildSshArgv/buildScpArgv match the frozen argv contract (5ms)  ssh/scp argv, sq(), composeRemoteScript() and ConnectTimeout all match
PASS  F15-presentCall-render             presentCall and render run cleanly for every tool (503ms)  ssh_hosts: ssh executable: ssh (resolved: /usr/bin/ssh) | ssh_exec: ssh rig (xyzhuanjian@127.0.0.1) exited with code 0 in 161ms. | ssh_upload: Uploaded /tmp/dsh-e2e-8RWMni/up.bin to rig:/tmp/dsh-ssh-rig- | ssh_download: Downloaded /tmp/dsh-e2e-8RWMni/render-back.bin from rig:/tmp
PASS  F16-timeout-render-caveat          FIXED: a timed-out ssh_exec render carries the remote-may-still-run caveat (1571ms)  caveat present on timeout, absent on success; header="ssh rig (xyzhuanjian@127.0.0.1) timed out after 1208ms and was killed in 1208ms."
PASS  A1-metachar-target                 a target containing shell metacharacters is inert (no local shell, no injection) (32ms)  "127.0.0.1; touch /tmp/ds" -> exitCode=255 in 4ms; "127.0.0.1$(touch /tmp/ds" -> exitCode=255 in 5ms; "127.0.0.1`touch /tmp/dsh" -> exitCode=255 in 8ms; "127.0.0.1 && touch /tmp/" -> exitCode=255 in 14ms
PASS  A2-invalid-env-keys                invalid POSIX env keys are rejected before any process is spawned (2ms)  "BAD KEY" -> "remote-ssh: env key \"BAD KEY\" is not a valid POSIX environment variabl"; "1LEADING" -> "remote-ssh: env key \"1LEADING\" is not a valid POSIX environment variab"; "a-b" -> "remote-ssh: env key \"a-b\" is not a valid POSIX environment variable na"; "" -> "remote-ssh: env key \"\" is not a valid POSIX environment variable name"; "a.b" -> "remote-ssh: env key \"a.b\" is not a valid POSIX environment variable na"; GOOD:123 -> "remote-ssh: env value for \"GOOD\" must be a string"
PASS  A3-quoted-command-and-cwd          single quotes in command and cwd are preserved literally (167ms)  quotes preserved in command and in cwd "/tmp/dsh-ssh-rig-OvRRzC/we'ird dir"
PASS  A4-unreachable-host                a closed port fails fast with a structured error and no hang (23ms)  exitCode=255 in 17ms, stderr="ssh: connect to host 127.0.0.1 port 44231: Connection refused\r"
PASS  A5-abort-signal                    exec.signal cancels an in-flight command promptly (407ms)  aborted in 407ms, exitCode=255 signal=null
PASS  A6-dash-prefixed-path              FIXED: a relative transfer path starting with "-" now transfers (662ms)  dash upload+download byte-identical (24B), ordinary relative and absolute paths still OK
PASS  A7-nonexistent-cwd                 a nonexistent remote cwd fails structurally instead of hanging (157ms)  exitCode=1 in 157ms, stderr="Warning: Permanently added '[127.0.0.1]:45939' (ED25519) to "
PASS  A8-max-output-boundary             maxOutputBytes=1 is handled without crashing or unbounded output (170ms)  cap=1 honoured (stdout="a", truncated=true)
PASS  A9-no-ssh-writes                   nothing wrote to the real ~/.ssh during the whole run (1ms)  9 files in ~/.ssh, all byte-identical (incl. known_hosts); 0 of 25 checks wrote to ~/.ssh
PASS  A10-no-unhandled-rejections        no unhandled promise rejections escaped the plugin (0ms)  none

e2e: 28 passed, 0 failed, 28 total (17640ms)
total wall clock: 17640ms
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/e2e.json
```

## Appendix — raw output of `node verification/docs-audit.mjs`

Verbatim copy of `verification/out/docs-audit.txt` from the final round-4 run (exit code 0):

```
PASS  D1-files                           both READMEs exist and the primary one is Chinese (0ms)  zh=4378B (1106 CJK), en=7120B (0 CJK)
PASS  D2-fences-balanced                 no unbalanced code fence in either README (0ms)  3 fences in each, same languages in the same order (,yaml,yaml)
PASS  D3-inline-code-balanced            backticks balance per paragraph (outside fences), allowing multi-line spans (0ms)  all three READMEs clean (multi-line code spans counted as one paragraph)
PASS  D4-yaml-parses-and-matches         every ```yaml block parses and the Chinese one is deep-equal to the English one (2ms)  2 yaml block(s) parse and are identical to the English version
PASS  D5-config-yaml-keys                the configuration override carries exactly the eight config keys (0ms)  id=remote-ssh + all 8 config keys + all 9 host-entry keys, in order
PASS  D6-tables-consistent               every markdown table has a consistent column count (1ms)  README.md#1=3cols×10rows, README.en.md#1=3cols×10rows, tests/rig/README.md#1=2cols×8rows
PASS  D7-config-key-table                the config-key table lists all eight keys, in the English order (0ms)  8 keys, identical order: hosts, connectTimeoutMs, commandTimeoutMs, maxOutputBytes, strictHostKeyChecking, allowedHosts, sshExecutable, scpExecutable
PASS  D8-tool-headings                   all four `### ssh_*` headings survive untranslated in both READMEs (0ms)  `ssh_hosts` `ssh_exec` `ssh_upload` `ssh_download`
PASS  D9-heading-structure               heading level sequence maps 1:1 between the two READMEs (0ms)  11 headings, identical levels; H1 = @junjiangao/dsh-plugin-remote-ssh
PASS  D10-frozen-identifiers             every frozen tool/param/result/config identifier appears untranslated in both READMEs (0ms)  52 frozen identifiers present verbatim in both
PASS  D11-no-identifier-rename           no frozen identifier was renamed, and no identifier-like span was invented (0ms)  code-span identifiers: 96 in en, 96 in zh; en-only=[none], zh-only=[none]
PASS  D12-rig-readme-identifiers         the Chinese rig README keeps every command, flag and JSON field verbatim (0ms)  69 verbatim tokens + 15 JSON fields intact; 552 CJK chars
PASS  D13-package-files                  package.json ships README.en.md and still lists every runtime file (0ms)  files = ["index.js","lib/*.js","cordis.patch.yml","locale/*.json","icon.svg","README.md","README.en.md"]

docs-audit: 13 passed, 0 failed, 13 total (5ms)
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/docs-audit.json
```

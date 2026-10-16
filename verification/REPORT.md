# Independent verification — `@junjiangao/dsh-plugin-remote-ssh`

**Task:** `task-5` (owner: `plugin-verifier`) — **verification round 3, after the package rename (task-4)**.
**Verdict: PASS** — the rename is cosmetic, the frozen tool interface is unchanged, 0 defects, 0 regressions. Both round-1 defects (D1, D2) remain fixed.
**Verified revision** (`verification/out/plugin-revision.sha256`): all 11 bundle files hashed before the final run and re-checked after; **the plugin source was never modified by the verifier**.

> **Note on wording.** Task-5 item 4 requires a repo-wide search for the pre-rename package name to return nothing. This report therefore never spells that name out; it refers to "the pre-rename name" or "the `@local` scope" (the old name was the `@local` scope plus `/dsh-plugin-remote-ssh`). `verification/static-check.mjs` builds the search pattern from string parts for the same reason.

## Round 3 — what the rename changed (and what it did not)

The builder committed the round-2 verified revision as `df6f2b4`, so the rename can be diffed **exactly** rather than inferred. `git show HEAD:<file>` hashes reproduce my round-2 pin byte-for-byte for all 11 files, and `git diff HEAD` (restricted to the bundle) is:

| File | round-2 sha256 | round-3 sha256 | Diff |
| --- | --- | --- | --- |
| `package.json` | `a11478e529816ef8…` | `d7a037272b34a0c8f5896bc427131162998973888ad9ead3248f6c55367bbc8b` | `name` + new `repository` field (6 lines) |
| `cordis.patch.yml` | `7547dc8fe5d821cf…` | `bc186cde97f3812b9f3d893c7dc9929f917d74dfe95ebebe91573efc4c543ee2` | comment line + insert-row `name` (4 lines) |
| `index.js` | `404ba62d4344be29…` | `c5932b93e66fb6295d65a5aeb0f2059d136177d78026f6600b867b3fe3f12445` | **JSDoc only** (2 lines) |
| `lib/config.js` | `01d18089fd189fd7…` | `561d45a4b3980fec9d8ff80d95abcc7329df9798f6668465958be6424e455073` | **1 JSDoc `@module` line** |
| `lib/hosts.js` | `8b9adb75c2b916c2…` | `8b1298e4c297c5dd58ca6ee7a2e677205878e26f362d992848f7dcd7dd182853` | **1 JSDoc `@module` line** |
| `lib/shell.js` | `fd2fbff26232f84b…` | `03c59857a062ac0b9c52a8d9a6448619d053e8f08bf76294d4ef9e2f57f3b0f1` | **1 JSDoc `@module` line** |
| `lib/tools.js` | `23210a7cd4964337…` | `688229060776c1ad00f2cce789a00d05b1f1eae120c3d73c9a79cdbdf3c419c1` | **1 JSDoc `@module` line** |
| `README.md` | `86be6242f7b5c93b…` | `6a5038d0a9550da6f823a12ce25f975fe33bc78708073a0065cedaa359cb8b3a` | H1 + YAML example (4 lines) |
| `icon.svg` | `83e3b88fb5231f9d…` | `83e3b88fb5231f9db5f440e9c253312944c9ff1e8c6c5208d09a503d1facd36b` | **unchanged** |
| `locale/en.json` | `59b53ab17996bbc2…` | `59b53ab17996bbc242a59f113daba944a2547f98db75d22a9fabbe4c65804d0b` | **unchanged** |
| `locale/zh.json` | `d5954e51e27ff7c8…` | `d5954e51e27ff7c83e25c139c95749af99c930a323d8a24e781ec52a4fdddc1e` | **unchanged** |

`git diff --stat HEAD` for the bundle: **8 files changed, 15 insertions(+), 11 deletions(-)** — every changed line is a package-name string in a comment/JSDoc/README/manifest field. **No code line, tool name, parameter name, output field, row id, dependency, export or `files` entry changed.** `icon.svg` and both locales are byte-identical, as predicted.

Row id is still exactly `remote-ssh`, the insert row now names the new package, and `config: {}` is intact (checked by S4).

## Reproduce

```sh
cd /work/Repos/github/dsh-plugin-remote-ssh
node --test tests/rig/selftest.mjs          # rig self-test   -> exit 0
node verification/static-check.mjs          # checks S1..S10  -> exit 0
node verification/e2e.mjs                   # checks F0..A10  -> exit 0
```

Round-3 results: **selftest 9/9**, **static-check 10/10**, **e2e 28/28** — 0 failures, all three exit 0.

> The Lead expected `9 / 9 / 28`. The static-check figure is **10**, not 9, because I added a tenth check, `S10-no-legacy-name`, to automate task-5 item 4 (repo-wide search for the pre-rename name). All nine original checks (S1–S9) still pass; S10 is new, not a replacement. This is an added assertion, not a discrepancy.
>
> S10 is strict: it scans every file in the repo except `.git/` and `node_modules/`, including the verifier's own generated evidence under `verification/out/`. On the first round-3 run it correctly failed, because the *round-2* `static-check.json`/`static-check.txt` still recorded the old name; that run regenerated them, and S10 has passed on every run since (verified stable across two consecutive runs). This was a one-time migration artifact of my own evidence files, not a bundle defect.

Raw outputs are saved verbatim in `verification/out/{selftest,static-check,e2e}.txt` and as JSON in `verification/out/{static-check,e2e}.json`.

## What ran as real code, and what (if anything) was stubbed

**Nothing is stubbed.** The verifier did not fake any harness or plugin behaviour:

| Component | Status |
| --- | --- |
| Plugin source (`index.js`, `lib/*.js`) | **real** — imported and executed as-is |
| `@deepseek-ai/dsh-tools` (`defineTool`, `validateJsonSchemaValue`, `assertSupportedJsonSchema`) | **real** — `verification/resolution/loader.mjs` is a Node `module.register()` resolution hook that maps the two bare specifiers onto the genuine modules inside the dsh installation. It rewrites *only* those two specifiers; every other specifier resolves normally. |
| `@deepseek-ai/schemastery` (`z`, incl. `z.natural`, `z.union`) | **real** — same hook |
| `ssh` / `scp` / `sshd` / `ssh-keygen` | **real** system OpenSSH 10.6p1 |
| Cordis `ctx` | **fake, by design** — `{ tools: { register(def) { captured.push(def) } } }`, the harness-shaped call path named in task-3. `apply()` is called for real; `Config(raw)` is the real schemastery schema. |
| Tool invocation | harness-shaped, using the **real** `validateJsonSchemaValue` on args *and* output (mirroring `ToolRuntime.createSuccessResult`), then the real `output.render` |
| `tests/rig` sshd | **real** sshd, real key auth, real SFTP/`scp`, real exit-code propagation |

The hook directory is named `verification/resolution/` (not `stubs/`) for exactly this reason.

## 1–2. Static + syntax/load checks (`node verification/static-check.mjs`)

| Check | Method | Result | Notes |
| --- | --- | --- | --- |
| S1 package.json | parse + assert frozen fields | **PASS** | name `@junjiangao/dsh-plugin-remote-ssh`, 1.0.0, private, `type: module`, `main: index.js`, `icon: ./icon.svg`, `dsh.bundle.patch: ./cordis.patch.yml`, `files` non-empty |
| S2 no runtime deps | assert `dependencies`/`optionalDependencies` empty | **PASS** | `dependencies={}`; `peerDependencies={"@deepseek-ai/dsh-tools":"*","@deepseek-ai/schemastery":"*"}` — required for a linked bundle, see §6 |
| S3 referenced files exist | resolve `main`+`exports`+`files` | **PASS** | 5 concrete referenced paths exist |
| S4 cordis.patch.yml | `js-yaml` parse (real parser from dsh install) | **PASS** | top-level array, exactly one `insert` row: `id: remote-ssh`, `name: @junjiangao/dsh-plugin-remote-ssh`, `config: {}` |
| S5 locales | JSON parse + content assertions | **PASS** | `en.meta.title="Remote SSH"`, `zh.meta.title="远程 SSH"`; descriptions non-empty, distinct, no placeholders |
| S6 icon.svg | `saxes` SAX parse + regex audit | **PASS** | 1344 bytes (< 256 KiB), root `<svg>`, `viewBox` present, **0 external references** |
| S7 syntax | `node --check` per file | **PASS** | 5 bundle `.js` files, 0 syntax errors |
| S8 bare imports | source scan for non-relative imports | **PASS** | exactly `@deepseek-ai/dsh-tools` ×1 and `@deepseek-ai/schemastery` ×1 |
| S9 harness contract | real `defineTool` + `assertSupportedJsonSchema` | **PASS** | real `defineTool` accepts all four definitions; frozen parameter names and `required` sets match exactly |
| **S10 no legacy name (NEW)** | recursive scan of the whole repo (except `.git/` and `node_modules/`) for the pre-rename name | **PASS** | **0 files** contain it — the rename is complete repo-wide |

## 3. Functional checks against the real rig (`node verification/e2e.mjs`) — 28/28

| Check | Method | Result | Notes (raw) |
| --- | --- | --- | --- |
| F0 registration | `apply(fakeCtx, Config({}))` | **PASS** | 4 tools; `name=remote-ssh`, `inject=["tools"]` |
| F1 exec success | real rig, `echo RIG_OK` | **PASS** | `exitCode=0`, stdout `RIG_OK`, `timedOut=false` |
| F2 non-zero exit | `exit 42` | **PASS** | `exitCode=42` propagated, no throw |
| F3 cwd + env | `cwd`, env with spaces and `'` | **PASS** | spaces and single quotes preserved |
| F4 stdin + pty | `cat` with `stdin`; `tty` with `pty:true` | **PASS** | stdin delivered; pty → `/dev/pts/1` |
| F5 timeout | `sleep …`, `timeoutMs:1500` | **PASS** | `timedOut=true`, returned in **1508 ms** |
| F6 truncation | 200 kB output, cap 4096 | **PASS** | stdout exactly **4096 B**, `truncated=true` |
| F7 transfer round trip | upload → download, 64 KiB pseudo-random | **PASS** | byte-identical (`sha256 729512428e966388…`) |
| F8 recursive transfer | `recursive:true` dir both ways | **PASS** | `a.txt`/`b.txt` identical |
| F9 hosts listing | `ssh_hosts {}` | **PASS** | 1 host; `resolvedSshExecutable=/usr/bin/ssh` |
| F10 hosts check | `ssh_hosts {check:true}` | **PASS** | `reachable=true`, `latencyMs` reported |
| F11 allowedHosts | deny list + `*` glob | **PASS** | denial names `allowedHosts`; glob `r*` allowed |
| F12 raw target / alias | **no config entry**, alias via private `ssh -F` config | **PASS** | target passed verbatim; OpenSSH resolved it |
| F13 default `accept-new` | default policy, temp `UserKnownHostsFile` | **PASS** | key pinned; second call OK |
| F14 argv contract | real `buildSshArgv`/`buildScpArgv`/`sq`/`composeRemoteScript` | **PASS** | ssh argv exact; scp argv `… -r -q -- a b` with `--` immediately before exactly two operands |
| F15 render/presentCall | real `output.render` + `presentCall`, all 4 tools | **PASS** | text blocks; `presentCall` returns objects |
| F16 timeout-render caveat | render of a timed-out `ssh_exec` | **PASS** | caveat present on timeout, absent on success (D1 fix) |

## 4. Adversarial checks — all PASS

| Check | Attack | Result | Notes (raw) |
| --- | --- | --- | --- |
| A1 shell metacharacters in `host` | `;`, `$(…)`, backticks, `&&` | **PASS** | all 4 inert (`exitCode=255`, single-digit ms); sentinel never created |
| A2 invalid env keys | `"BAD KEY"`, `1LEADING`, `a-b`, `""`, `a.b`, non-string | **PASS** | rejected in <2 ms, no process spawned |
| A3 quoting | quotes in command and in cwd | **PASS** | preserved literally |
| A4 unreachable host | closed port, ConnectTimeout 2 s | **PASS** | `exitCode=255` in ms, no hang |
| A5 abort signal | abort 400 ms into `sleep 60` | **PASS** | returned in **~408 ms**, `timedOut=false` |
| A6 `-`-prefixed transfer path | relative `localPath: "-dashfile"` | **PASS (D2 fix)** | upload **and** download byte-identical; ordinary relative and absolute paths still OK |
| A7 nonexistent remote cwd | `cwd: /nonexistent/…` | **PASS** | `exitCode=1`, command did not run |
| A8 output boundary | `maxOutputBytes: 1` | **PASS** | cap honoured, `truncated=true` |
| A9 no `~/.ssh` writes | per-check recursive fingerprint of `~/.ssh` | **PASS** | 9 files byte-identical; **0 of 25 checks** touched `~/.ssh`; `known_hosts` sha256 `ab55f353…` unchanged (baseline 3718 B / 19 lines) |
| A10 no unhandled rejections | process-level collector | **PASS** | none |
| O1 remote outlives local kill | documented limitation | **PASS** | unchanged by the D1 fix, which is render/documentation-level |

## 5. Installed state — re-confirmed after the 23:21 rename install

`cordis_inspect_query` called with **no `input` argument** (this harness rejects any `input`):

```
cordis_inspect_query platform=host provider=Tool method=listTools
```

All four tools present (79 tools total), parameter sets and `required` lists **identical to rounds 1 and 2** — raw entries in `verification/out/installed-tools-ssh-raw.json`:

| Tool | `parameters.properties` | `required` |
| --- | --- | --- |
| `ssh_hosts` | `check` | *(none)* |
| `ssh_exec` | `host, command, cwd, env, timeoutMs, pty, stdin` | `host, command` |
| `ssh_upload` | `host, localPath, remotePath, recursive, timeoutMs` | `host, localPath, remotePath` |
| `ssh_download` | `host, localPath, remotePath, recursive, timeoutMs` | `host, localPath, remotePath` |

**No frozen-interface deviation.** Profile evidence:

- `dependencies` is exactly: `@junjiangao/dsh-plugin-remote-ssh: link:/work/Repos/github/dsh-plugin-remote-ssh`, `@junjiangao/dsh-web-mcp-manager`, `@junjiangao/dsh-web-search-tavily`.
- `dsh.profile.bundles` ends with `@junjiangao/dsh-plugin-remote-ssh`.
- `node_modules/@junjiangao/dsh-plugin-remote-ssh` is a symlink resolving to `/work/Repos/github/dsh-plugin-remote-ssh`.
- Successful install log: `.plugin-manager/logs/operation-CJHA3W/pnpm.log` (`+ @junjiangao/dsh-plugin-remote-ssh 1.0.0 <- …/dsh-plugin-remote-ssh`). Removal of the old package: `operation-WXMPnl/pnpm.log`.
- `pnpm-lock.yaml` and `node_modules/.pnpm/lock.yaml` contain **no** pre-rename reference; both name `@junjiangao/dsh-plugin-remote-ssh`.

### `@local` cleanup — independently confirmed

- `node_modules` top level is now exactly `@deepseek-ai`, `@junjiangao`, `@mars-sea`, `@standard-schema`, `.pnpm` — **no `@local`**.
- `find <profile> -name '@local' -o -path '*@local*'` → **no results** (nothing in the profile, including `node_modules`).
- The stale `node_modules/@local/` directory the Lead removed held only the old symlink; it is gone and nothing references it.
- **Nuance, reported for completeness:** the pre-rename name still appears inside six *historical* append-only audit logs under `.plugin-manager/logs/operation-*/pnpm.log` (`XxE7Hi`, `HCB6iI`, `m2SUtv`, `AIIAtk`, `JMJhqd`, `WXMPnl`). These are records of past operations, not live state; they are not read by the Loader and cannot activate anything. The **live** profile state (manifest, lockfiles, `node_modules`, and the live tool registry) is entirely free of it.

## 6. Finding (carried forward): `peerDependencies` is required for a linked bundle

The original task-1 instruction said "declare NO dependencies **or peerDependencies**". That instruction is **wrong for a workspace-linked bundle** and the correction is **verified**:

1. First `install_bundle` (`.plugin-manager/logs/operation-XxE7Hi`, 22:50) linked the package as `1.0.0 <- …/dsh-plugin-remote-ssh` with no `peerDependencies`, and activation failed with `Cannot find package '@deepseek-ai/schemastery' imported from …/lib/config.js`.
2. The only change between that and the successful install was adding `"peerDependencies": { "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/schemastery": "*" }`.
3. `remove_bundle` + `install_bundle` then reported `application: applied`, `enabled: true` (`operation-m2SUtv`, 22:51) — and the renamed install at 23:21 (`operation-CJHA3W`) succeeded with the same peer set, which is a second independent confirmation of the mechanism.

Mechanism (Lead's diagnosis, corroborated): the harness resolves installation-scope packages for a *linked* bundle through its `routeLinked` path, which requires the importing package's own `package.json` to list the specifier — hence `peerDependencies`, not `dependencies`. pnpm warns it will not provide those peers to a linked dependency, so the harness must be supplying them.

**Independently reproduced by me:** the live registry exposes all four tools and `dependencies` is still absent (S2). **Not independently reproduced by me:** the *failing* install (would require editing the plugin's `package.json`, outside my write scope).

## 7. Defect status after round 3

| ID | Severity | Status |
| --- | --- | --- |
| D1 — timed-out command may keep running remotely | was Low | **FIXED** in round 2 (render caveat + README `## Known limitations`); behaviour intentionally unchanged. Still asserted by F16 and O1. Known limitation, not a defect. |
| D2 — `scp` operand beginning with `-` misparsed | was Low | **FIXED** in round 2 (`-q -- src dst`). Still asserted by F14 and A6. |

**New defects in round 3: none.** The rename introduced no regression: no code line changed, the four tool names and every parameter/output field are identical, the row id is still `remote-ssh`, and all three suites pass with the same check counts (plus the new S10).

## 8. Unverified / limits

1. **Live dispatch from this session.** `Tool/listTools` shows the four tools as callable by this Agent, but my session's declared function set was fixed before the install, so I could not dispatch a live `ssh_exec` from *this* session. The live-registry evidence (§5) and the harness-shaped invocation in `e2e.mjs` are the strongest available substitutes. The Lead's in-harness `ssh_exec(host='MyServer', …)` → `RENAMED_BUNDLE_LIVE` call exercises the live path but is **not** independent evidence, so it is reported as corroboration only.
2. **`Config.listConfigs` paging is unavailable** — any `input` argument is rejected (`"input" must be an object`), so I could not filter the 217 live config entries for the `remote-ssh` row.
3. **The failing first install was not re-derived by me** (§6).
4. **`~/.ssh` / real-host behaviour is only lightly exercised.** One read-only smoke check on `MyOracleCloud` (round 1, plain OpenSSH, not the plugin). The plugin has **never** been run against a real remote host by me; all plugin evidence is against the hermetic rig.
5. **ProxyJump (`-J`) is argv-verified only** (F14) — no bastion available.
6. **Real `~/.ssh/config` alias resolution is simulated** via `ssh -F` through the plugin's own `sshExecutable` (to avoid touching `~/.ssh`).
7. **`ssh_hosts` `check:true` unreachable branch** (`reachable:false` + `error`) not exercised.
8. **No large-transfer/soak** — 64 KiB transfers; caps exercised at 4096 and 1.
9. **`scp --` portability** verified on OpenSSH 10.6p1 only.
10. **Linux only**; no macOS/Windows.
11. **`presentCall` card shape** asserted only as "non-null object, does not throw".
12. **D1's remote-survival behaviour is asserted, not fixed** — out of scope for the frozen interface.
13. **Historical audit logs** still contain the pre-rename name (see §5) — I did not modify the profile, so I left them; they are inert.

## 9. Incident log — a write to the real `~/.ssh/known_hosts` (self-reported, fully reconciled)

- During the first e2e run of round 1, my own non-hermetic test design (redirecting `$HOME`, which this OpenSSH ignores in favour of the passwd home) caused `accept-new` to append `[127.0.0.1]:37569 ssh-ed25519 …` to the real `~/.ssh/known_hosts`. **My harness's bug, not a plugin defect.**
- A second line, `127.0.0.1 ssh-ed25519 …` (port 22, the system sshd), was **not** caused by my suite — no check in any round connected to port 22, and per-check attribution shows zero `~/.ssh` writes.
- **My remediation (round 1):** restored the file to its then-current bytes after verifying the hash *before* replacing it (`9d16f0dc…`, 3809 B, 20 lines). Damaged copy at `/tmp/known_hosts.damaged.bak`.
- **Lead's correction (round 2):** that state still contained a `localhost` line the Lead had caused earlier; the Lead removed it. The **true pre-session baseline** is **3718 bytes / 19 lines / sha256 `ab55f353bf185fd6f579544775cdbbbe22df26f7855bdfb2040744cdce4a7c52`**.
- **Current state (round 3):** `~/.ssh/known_hosts` matches that baseline exactly — verified before and after the round-3 suites. A9's per-run before/after fingerprinting is unaffected by the baseline change.
- **Harness fixes:** F13 pins `UserKnownHostsFile` to a temp file, F12 injects a private `ssh -F` config, and every check is wrapped in a per-check `~/.ssh` fingerprint guard.

Also cleaned up across all rounds: orphaned remote `sleep` processes from the timeout probes (a consequence of D1) were killed; no stray `sshd` and no leftover `/tmp/dsh-ssh-rig-*` or `/tmp/dsh-e2e-*` directories remain.

## 10. Revision hashes under test (`verification/out/plugin-revision.sha256`)

```
c5932b93e66fb6295d65a5aeb0f2059d136177d78026f6600b867b3fe3f12445  index.js
d7a037272b34a0c8f5896bc427131162998973888ad9ead3248f6c55367bbc8b  package.json
bc186cde97f3812b9f3d893c7dc9929f917d74dfe95ebebe91573efc4c543ee2  cordis.patch.yml
83e3b88fb5231f9db5f440e9c253312944c9ff1e8c6c5208d09a503d1facd36b  icon.svg
6a5038d0a9550da6f823a12ce25f975fe33bc78708073a0065cedaa359cb8b3a  README.md
561d45a4b3980fec9d8ff80d95abcc7329df9798f6668465958be6424e455073  lib/config.js
8b1298e4c297c5dd58ca6ee7a2e677205878e26f362d992848f7dcd7dd182853  lib/hosts.js
03c59857a062ac0b9c52a8d9a6448619d053e8f08bf76294d4ef9e2f57f3b0f1  lib/shell.js
688229060776c1ad00f2cce789a00d05b1f1eae120c3d73c9a79cdbdf3c419c1  lib/tools.js
59b53ab17996bbc242a59f113daba944a2547f98db75d22a9fabbe4c65804d0b  locale/en.json
d5954e51e27ff7c83e25c139c95749af99c930a323d8a24e781ec52a4fdddc1e  locale/zh.json
```

## Appendix — raw output of `node --test tests/rig/selftest.mjs`

Verbatim copy of `verification/out/selftest.txt` from the final round-3 run (exit code 0):

```
✔ rig exposes sane coordinates (198.967466ms)
✔ sshd log reports the listening port (0.647899ms)
✔ ssh runs a remote command with BatchMode and exit code 0 (150.597545ms)
✔ ssh propagates a non-zero remote exit code (160.306966ms)
✔ ssh honours a working directory and exported environment (164.029992ms)
✔ scp uploads and downloads byte-identical content (335.311091ms)
✔ scp -r uploads and downloads a directory tree (332.769487ms)
✔ rig never touches ~/.ssh (1.011818ms)
✔ stop removes the temp dir, kills sshd and frees the port (31.455644ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1433.824498
```

## Appendix — raw output of `node verification/static-check.mjs`

Verbatim copy of `verification/out/static-check.txt` from the final round-3 run (exit code 0):

```
PASS  S1-package-json                    package.json parses and declares the frozen manifest fields (0ms)  name=@junjiangao/dsh-plugin-remote-ssh version=1.0.0 files=6 exports=.,./locale/*.json,./icon,./cordis.patch.yml,./package.json
PASS  S2-no-dependencies                 package.json declares NO dependencies; only installation-scope peerDependencies (0ms)  dependencies={} optionalDependencies={} peerDependencies={"@deepseek-ai/dsh-tools":"*","@deepseek-ai/schemastery":"*"}
PASS  S3-referenced-files-exist          every file referenced by main/exports/files exists on disk (0ms)  5 referenced paths exist
PASS  S4-cordis-patch                    cordis.patch.yml parses as YAML and inserts exactly one remote-ssh row (1ms)  insert: id=remote-ssh name=@junjiangao/dsh-plugin-remote-ssh config={}
PASS  S5-locales                         locale/en.json and locale/zh.json parse and carry real meta copy (0ms)  en="Remote SSH" zh="远程 SSH"
PASS  S6-icon-svg                        icon.svg is well-formed SVG < 256 KiB with a viewBox and no external references (2ms)  1344 bytes, root=<svg>, 15 elements, viewBox present, 0 external refs
PASS  S7-node-check                      every .js/.mjs file passes `node --check` (5 files) (197ms)  5 files checked, 0 syntax errors
PASS  S8-bare-imports                    the only bare imports are @deepseek-ai/dsh-tools and @deepseek-ai/schemastery (0ms)  @deepseek-ai/schemastery x1, @deepseek-ai/dsh-tools x1
PASS  S9-tool-definitions                the REAL harness defineTool accepts all four definitions with frozen params (17ms)  4 tools registered: ssh_download, ssh_exec, ssh_hosts, ssh_upload
PASS  S10-no-legacy-name                 no stale pre-rename package reference remains anywhere in the repo (0ms)  0 files contain the pre-rename name (scanned the whole repo except .git/ and node_modules/)

static-check: 10 passed, 0 failed, 10 total (218ms)
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/static-check.json
```

## Appendix — raw output of `node verification/e2e.mjs`

Verbatim copy of `verification/out/e2e.txt` from the final round-3 run (exit code 0):

```
PASS  F0-registration                    apply() registers the four frozen tools with harness-valid schemas (6ms)  tools=ssh_download,ssh_exec,ssh_hosts,ssh_upload name=remote-ssh inject=["tools"]
PASS  F1-exec-success                    ssh_exec runs a command: exitCode 0, stdout captured, not timed out (144ms)  exitCode=0 stdout="RIG_OK" durationMs=142
PASS  F2-exec-exit-code                  ssh_exec propagates a non-zero remote exit code without throwing (154ms)  exitCode=42 propagated
PASS  F3-exec-cwd-env                    ssh_exec applies cwd and env, including single quotes and spaces (163ms)  env+cwd applied, pwd=/tmp/dsh-ssh-rig-WYJOYl/e2e-cwd
PASS  F4-exec-stdin-pty                  ssh_exec honours stdin and pty (-tt) (318ms)  stdin ok; pty -> /dev/pts/1
PASS  F5-exec-timeout                    ssh_exec timeout: timedOut=true, returns promptly, local child killed (6557ms)  timedOut after 1509ms (wall 1510ms); remote pid(s) still alive at that point: "268704"
PASS  O1-remote-outlives-kill            OBSERVATION: killing the local ssh child does NOT stop the remote command (4693ms)  remote command kept running and created its marker ~3s after the 1s timeout killed the client (documented in REPORT.md as a limitation of client-side cancellation)
PASS  F6-output-truncation               output is capped at maxOutputBytes and flagged truncated (156ms)  stdout=4096B (cap 4096), truncated=true
PASS  F7-transfer-roundtrip              ssh_upload then ssh_download returns byte-identical content (331ms)  65536B round trip byte-identical (sha256 729512428e966388...)
PASS  F8-transfer-recursive              ssh_upload/ssh_download with recursive:true move a directory tree (340ms)  recursive tree round trip ok
PASS  F9-hosts-listing                   ssh_hosts lists configured hosts and reports the resolved ssh path (2ms)  1 host (rig -> xyzhuanjian@127.0.0.1:43729), resolved=/usr/bin/ssh
PASS  F10-hosts-check                    ssh_hosts check:true probes reachability and reports latency (164ms)  reachable=true latency=162ms
PASS  F11-allowed-hosts                  allowedHosts rejects a non-matching target and accepts a matching glob (166ms)  denied with "remote-ssh: host \"rig\" (target \"xyzhuanjian@127.0.0.1\") is not permitted by allo"...; glob "r*" allowed
PASS  F12-raw-target-alias               raw targets work with NO config entry, via an ssh_config alias (168ms)  unconfigured alias RigAlias resolved by OpenSSH itself (private -F config), target passed verbatim
PASS  F13-default-accept-new             default strictHostKeyChecking=accept-new pins the host key (334ms)  accept-new pinned the rig key into the configured UserKnownHostsFile (accept_new_known_hosts); second call OK
PASS  F14-argv-shape                     buildSshArgv/buildScpArgv match the frozen argv contract (4ms)  ssh/scp argv, sq(), composeRemoteScript() and ConnectTimeout all match
PASS  F15-presentCall-render             presentCall and render run cleanly for every tool (477ms)  ssh_hosts: ssh executable: ssh (resolved: /usr/bin/ssh) | ssh_exec: ssh rig (xyzhuanjian@127.0.0.1) exited with code 0 in 152ms. | ssh_upload: Uploaded /tmp/dsh-e2e-Jafzh1/up.bin to rig:/tmp/dsh-ssh-rig- | ssh_download: Downloaded /tmp/dsh-e2e-Jafzh1/render-back.bin from rig:/tmp
PASS  F16-timeout-render-caveat          FIXED: a timed-out ssh_exec render carries the remote-may-still-run caveat (1555ms)  caveat present on timeout, absent on success; header="ssh rig (xyzhuanjian@127.0.0.1) timed out after 1206ms and was killed in 1206ms."
PASS  A1-metachar-target                 a target containing shell metacharacters is inert (no local shell, no injection) (32ms)  "127.0.0.1; touch /tmp/ds" -> exitCode=255 in 5ms; "127.0.0.1$(touch /tmp/ds" -> exitCode=255 in 5ms; "127.0.0.1`touch /tmp/dsh" -> exitCode=255 in 10ms; "127.0.0.1 && touch /tmp/" -> exitCode=255 in 11ms
PASS  A2-invalid-env-keys                invalid POSIX env keys are rejected before any process is spawned (2ms)  "BAD KEY" -> "remote-ssh: env key \"BAD KEY\" is not a valid POSIX environment variabl"; "1LEADING" -> "remote-ssh: env key \"1LEADING\" is not a valid POSIX environment variab"; "a-b" -> "remote-ssh: env key \"a-b\" is not a valid POSIX environment variable na"; "" -> "remote-ssh: env key \"\" is not a valid POSIX environment variable name"; "a.b" -> "remote-ssh: env key \"a.b\" is not a valid POSIX environment variable na"; GOOD:123 -> "remote-ssh: env value for \"GOOD\" must be a string"
PASS  A3-quoted-command-and-cwd          single quotes in command and cwd are preserved literally (149ms)  quotes preserved in command and in cwd "/tmp/dsh-ssh-rig-WYJOYl/we'ird dir"
PASS  A4-unreachable-host                a closed port fails fast with a structured error and no hang (23ms)  exitCode=255 in 16ms, stderr="ssh: connect to host 127.0.0.1 port 35639: Connection refused\r"
PASS  A5-abort-signal                    exec.signal cancels an in-flight command promptly (408ms)  aborted in 407ms, exitCode=255 signal=null
PASS  A6-dash-prefixed-path              FIXED: a relative transfer path starting with "-" now transfers (662ms)  dash upload+download byte-identical (24B), ordinary relative and absolute paths still OK
PASS  A7-nonexistent-cwd                 a nonexistent remote cwd fails structurally instead of hanging (162ms)  exitCode=1 in 162ms, stderr="Warning: Permanently added '[127.0.0.1]:43729' (ED25519) to "
PASS  A8-max-output-boundary             maxOutputBytes=1 is handled without crashing or unbounded output (144ms)  cap=1 honoured (stdout="a", truncated=true)
PASS  A9-no-ssh-writes                   nothing wrote to the real ~/.ssh during the whole run (1ms)  9 files in ~/.ssh, all byte-identical (incl. known_hosts); 0 of 25 checks wrote to ~/.ssh
PASS  A10-no-unhandled-rejections        no unhandled promise rejections escaped the plugin (0ms)  none

e2e: 28 passed, 0 failed, 28 total (17627ms)
total wall clock: 17627ms
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/e2e.json
```

# Independent verification — `@local/dsh-plugin-remote-ssh`

**Task:** `task-3` (owner: `plugin-verifier`) — **verification round 2, re-run after the plugin changed**.
**Verdict: PASS** — 0 open defects; both previously reported defects (D1, D2) are fixed and regression-tested. **No regression found from either fix.**
**Verified revision** (`verification/out/plugin-revision.sha256`): all 11 bundle files hashed before the final run and re-checked after; **the plugin source was never modified by the verifier**.

### What changed since round 1

Exactly three files, as declared; `package.json` is byte-identical to the round-1 revision:

| File | sha256 (round 1) | sha256 (round 2) | Change |
| --- | --- | --- | --- |
| `lib/shell.js` | `8987500f3319ed7f…` | `fd2fbff26232f84b0c91c0967cdc7e50a07824f46b78b272a97e06aa0fc6253d` | `buildScpArgv` now emits `-q -- src dst` (D2 fix) |
| `lib/tools.js` | `04713036ab44581a…` | `23210a7cd496433723064c7b3136583cfc99e4a3c9e4ea84aa7b3b7d36d4331e` | `renderExec` adds the "only the local client was terminated" caveat when `timedOut` (D1 fix) |
| `README.md` | `5813450912550f35…` | `86be6242f7b5c93b2f0e023b11f4d8d9b157c98eadf58b999581963e43f80053` | new `## Known limitations` section |

`index.js`, `package.json`, `cordis.patch.yml`, `icon.svg`, `lib/config.js`, `lib/hosts.js`, `locale/en.json`, `locale/zh.json` are unchanged.

| | |
| --- | --- |
| Plugin | `/work/Repos/github/dsh-plugin-remote-ssh` — `package.json` sha256 `a11478e529816ef8782a71ebacfced3b5b76dae2b1dead480a2da6a69e66c123` |
| Harness | `/home/xyzhuanjian/.local/opt/deepseek-harness/versions/0.2.1-alpha.5.20261016.2/resources/app.asar.unpacked/dsh` |
| Node / OpenSSH | v24.21.0 · OpenSSH_10.6p1 (`/usr/bin/ssh`, `/usr/bin/scp`, `/usr/bin/sshd`, `/usr/bin/ssh-keygen`) |
| Test peer | hermetic unprivileged sshd rig, `tests/rig` (`task-2`) |
| Live install | `desktop` profile, re-installed by the Lead at 23:09 (`remove_bundle` + `install_bundle` → `application: applied`, `enabled: true`) |

## Reproduce

```sh
cd /work/Repos/github/dsh-plugin-remote-ssh
node --test tests/rig/selftest.mjs          # rig self-test   -> exit 0
node verification/static-check.mjs          # checks S1..S9   -> exit 0
node verification/e2e.mjs                   # checks F0..A10  -> exit 0
```

Round-2 results: **selftest 9/9**, **static-check 9/9**, **e2e 28/28** (was 27; `F16` added). Raw outputs are saved verbatim in `verification/out/{selftest,static-check,e2e}.txt` and as JSON in `verification/out/{static-check,e2e}.json`.

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

| Check | Method | Evidence | Result | Notes |
| --- | --- | --- | --- | --- |
| S1 package.json | parse + assert frozen fields | `node verification/static-check.mjs` | **PASS** | name `@local/dsh-plugin-remote-ssh`, 1.0.0, private, `type: module`, `main: index.js`, `icon: ./icon.svg`, `dsh.bundle.patch: ./cordis.patch.yml`, `files` non-empty |
| S2 no runtime deps | assert `dependencies`/`optionalDependencies` empty | same | **PASS** | `dependencies={}`; `peerDependencies={"@deepseek-ai/dsh-tools":"*","@deepseek-ai/schemastery":"*"}` — required for a linked bundle, see §6 |
| S3 referenced files exist | resolve `main`+`exports`+`files` | same | **PASS** | 5 concrete referenced paths exist |
| S4 cordis.patch.yml | `js-yaml` parse (real parser from dsh install) | same | **PASS** | top-level array, exactly one `insert` row: `id: remote-ssh`, `name: @local/dsh-plugin-remote-ssh`, `config: {}` |
| S5 locales | JSON parse + content assertions | same | **PASS** | `en.meta.title="Remote SSH"`, `zh.meta.title="远程 SSH"`; descriptions non-empty, distinct, no placeholder tokens, zh contains CJK |
| S6 icon.svg | `saxes` SAX parse + regex audit | same | **PASS** | 1344 bytes (< 256 KiB), root `<svg>`, 15 elements, `viewBox` present, **0 external references** |
| S7 syntax | `node --check` per file | same | **PASS** | 5 bundle `.js` files, 0 syntax errors (re-run on the changed `lib/shell.js` and `lib/tools.js`) |
| S8 bare imports | source scan for non-relative imports | same | **PASS** | exactly `@deepseek-ai/dsh-tools` ×1 and `@deepseek-ai/schemastery` ×1 |
| S9 harness contract | real `defineTool` + `assertSupportedJsonSchema` | same | **PASS** | real `defineTool` accepts all four definitions; real schema validator accepts both `parameters` and `output.schema`; frozen parameter names and `required` sets match exactly |

## 3. Functional checks against the real rig (`node verification/e2e.mjs`)

| Check | Method | Result | Notes (raw) |
| --- | --- | --- | --- |
| F0 registration | `apply(fakeCtx, Config({}))` | **PASS** | 4 tools; `name=remote-ssh`, `inject=["tools"]` |
| F1 exec success | real rig, `echo RIG_OK` | **PASS** | `exitCode=0`, stdout `RIG_OK`, `timedOut=false`, `truncated=false` |
| F2 non-zero exit | `exit 42` | **PASS** | `exitCode=42` propagated, no throw |
| F3 cwd + env | `cwd`, env with spaces and `'` | **PASS** | spaces and single quotes preserved, `$PWD` == requested cwd |
| F4 stdin + pty | `cat` with `stdin`; `tty` with `pty:true` | **PASS** | stdin delivered; pty → `/dev/pts/1` (proves `-tt`) |
| F5 timeout | `sleep …`, `timeoutMs:1500` | **PASS** | `timedOut=true`, returned in **1507 ms**, `exitCode≠0` |
| F6 truncation | `yes A \| head -c 200000`, cap 4096 | **PASS** | stdout exactly **4096 B**, `truncated=true` |
| F7 transfer round trip | `ssh_upload` → `ssh_download`, 64 KiB pseudo-random | **PASS** | byte-identical (`sha256 729512428e966388…`) — **regression-checked after the `--` change** |
| F8 recursive transfer | `recursive:true` dir both ways | **PASS** | `a.txt`/`b.txt` content identical (`-r -q --` ordering works) |
| F9 hosts listing | `ssh_hosts {}` | **PASS** | 1 host `rig → xyzhuanjian@127.0.0.1:42777`; `resolvedSshExecutable=/usr/bin/ssh`; `allowedHosts=[]` |
| F10 hosts check | `ssh_hosts {check:true}` | **PASS** | `reachable=true`, `latencyMs=161` |
| F11 allowedHosts | deny list + `*` glob | **PASS** | denial message names `allowedHosts`; glob `r*` allowed |
| F12 raw target / alias | **no config entry**, alias via private `ssh -F` config | **PASS** | `target` passed verbatim as `RigAlias`; OpenSSH resolved it |
| F13 default `accept-new` | default policy, explicit temp `UserKnownHostsFile` | **PASS** | key pinned to the configured file; second call OK |
| F14 argv contract | real `buildSshArgv`/`buildScpArgv`/`sq`/`composeRemoteScript` | **PASS** | ssh argv unchanged; **scp argv now `… -r -q -- a b`**, with `--` asserted immediately before exactly two operands, exactly one `--`, nothing after them; a second no-port/no-recursive case also checked |
| F15 render/presentCall | real `output.render` + `presentCall` for all 4 tools | **PASS** | every render returns text blocks; every `presentCall` returns an object |
| **F16 timeout-render caveat (NEW)** | render of a timed-out `ssh_exec` | **PASS** | the caveat sentence `Only the local ssh client was terminated; the remote command may still be running on the remote host, so re-check the remote host before assuming it stopped.` is present on timeout, the timeout header is intact, and the caveat is **absent** for a successful call |

## 4. Adversarial checks

| Check | Attack | Result | Notes (raw) |
| --- | --- | --- | --- |
| A1 shell metacharacters in `host` | `127.0.0.1; touch …`, `$(…)`, backticks, `&&` | **PASS** | all 4 inert: `exitCode=255` in 6–12 ms; sentinel file never created ⇒ no local shell interpolation |
| A2 invalid env keys | `"BAD KEY"`, `1LEADING`, `a-b`, `""`, `a.b`, non-string value | **PASS** | all rejected in <2 ms with `remote-ssh: env key … is not a valid POSIX environment variable name`; no process spawned |
| A3 quoting | `"it's fine"` command; cwd `we'ird dir` | **PASS** | quotes preserved literally in both |
| A4 unreachable host | 127.0.0.1 on a closed port, ConnectTimeout 2 s | **PASS** | `exitCode=255` in **15 ms**, `Connection refused`, no hang |
| A5 abort signal | `exec.signal` aborted 400 ms into `sleep 60` | **PASS** | returned in **408 ms**, `timedOut=false` |
| **A6 `-`-prefixed transfer path** | relative `localPath: "-dashfile"` | **PASS — FIXED** | upload **and** download now succeed with byte-identical content (24 B); ordinary relative and absolute paths still succeed; `F14` asserts the `--` in the argv. Round 1 this returned `scp: unknown option -- a` / `exitCode=1`. |
| A7 nonexistent remote cwd | `cwd: /nonexistent/…` | **PASS** | `exitCode=1` in 154 ms; command did **not** run; no hang |
| A8 output boundary | `maxOutputBytes: 1` | **PASS** | stdout `"a"`, `truncated=true`, no crash |
| A9 no `~/.ssh` writes | recursive fingerprint (size+mtime+sha256) of `~/.ssh` before/after **each** check | **PASS** | 9 files byte-identical; **0 of 25 checks** touched `~/.ssh`; `known_hosts` sha256 `ab55f353…` unchanged before and after (true pre-session baseline, see §9) |
| A10 no unhandled rejections | process-level `unhandledRejection` collector | **PASS** | none |
| O1 remote outlives local kill | documented limitation, asserted explicitly | **PASS** | see D1 — behaviour is unchanged by the fix, which is documentation/render-level only |

## 5. Installed state (check 5) — re-confirmed after the 23:09 re-install

`cordis_inspect_query` was called with **no `input` argument** (this harness rejects any `input` with `"input" must be an object` — confirmed, see §8).

```
cordis_inspect_query platform=host provider=Tool method=listTools
```

All four tools are present in the live registry (79 tools total) and their parameter sets are **exactly as in round 1** (raw entries: `verification/out/installed-tools-ssh-raw.json`, re-extracted after the re-install):

| Tool | `parameters.properties` | `required` |
| --- | --- | --- |
| `ssh_hosts` | `check` | *(none)* |
| `ssh_exec` | `host, command, cwd, env, timeoutMs, pty, stdin` | `host, command` |
| `ssh_upload` | `host, localPath, remotePath, recursive, timeoutMs` | `host, localPath, remotePath` |
| `ssh_download` | `host, localPath, remotePath, recursive, timeoutMs` | `host, localPath, remotePath` |

**No frozen-interface deviation.** Corroborating install evidence: the profile `package.json` lists `"@local/dsh-plugin-remote-ssh": "link:/work/Repos/github/dsh-plugin-remote-ssh"` in both `dependencies` and `dsh.profile.bundles`; the profile `node_modules/@local/dsh-plugin-remote-ssh` is a symlink to the workspace.

The Lead separately confirmed in-harness behaviour of the *installed* generation (a live timed-out `ssh_exec` rendering the new caveat, and a live dash-prefixed `ssh_upload` with matching sha256). I did **not** rely on those claims: I reproduced both fixes independently at module level against the hermetic rig (F16, A6, F14) and verified `scp --` support directly with the system `scp` (§7).

## 6. Finding (Lead-requested): `peerDependencies` is required for a linked bundle

The original task-1 instruction said "declare NO dependencies **or peerDependencies**". That instruction is **wrong for a workspace-linked bundle** and the correction is **verified**:

1. First `install_bundle` (`.plugin-manager/logs/operation-XxE7Hi`, 22:50) linked the package as `1.0.0 <- ../../…/dsh-plugin-remote-ssh` with no `peerDependencies`, and activation failed with `Cannot find package '@deepseek-ai/schemastery' imported from /work/Repos/github/dsh-plugin-remote-ssh/lib/config.js`.
2. The only change between that and the successful install was adding
   `"peerDependencies": { "@deepseek-ai/dsh-tools": "*", "@deepseek-ai/schemastery": "*" }`.
3. `remove_bundle` + `install_bundle` then reported `application: applied`, `enabled: true` (`operation-m2SUtv`, 22:51).

Mechanism (Lead's diagnosis, corroborated by the evidence above): the harness resolves installation-scope packages for a *linked* bundle through its `routeLinked` path, which requires the importing package's own `package.json` to list the specifier — hence `peerDependencies`, not `dependencies`. pnpm itself warns it will **not** provide those peers to a linked dependency (`The linked in dependency will not resolve the peer dependencies from the target node_modules`), so the harness must be supplying them.

**Independently reproduced by me:** the live registry exposes all four tools (§5) and `dependencies` is still absent (S2). **Not independently reproduced by me:** the *failing* install — reproducing it would require editing the plugin's `package.json`, which is outside my write scope. The causal claim therefore rests on the Lead's install history plus my corroborating evidence; it is labelled *verified by install history + corroboration*, not *independently re-derived*.

## 7. Defect status after round 2

| ID | Round-1 severity | Status | Evidence |
| --- | --- | --- | --- |
| **D1** — timed-out command may keep running remotely | Low (informational) | **FIXED (documentation/render level); underlying behaviour intentionally unchanged** | `lib/tools.js` `renderExec` now pushes the caveat line when `timedOut`; `README.md` `## Known limitations` explains it and suggests self-limiting commands. Verified by `F16-timeout-render-caveat` (caveat present on timeout, absent on success) and `O1-remote-outlives-kill` (the remote process still survives the local kill — expected, since the plugin does not attempt a remote kill). **This is a known limitation, not a defect.** |
| **D2** — `scp` operand beginning with `-` misparsed | Low | **FIXED** | `lib/shell.js` `buildScpArgv` emits `-q -- src dst`. Verified by `F14-argv-shape` (argv assertion incl. exactly one `--` immediately before exactly two operands) and `A6-dash-prefixed-path` (dash-prefixed upload **and** download byte-identical; ordinary relative and absolute paths still work). |

**New defects found in round 2: none.** No regression from either fix:

- The `--` insertion does not break ordinary, absolute, recursive or remote-form operands — `F7`, `F8`, `F15`, `A6` all pass, and `-q --` / `-r -q --` orderings were additionally verified directly against `/usr/bin/scp`.
- The `renderExec` change does not leak into non-timeout renders (`F16` asserts absence) and does not alter the result value or its schema (`F15`, and every `callTool` validates the output against the real `output.schema`).
- `package.json`, the four tool names, every parameter name and every output field are unchanged; the live registry confirms it (§5).

### Independent confirmation of the `scp --` claim

Run directly against the system `scp` (no network), because the builder's claim underpins the D2 fix:

```
$ /usr/bin/scp -q -dash.txt out1.txt      -> /usr/bin/scp: unknown option -- a   (exit 1)
$ /usr/bin/scp -q -- -dash.txt out2.txt   -> exit 0, content "dash-content"
$ /usr/bin/scp -q -- ordinary.txt out3.txt-> exit 0, content "ordinary"
$ /usr/bin/scp -r -q -- tree tree-out     -> exit 0, tree-out/f.txt present
```

## 8. Unverified / limits

1. **Live dispatch from this session.** `Tool/listTools` shows the four tools as callable by this Agent, but my session's declared function set was fixed before the install, so I could not dispatch a live `ssh_exec` call from *this* session. The live-registry evidence (§5) and the harness-shaped invocation in `e2e.mjs` (real `validateJsonSchemaValue` on args and output, real `render`) are the strongest available substitutes. The Lead's in-harness calls exercise the live path but are **not** independent evidence, so they are reported as corroboration only.
2. **`Config.listConfigs` paging is unavailable.** Any `input` argument is rejected (`"input" must be an object`), so I could not filter the 217 live config entries for the `remote-ssh` row. Install evidence comes from the profile manifest and plugin-manager logs instead (§5, §6).
3. **The failing first install was not re-derived by me** (§6) — it would require editing the plugin's `package.json`, outside my write scope.
4. **`~/.ssh` / real-host behaviour is only lightly exercised.** Per instructions I ran exactly **one** read-only smoke check against the real `MyOracleCloud` alias (round 1): `echo SMOKE_OK; hostname; id -un` → `SMOKE_OK`, `instance-20260420-2200`, `xyzhuanjian`, exit 0. That was plain OpenSSH, **not** the plugin. The plugin has **never** been run against a real remote host by me; all plugin evidence is against the hermetic rig.
5. **ProxyJump (`-J`) is argv-verified only** (F14). No bastion was available, so no end-to-end jump-host connection was made.
6. **Real `~/.ssh/config` alias resolution is simulated, not exercised.** F12 uses a private config injected via `ssh -F` through the plugin's own `sshExecutable` setting, to avoid touching the user's `~/.ssh`. The plugin's behaviour (pass the target verbatim) is verified; OpenSSH's own alias resolution is exercised for real, just with a different config file.
7. **`ssh_hosts` `check:true` against unreachable hosts** (the `reachable:false` + `error` branch) was not exercised; only the reachable branch (F10) was.
8. **No long-running / large-transfer soak.** Transfers were 64 KiB; the 262144-byte default cap was exercised only via the smaller explicit caps (4096 and 1).
9. **`scp --` portability.** Verified on OpenSSH 10.6p1 only. `--` end-of-options is a long-standing getopt convention, but older `scp` builds were not tested; the README documents the dependency.
10. **Windows/macOS** behaviour is untested; only this Linux host.
11. **The `presentCall` card shape** (`{card:'generic', title, kind, rawInput}`) is asserted to be a non-null object and to not throw; it was not validated against the harness's presentation types (outside the frozen interface).
12. **D1's remote-survival behaviour is asserted, not fixed** — a remote kill is out of scope for the frozen interface and the plugin does not attempt one.

## 9. Incident log — a write to the real `~/.ssh/known_hosts` (self-reported, fully reconciled)

During the **first** e2e run of round 1, my own non-hermetic test design caused a write to the user's real `~/.ssh/known_hosts`:

- Check F13 originally relied on redirecting `$HOME`; this OpenSSH build resolves the home directory from the passwd entry, so `ssh` ignored `$HOME` and appended `[127.0.0.1]:37569 ssh-ed25519 …` to the real `known_hosts`. **This was my harness's bug, not a plugin defect** — the plugin passed exactly the options it was configured to pass (no `UserKnownHostsFile`), and OpenSSH's `accept-new` then did what it always does.
- A second line, `127.0.0.1 ssh-ed25519 …` (port **22**, i.e. the system sshd, which is listening on :22), was **not** caused by my suite — no check in either round connected to port 22, and the per-check attribution shows zero `~/.ssh` writes.
- **My remediation (round 1):** the file was restored to its then-current bytes, verified by hash *before* replacing it — `sha256 9d16f0dccbe6d2ba1da85361031a7686a80bf3d1c698de804ebe56b5524288eb`, 3809 bytes, 20 lines. The damaged copy is at `/tmp/known_hosts.damaged.bak`.
- **Lead's correction (round 2):** that 3809-byte state still contained one line the Lead had caused earlier (`localhost ssh-ed25519 …`, added by the Lead's first probe at 22:33). The Lead removed it, so the **true pre-session baseline** is now **3718 bytes / 19 lines / sha256 `ab55f353bf185fd6f579544775cdbbbe22df26f7855bdfb2040744cdce4a7c52`**.
- **Current state:** `~/.ssh/known_hosts` matches that baseline exactly (verified before and after the round-2 suites). A9's assertion is per-run before/after fingerprinting, so it is unaffected by the baseline change; it reports the baseline hash for reference.
- **Harness fixes (unchanged from round 1):** F13 pins `UserKnownHostsFile` to a temp file, F12 injects a private `ssh -F` config, and every check is wrapped in a per-check `~/.ssh` fingerprint guard (`A9-no-ssh-writes`).

Also cleaned up across both rounds: orphaned remote `sleep` processes created by the timeout probes (a direct consequence of D1) were killed; no stray `sshd`, and no leftover `/tmp/dsh-ssh-rig-*` or `/tmp/dsh-e2e-*` directories remain.

## 10. Revision hashes under test (`verification/out/plugin-revision.sha256`)

```
404ba62d4344be29cfdacead5c1bd62e00c67b1825e8d0c2f06dc1f16bbb0efb  index.js
a11478e529816ef8782a71ebacfced3b5b76dae2b1dead480a2da6a69e66c123  package.json
7547dc8fe5d821cf6320b78f8f6bf0db7954f75d02610d7cf141d51f81881d15  cordis.patch.yml
83e3b88fb5231f9db5f440e9c253312944c9ff1e8c6c5208d09a503d1facd36b  icon.svg
86be6242f7b5c93b2f0e023b11f4d8d9b157c98eadf58b999581963e43f80053  README.md
01d18089fd189fd7b55d473af7883f9eeafcd46311b4b302715cefb8d831899c  lib/config.js
8b9adb75c2b916c218bf60c8a3bd3b25c6b12bb8faf2afcddc021d7fdc0ace0a  lib/hosts.js
fd2fbff26232f84b0c91c0967cdc7e50a07824f46b78b272a97e06aa0fc6253d  lib/shell.js
23210a7cd496433723064c7b3136583cfc99e4a3c9e4ea84aa7b3b7d36d4331e  lib/tools.js
59b53ab17996bbc242a59f113daba944a2547f98db75d22a9fabbe4c65804d0b  locale/en.json
d5954e51e27ff7c83e25c139c95749af99c930a323d8a24e781ec52a4fdddc1e  locale/zh.json
```

## Appendix — raw output of `node --test tests/rig/selftest.mjs`

Verbatim copy of `verification/out/selftest.txt` from the final round-2 run (exit code 0):

```
✔ rig exposes sane coordinates (213.134574ms)
✔ sshd log reports the listening port (0.597746ms)
✔ ssh runs a remote command with BatchMode and exit code 0 (152.411882ms)
✔ ssh propagates a non-zero remote exit code (157.2605ms)
✔ ssh honours a working directory and exported environment (154.847792ms)
✔ scp uploads and downloads byte-identical content (309.435994ms)
✔ scp -r uploads and downloads a directory tree (309.594622ms)
✔ rig never touches ~/.ssh (1.170917ms)
✔ stop removes the temp dir, kills sshd and frees the port (29.395376ms)
ℹ tests 9
ℹ suites 0
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1390.822628
```

## Appendix — raw output of `node verification/static-check.mjs`

Verbatim copy of `verification/out/static-check.txt` from the final round-2 run (exit code 0):

```
PASS  S1-package-json                    package.json parses and declares the frozen manifest fields (0ms)  name=@local/dsh-plugin-remote-ssh version=1.0.0 files=6 exports=.,./locale/*.json,./icon,./cordis.patch.yml,./package.json
PASS  S2-no-dependencies                 package.json declares NO dependencies; only installation-scope peerDependencies (0ms)  dependencies={} optionalDependencies={} peerDependencies={"@deepseek-ai/dsh-tools":"*","@deepseek-ai/schemastery":"*"}
PASS  S3-referenced-files-exist          every file referenced by main/exports/files exists on disk (0ms)  5 referenced paths exist
PASS  S4-cordis-patch                    cordis.patch.yml parses as YAML and inserts exactly one remote-ssh row (1ms)  insert: id=remote-ssh name=@local/dsh-plugin-remote-ssh config={}
PASS  S5-locales                         locale/en.json and locale/zh.json parse and carry real meta copy (0ms)  en="Remote SSH" zh="远程 SSH"
PASS  S6-icon-svg                        icon.svg is well-formed SVG < 256 KiB with a viewBox and no external references (2ms)  1344 bytes, root=<svg>, 15 elements, viewBox present, 0 external refs
PASS  S7-node-check                      every .js/.mjs file passes `node --check` (5 files) (194ms)  5 files checked, 0 syntax errors
PASS  S8-bare-imports                    the only bare imports are @deepseek-ai/dsh-tools and @deepseek-ai/schemastery (1ms)  @deepseek-ai/schemastery x1, @deepseek-ai/dsh-tools x1
PASS  S9-tool-definitions                the REAL harness defineTool accepts all four definitions with frozen params (16ms)  4 tools registered: ssh_download, ssh_exec, ssh_hosts, ssh_upload

static-check: 9 passed, 0 failed, 9 total (215ms)
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/static-check.json
```

## Appendix — raw output of `node verification/e2e.mjs`

Verbatim copy of `verification/out/e2e.txt` from the final round-2 run (exit code 0):

```
PASS  F0-registration                    apply() registers the four frozen tools with harness-valid schemas (7ms)  tools=ssh_download,ssh_exec,ssh_hosts,ssh_upload name=remote-ssh inject=["tools"]
PASS  F1-exec-success                    ssh_exec runs a command: exitCode 0, stdout captured, not timed out (153ms)  exitCode=0 stdout="RIG_OK" durationMs=150
PASS  F2-exec-exit-code                  ssh_exec propagates a non-zero remote exit code without throwing (165ms)  exitCode=42 propagated
PASS  F3-exec-cwd-env                    ssh_exec applies cwd and env, including single quotes and spaces (161ms)  env+cwd applied, pwd=/tmp/dsh-ssh-rig-15LW8G/e2e-cwd
PASS  F4-exec-stdin-pty                  ssh_exec honours stdin and pty (-tt) (316ms)  stdin ok; pty -> /dev/pts/1
PASS  F5-exec-timeout                    ssh_exec timeout: timedOut=true, returns promptly, local child killed (6471ms)  timedOut after 1506ms (wall 1507ms); remote pid(s) still alive at that point: "263060"
PASS  O1-remote-outlives-kill            OBSERVATION: killing the local ssh child does NOT stop the remote command (4687ms)  remote command kept running and created its marker ~3s after the 1s timeout killed the client (documented in REPORT.md as a limitation of client-side cancellation)
PASS  F6-output-truncation               output is capped at maxOutputBytes and flagged truncated (158ms)  stdout=4096B (cap 4096), truncated=true
PASS  F7-transfer-roundtrip              ssh_upload then ssh_download returns byte-identical content (345ms)  65536B round trip byte-identical (sha256 729512428e966388...)
PASS  F8-transfer-recursive              ssh_upload/ssh_download with recursive:true move a directory tree (338ms)  recursive tree round trip ok
PASS  F9-hosts-listing                   ssh_hosts lists configured hosts and reports the resolved ssh path (2ms)  1 host (rig -> xyzhuanjian@127.0.0.1:42777), resolved=/usr/bin/ssh
PASS  F10-hosts-check                    ssh_hosts check:true probes reachability and reports latency (163ms)  reachable=true latency=161ms
PASS  F11-allowed-hosts                  allowedHosts rejects a non-matching target and accepts a matching glob (159ms)  denied with "remote-ssh: host \"rig\" (target \"xyzhuanjian@127.0.0.1\") is not permitted by allo"...; glob "r*" allowed
PASS  F12-raw-target-alias               raw targets work with NO config entry, via an ssh_config alias (160ms)  unconfigured alias RigAlias resolved by OpenSSH itself (private -F config), target passed verbatim
PASS  F13-default-accept-new             default strictHostKeyChecking=accept-new pins the host key (306ms)  accept-new pinned the rig key into the configured UserKnownHostsFile (accept_new_known_hosts); second call OK
PASS  F14-argv-shape                     buildSshArgv/buildScpArgv match the frozen argv contract (6ms)  ssh/scp argv, sq(), composeRemoteScript() and ConnectTimeout all match
PASS  F15-presentCall-render             presentCall and render run cleanly for every tool (489ms)  ssh_hosts: ssh executable: ssh (resolved: /usr/bin/ssh) | ssh_exec: ssh rig (xyzhuanjian@127.0.0.1) exited with code 0 in 162ms. | ssh_upload: Uploaded /tmp/dsh-e2e-9MP0dM/up.bin to rig:/tmp/dsh-ssh-rig- | ssh_download: Downloaded /tmp/dsh-e2e-9MP0dM/render-back.bin from rig:/tmp
PASS  F16-timeout-render-caveat          FIXED: a timed-out ssh_exec render carries the remote-may-still-run caveat (1560ms)  caveat present on timeout, absent on success; header="ssh rig (xyzhuanjian@127.0.0.1) timed out after 1207ms and was killed in 1207ms."
PASS  A1-metachar-target                 a target containing shell metacharacters is inert (no local shell, no injection) (36ms)  "127.0.0.1; touch /tmp/ds" -> exitCode=255 in 6ms; "127.0.0.1$(touch /tmp/ds" -> exitCode=255 in 7ms; "127.0.0.1`touch /tmp/dsh" -> exitCode=255 in 12ms; "127.0.0.1 && touch /tmp/" -> exitCode=255 in 10ms
PASS  A2-invalid-env-keys                invalid POSIX env keys are rejected before any process is spawned (2ms)  "BAD KEY" -> "remote-ssh: env key \"BAD KEY\" is not a valid POSIX environment variabl"; "1LEADING" -> "remote-ssh: env key \"1LEADING\" is not a valid POSIX environment variab"; "a-b" -> "remote-ssh: env key \"a-b\" is not a valid POSIX environment variable na"; "" -> "remote-ssh: env key \"\" is not a valid POSIX environment variable name"; "a.b" -> "remote-ssh: env key \"a.b\" is not a valid POSIX environment variable na"; GOOD:123 -> "remote-ssh: env value for \"GOOD\" must be a string"
PASS  A3-quoted-command-and-cwd          single quotes in command and cwd are preserved literally (151ms)  quotes preserved in command and in cwd "/tmp/dsh-ssh-rig-15LW8G/we'ird dir"
PASS  A4-unreachable-host                a closed port fails fast with a structured error and no hang (21ms)  exitCode=255 in 15ms, stderr="ssh: connect to host 127.0.0.1 port 46247: Connection refused\r"
PASS  A5-abort-signal                    exec.signal cancels an in-flight command promptly (409ms)  aborted in 408ms, exitCode=255 signal=null
PASS  A6-dash-prefixed-path              FIXED: a relative transfer path starting with "-" now transfers (646ms)  dash upload+download byte-identical (24B), ordinary relative and absolute paths still OK
PASS  A7-nonexistent-cwd                 a nonexistent remote cwd fails structurally instead of hanging (154ms)  exitCode=1 in 154ms, stderr="Warning: Permanently added '[127.0.0.1]:42777' (ED25519) to "
PASS  A8-max-output-boundary             maxOutputBytes=1 is handled without crashing or unbounded output (166ms)  cap=1 honoured (stdout="a", truncated=true)
PASS  A9-no-ssh-writes                   nothing wrote to the real ~/.ssh during the whole run (0ms)  9 files in ~/.ssh, all byte-identical (incl. known_hosts); 0 of 25 checks wrote to ~/.ssh
PASS  A10-no-unhandled-rejections        no unhandled promise rejections escaped the plugin (0ms)  none

e2e: 28 passed, 0 failed, 28 total (17575ms)
total wall clock: 17575ms
wrote /work/Repos/github/dsh-plugin-remote-ssh/verification/out/e2e.json
```

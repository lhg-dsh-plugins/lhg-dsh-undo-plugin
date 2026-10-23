# BUGFIX — 0.5.0 → 0.5.1

## 标题

watcher 配置 echo 检测按 basename 匹配 spec：home 根 `cordis.patch.yml` 的撤销恢复被误判为真实变更，多出一份假 `patch-change` 自动快照并挡住 redo。

## 现象与根因

`cordis.patch.yml` 在快照范围清单（`lib/spec.json` 的 `configFiles`）里出现两次：profile 根一份、home 根一份，basename 相同。`lib/index.js` 的 watcher flush 处理配置事件时：

1. 先把事件压成纯 basename 列表（`configNames.push(file)`），事件所属目录 `dir` 被丢弃；
2. echo 检测（判断「这批写入是不是恢复动作自己写的」）用 `FILE_SPECS.find((s) => basename(s.rel) === filename)` 找 spec —— `find` 永远返回排在前面的 **profile** 条目，与事件实际来自哪个根无关。

后果分两种：

- **误判真实变更（主症状）**：undo 恢复的是 home 根补丁时，检测却去读 profile 根的补丁文件。profile 根没有该文件 → 读失败 → `allEcho=false`；profile 有但内容与本次恢复无关 → 哈希不一致 → 同样误判。恢复自己的写入于是被当成新变更存档：一份假 `patch-change` 自动快照出现在 pre-restore 快照之后，而 redo 的守卫是「pre-restore 之后有更新的快照即 blocked」，于是 **redo 被这份假快照挡住**，报 `redo blocked: newer changes exist after the undo`。插件核心承诺（撤销后可重做、恢复不自触发快照）对 home 根补丁失效。注意恢复写入的 watcher 事件在 `suppressAuto>0` 期间被 `schedule()` 吞掉、滞留在 `pending` 里，假快照通常在下一个无关文件事件冲刷 pending 时才出现，隐蔽性强。
- **误吞真实变更（镜像症状）**：恢复过 profile 补丁后，用户真实修改 home 根补丁，若 profile 文件仍与 restoredHashes 一致，该条会被判 echo，真实修改可能漏存档（与同批其他事件的判定结果有关）。

既有 e2e（`tools/e2e-watch.mjs`）的夹具里 profile 与 home 两根的被测文件 basename 互不重名（settings.yaml / profile 补丁走代码引用路径），故未覆盖此缺陷。

## 证据链

最小复现（独立脚本，夹具刻意只放 home 根 `cordis.patch.yml`、profile 根无此文件；改 home 补丁 → 自动快照 → undo → 写一个无关文件冲刷 pending → 查快照数与 redo）：

修复前输出（一行摘要）：`patch-change snapshots after undo: 2`（应为 1），且 `undo_restore failed: redo blocked: newer changes exist after the undo` —— VERDICT: BUG REPRODUCED。

修复后同一脚本：快照数 1 → 1，redo 成功并重新应用被撤销的变更 —— VERDICT: OK。

## 改动文件

- `lib/index.js`（唯一实现改动）：配置事件保留 `{dir, file}`；echo 检测的 spec 匹配加根目录条件 `rootDir(cfg, s.root) === dir`；`classifyChange` 调用改为传 basename 列表。附注释说明同名根因。
- `tools/e2e-watch-home-patch.mjs`（新增回归测试）：上述复现固化为 e2e，含四段断言（自动快照 / 恢复不自触发 / redo 成功 / 之后的真实变更仍存档），已接入 `npm test` 链末尾。
- `tools/smoke-test.mjs`：W42 的版本冻结断言由上游定稿的 `0.5.0` 同步为本 fork 的 `0.5.1`（仅版本字面量与标签，断言其余部分未动）。
- `package.json`：version 0.5.0 → 0.5.1；repository.url 改指本 fork 落点仓；test 脚本追加新回归文件。
- `CHANGELOG.md`：顶部新增 [0.5.1] 修复条目（上游条目一字未动）。
- `README.md`：顶部追加 lhg fork 头（上游原文一字未删）。
- 新增 `UPSTREAM.md`、`BUGFIX.md`。`LICENSE` 与上游逐字一致。无 lock 文件（上游未提供），无包内版本戳常量需同步。

## 复验结果

- 基线（上游 HEAD，装好 peer 依赖 `@deepseek-ai/dsh-tools` 后）：`npm test` exit 0 全过；open issue 仅 #49（功能请求，非 bug）。
- 新回归测试基线对照：`git stash` 只回退 `lib/index.js` 的修复后单跑新 e2e → 3 passed / 3 failed（假快照出现、redo 被拦、redo 内容未恢复）；恢复修复后 6 passed / 0 failed。
- 修复后全量 `npm test` exit 0：smoke 545 passed、undo-server-smoke 9、home-resolution 三分支、e2e-watch 14，0 failed，与基线逐项一致；另新增 e2e-watch-home-patch 6 passed。（中间一度出现 smoke 544+1 failed，是版本号已 bump 而 W42 冻结断言未同步所致，同步后恢复 545 全过。）

## 验证边界

- 复现与回归均在本机 Node 24 + 临时目录夹具内离线完成，未依赖真实 DSH 宿主进程；watcher 时序用 300ms debounce + 定时等待，与上游 e2e 同口径。
- profile 根代码文件（#33 路径）的 echo 检测按 `profile:` 前缀单独实现，不受本次改动影响。
- 本版只修配置事件的根目录匹配；`pending` 集合以对象身份去重失效（同文件多次事件留多条）属既有无害冗余，未动。

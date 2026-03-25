# OpenClaw Sync Assistant 任务文档

## 1. 文档目的

本文档将最终目标拆解为可执行任务，用于指导后续实现、验收和迭代排期。

目标基准：

- 对齐 OpenClaw 迁移指南中的关键数据范围
- 支撑跨机器、跨实例的体验连续性
- 基于当前仓库的真实实现逐步演进，而不是重新设计一套脱离现状的方案

## 2. 当前能力快照

### 已具备

- 插件安装与加载入口
- GitHub 同步通道
- P2P 同步通道
- `Config/Auth/Workspace` 三类同步项
- `sync.setup`
- `sync.status`
- `sync.sync-now`
- `sync.conflicts`
- `sync.resolve-conflicts`
- 冲突预览、作用域过滤、逐文件确认
- 体验一致性与基线状态输出

### 未闭环

- `Sessions` 未纳入同步项
- `ChannelState` 未纳入同步项
- `WorkspaceFiles` 未细化为明确清单
- 没有迁移完成验证命令
- 没有同步方向建议与切换风险报告
- 没有回滚与恢复流程

## 3. 功能清单

### Epic A：同步对象模型

#### A1. 建立统一同步项注册表

- 为每个同步项定义：
  - `id`
  - `label`
  - `paths`
  - `sensitive`
  - `conflictPolicy`
  - `verificationRules`
- 初始同步项：
  - `Config`
  - `Auth`
  - `Sessions`
  - `ChannelState`
  - `WorkspaceFiles`

#### A2. 细化 WorkspaceFiles

- 明确工作区关键文件范围：
  - `MEMORY.md`
  - `USER.md`
  - `skills/`
  - `prompts/`
  - 其他与用户体验直接相关的工作区文件

#### A3. 建立路径探测策略

- 基于 `api.paths.stateDir` 和 OpenClaw 目录结构动态解析路径
- 对缺失路径给出“未发现 / 不适用 / 需要确认”的状态

## 4. 架构任务

### Epic B：同步编排层重构

#### B1. 抽象统一同步适配器接口

- `init()`
- `performSync(direction?)`
- `getStatus()`
- `getDiffSummary()`
- `stop()`

#### B2. 将同步项映射从硬编码迁移到注册表

- 当前 `src/github-sync.js` 与 `src/p2p-sync.js` 中的 `SYNC_ITEM_MAP`
- 改为共享同步项模型

#### B3. 增加同步方向判断

- 本地更新更多
- 远端更新更多
- 存在冲突风险
- 建议 `push / pull / manual review`

## 5. 用户能力任务

### Epic C：命令与状态能力

#### C1. 保留现有命令

- `sync.setup`
- `sync.status`
- `sync.sync-now`
- `sync.conflicts`
- `sync.resolve-conflicts`

#### C2. 新增命令

- `sync.verify-migration`
  - 检查迁移目标覆盖度
  - 输出缺失项、风险项、建议动作
- `sync.diff`
  - 输出本地与同步副本的简要差异摘要
- `sync.rebuild-index`
  - 重建同步对象缓存或基线快照

#### C3. 状态输出增强

- 展示同步对象覆盖率
- 展示本地/同步副本完整性
- 展示最近同步方向
- 展示迁移完成度
- 展示风险等级

## 6. 冲突治理任务

### Epic D：安全同步与冲突管理

#### D1. 按同步项分类冲突

- Config 冲突
- Auth 冲突
- Sessions 冲突
- ChannelState 冲突
- WorkspaceFiles 冲突

#### D2. 提供差异摘要

- 文本文件：显示简短 diff 预览
- 二进制或登录状态文件：仅显示元数据差异

#### D3. 高风险项策略

- `Auth`
- `ChannelState`
- `Sessions`

这些类型默认不允许无确认覆盖，需要：

- 预览
- 风险提示
- 逐项确认

#### D4. 回滚与恢复

- 为覆盖类操作保留恢复点
- 输出恢复路径
- 支持恢复最近一次冲突处理结果

## 7. 迁移验证任务

### Epic E：迁移体验验证

#### E1. 本地验证规则

- OpenClaw 状态目录可识别
- 关键同步项存在
- 工作区关键文件存在

#### E2. 目标副本验证规则

- 同步副本包含关键项
- 缺失项可识别
- 敏感项不完整时给出高优先级警告

#### E3. 新机器验收规则

- `openclaw status` 正常
- 主要会话存在
- 渠道无需重新配对
- 工作区文件完整
- 关键设置已恢复

#### E4. 迁移报告

- 通过项
- 风险项
- 失败项
- 建议修复动作

## 8. 测试任务

### Epic F：回归与验收

#### F1. 单元测试

- 同步项注册表解析
- 路径映射
- 覆盖度计算
- 基线检查
- 差异摘要

#### F2. 集成测试

- GitHub 模式首次同步
- GitHub 模式冲突处理
- P2P 模式首次同步
- P2P 模式远端更新拉取

#### F3. 场景测试

- 新机器冷启动迁移
- 增量同步
- 敏感项冲突
- 网络中断恢复
- 卸载清理

#### F4. 验证命令

- `npm test`
- `npm run lint`
- `npm run build`

## 9. 推荐开发顺序

### 里程碑 M1：补齐同步对象模型

- A1
- A2
- A3
- B2

### 里程碑 M2：迁移验证闭环

- C2 中的 `sync.verify-migration`
- C3
- E1
- E2
- E4

### 里程碑 M3：高风险同步治理

- D1
- D2
- D3
- D4

### 里程碑 M4：生产可用性验证

- B3
- E3
- F2
- F3

## 10. 交付标准

以下条件同时满足时，可认定插件接近“满足 OpenClaw 跨机器体验一致性需求”：

- 同步范围覆盖官方迁移关键对象
- 用户可通过命令验证迁移结果
- 冲突处理具备高风险保护
- GitHub 与 P2P 两种模式都能完成完整链路
- 新机器迁移场景有稳定回归测试

## 11. 当前建议优先级

P0：

- 增加 `Sessions`
- 增加 `ChannelState`
- 增加 `sync.verify-migration`

P1：

- 明确 `WorkspaceFiles` 清单
- 增加同步方向判断
- 增加差异摘要

P2：

- 回滚能力
- 恢复点管理
- 更完整的跨机验收脚本

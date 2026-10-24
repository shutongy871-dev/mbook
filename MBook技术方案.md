# MBook 技术方案 v1.0

> 基于《MBook产品方案》PRD 编写。本文档是开发施工的唯一技术依据：所有字段口径、公式、阈值均与 PRD 保持一致，PRD 未明确处标注【工程决策】。

---

## 1. 产品概述与技术目标

### 1.1 产品定位

MBook 是一款**轻量化 Web 阅读氛围音乐辅助工具**（Chrome/Chromium 浏览器扩展，Manifest V3）：AI 实时理解用户正在阅读的文字情绪，动态匹配用户自有音乐流（汽水/抖音/网易云等）中的歌曲，以 1.5 秒淡入淡出无缝过渡，复刻短视频 BGM 的沉浸感。

核心体验瞬间：读《三体》罗辑对星星说话的高潮段落时，音乐从低沉铺垫推高到燃点，用户完全没感觉到切歌。

### 1.2 技术目标（验收级非功能指标）

| 维度 | 指标 | 技术手段 |
|---|---|---|
| 实时性 | 情绪检测+切歌响应 < 2 秒；曲库增量更新 ≤ 1 小时 | 本地词典毫秒级兜底 + LLM 1.5s 超时；chrome.alarms 定时同步 |
| 轻量化 | 扩展打包体积 < 10MB，安装即用 | 无运行时框架冗余；CC0 音频低码率；无本地模型大包 |
| 稳定性 | 单一音乐源故障自动降级，**永远有声音**；不弹任何原生错误 | 多源 100ms 竞态切源；CC0 兜底；全局异常边界 |
| 兼容性 | Chrome 及主流 Chromium 浏览器；完美适配微信读书网页版 | MV3 标准 API；WXT 多浏览器打包能力预留 |
| 合规性 | 不下载/不存储/不传播完整音频文件，仅调平台官方播放能力；低频静默调用 | 只存 stream_url 不存音频；适配器限频+抖动 |
| 隐私 | 阅读内容、听歌数据全部本地存储不上传；AI 走用户自备 Key | IndexedDB 本地；BYOK（Bring Your Own Key）直连官方端点 |

### 1.3 四条架构设计原则

1. **无服务器优先**：不存在传统后端。其职责拆给三方——Service Worker（编排）、用户自带 LLM（智能）、平台接口（音乐）。
2. **降级永远可用**：任何一环失败（无 Key、断网、源挂、音频分析被静音）都有保底路径，T0 阶段仅靠 10 首 CC0 + 本地词典即可跑通完整闭环。
3. **适配器隔离变化**：音乐源、LLM 厂商、阅读载体全部藏在统一接口后面，单点可替换。
4. **字段单一口径**：每个字段只有一个产生环节、一套计算公式、一个存储位置（见第 7 章审计表）。

---

## 2. 总体架构

### 2.1 技术架构图

> 下图为占位，正式版以飞书画板呈现（插入于本节）。

### 2.2 链路数据流（一次阅读 → 一首歌）

> 下图为占位，正式版以飞书画板呈现（插入于本节）。

### 2.3 三个运行时上下文的职责边界

| 上下文 | 生命周期 | 能做什么 | 不能做什么 |
|---|---|---|---|
| Content Script | 随页面 | DOM 访问、滚动监听、接口拦截（MAIN world 注入）、悬浮球 UI | 不能播放音频（页面刷新即断）、不能跨域请求 |
| Service Worker | 30s 无事件可被休眠 | 编排决策、跨域 fetch（host_permissions）、alarms 定时、IndexedDB | **不能播放音频**、不能用 setTimeout 做长定时 |
| Offscreen Document | 扩展运行期间常驻 | AudioContext 播放/淡变、AnalyserNode 频谱分析 | 不做决策，只接收指令 |

---

## 3. 前端技术方案

### 3.1 技术栈选型

| 层 | 选型 | 为什么 | 替代方案 |
|---|---|---|---|
| 语言 | TypeScript 严格模式 | PRD 有 20+ 字段的硬契约（Song/Profile/LLM Schema），类型在编译期拦截字段错误 | 纯 JS（字段拼错无提示，不可接受） |
| 扩展框架 | WXT（基于 Vite） | 自动识别 background/content/popup/options/offscreen 入口、MV3 原生、HMR、一键出 Chrome+Firefox | Plasmo（抽象层厚）；手写 Vite+@crxjs（MV3 坑自踩） |
| UI 框架 | React 18 + TypeScript | Popup/Options/悬浮球三处界面表单复杂，生态成熟 | Vue 3（可行但组件生态略弱） |
| 样式 | Tailwind CSS + Shadow DOM | 快速还原玻璃拟态；Shadow DOM 隔离宿主站点（微信读书）样式污染 | CSS Modules |
| 状态 | Zustand | <3KB，三处上下文靠消息同步，无需 Redux 复杂度 | 自写单例订阅 |
| 音频 | 原生 Web Audio API + Meyda | crossfade 包络、30s 频谱、BPM/onset 检测必须直接操作音频图；Meyda 提供 spectral 特征 | tone.js（偏创作、过重） |
| 正文抽取 | @mozilla/readability | Firefox 阅读模式同款，PRD 的正文打分规则基本已实现 | 自写打分算法 |
| 电子书(v1.2) | epub.js | EPUB 解析事实标准 | — |
| 定时 | chrome.alarms | MV3 下 SW 会休眠，setInterval 不可靠 | ❌ 禁用 setTimeout/setInterval 做后台调度 |

### 3.2 四个扩展入口

| 入口 | 形态 | 职责 |
|---|---|---|
| `entrypoints/content.ts` | 内容脚本 | 采集阅读窗口、判定阅读状态、挂载悬浮球；MAIN world 注入 hook 微信读书 fetch/XHR |
| `entrypoints/background.ts` | Service Worker | 全链路编排、消息路由、alarms 注册、offscreen 生命周期管理 |
| `entrypoints/offscreen/` | 离屏文档 | 音频播放与分析的唯一载体 |
| `entrypoints/popup/`、`entrypoints/options/` | React 页面 | 控制面板（当前播放/情绪选择器/源登录/换一首）；设置页（全部算法参数可调） |

### 3.3 关键前端机制

- **微信读书双路抽取**：优先拦截章节内容接口响应缓存段落数组，IntersectionObserver（交叉比 ≥0.5）判定可见段落；接口失效时 DOM 抽取兜底。
- **阅读状态判定**：`is_reading = page_active AND stay≥3s AND scroll_speed≤0.35屏/秒 AND 可见文本≥80字`；focused（150–900 cpm）/ scanning / inactive 三态。
- **悬浮球**：Shadow DOM 内 React 渲染，收起态为半透明情绪 emoji 小球，拖拽位置记忆，不挡正文。
- **消息通道**：所有跨上下文消息经 `core/shared/messaging.ts` 统一类型定义，扩展重载后旧通道失效由全局异常边界吞掉（含 Extension context invalidated）。

---

## 4. 后端与外部服务方案

MBook **没有传统后端**。"后端能力"由三块外部服务 + 一个本地编排器承担。

### 4.1 LLM / Embedding：用户自备 Key，浏览器直连

| 项 | 方案 |
|---|---|
| 协议 | OpenAI 兼容协议（/chat/completions、/embeddings），一个 client 通吃 DeepSeek / 豆包 / Kimi / OpenAI |
| 配置 | endpoint + key 存 settings 表（用户在设置页填写）；为空则全程本地兜底，语义通道停用 |
| 输出校验 | zod 运行时强校验：情绪三维值域、18 枚举白名单、必填字段；越界/缺字段/非法标签即判失败 |
| 调用成本控制 | 歌曲一生只调 1 次 LLM + 1 次 embedding；文本侧同一 window_id 只调 1 次；打标队列每批 ≤20 首串行 |
| 一致性约束 | 文本侧与歌曲侧**必须共用同一 embedding 模型**（同一 client 保证），否则向量不可比 |
| 降级 | LLM 超时 1.5s → 词典结果先驱动播放；返回后 ΔE>0.25 补一次重评估；失败歌曲不进语义召回但仍可被情绪/标签通道选中 |

替代方案（远期可选）：自建 LLM 网关（用户免填 key、体验更好），但违背"文本不经第三方服务器"的隐私承诺且产生持续成本，MVP 不做。

### 4.2 音乐源：Service Worker 跨域直连

- **原理**：扩展声明各平台域名 host_permissions 后，SW 的 fetch 可跨域并自动携带用户在该平台的登录 cookie，无需代理服务器。
- **适配器接口**（`core/sources/source.types.ts`）：`fetchLibrary()` / `refreshStreamUrl()` / `probePlayable()` 三个方法，每个平台一个实现。
- **容灾**：源优先级 汽水＞抖音＞网易云＞QQ＞内置；单源 100ms 超时/失败自动切下一源，用户无感知；主版本起播失败 3s 内切 backup_sources。
- **同步**：授权后首次全量拉取元数据，之后每小时增量（alarms）；浏览器关闭期间任务不执行，**下次启动按时间戳差值补跑**。
- 🔴 **可行性提示**：汽水/抖音无面向个人的开放 API，网页接口带签名与风控；网易云 weapi 生态最成熟。MVP 源顺序：网易云 + CC0 先行，汽水/抖音先做 Spike 验证（见第 9 章）。

### 4.3 内置兜底

10 首 CC0 协议纯音乐打包进扩展（低码率约 3–6MB，在 10MB 预算内），T0 无授权时保证首屏 3 秒有声音；每首附带预置情绪画像。

### 4.4 LTR 模型的本地实现策略

PRD 要求"42 维 GBDT，插件内 WASM 推理，每 200 条样本增量重训"。【工程决策】分三步：

1. MVP：纯 TS 逻辑回归/FTRL（样本 <200 时 RankScore 直接取 TopsisScore，PRD 已给退路）；
2. 二期：纯 TS 浅层 GBDT（树深 3–4、≤50 树，几千样本重训 1–3 秒可接受）；
3. 三期：Rust 训练+推理编译 WASM（onnxruntime-web 只解决推理不解决训练）。

---

## 5. 数据存储方案与数据结构

### 5.1 三层存储模型

| 层 | 技术 | 内容 | 生命周期 |
|---|---|---|---|
| ① 持久层 | IndexedDB（Dexie.js） | 6 张表：曲库、画像、事件、场景统计、设置、模型 | 关机不丢（需保险，见下） |
| ② 会话层 | chrome.storage.session | 当前播放队列（预留 1 首预取：song_id + 未过期 stream_url）、会话调度状态 | 浏览器关闭自动清空 |
| ③ 内存音频层 | Offscreen 文档 | `<audio>` 元素、Web Audio 缓冲、AnalyserNode 实时频谱 | 关浏览器即消失；**音频字节依法从不落盘** |

**持久化两道保险**：manifest 声明 `unlimitedStorage` 权限（不计配额、不被回收）+ 启动时调用 `navigator.storage.persist()`。

正文隐私：阅读文本只在内存保留"当前窗口 + 前一窗口"，**不写入 IndexedDB**。

### 5.2 表结构总览

```
mbook（IndexedDB / Dexie）
├─ songs          主键 song_id；索引 dedup_key、last_matched_at、tag_version、blacklisted
├─ song_profiles  主键 song_id；情绪三维 / 标签 / 语义向量 / 音频特征
├─ user_events    自增主键；LTR 训练样本，保留 90 天
├─ scene_stats    主键 scene_bucket + song_id；场景适配累计值
├─ settings       单条记录；全部设置项与算法参数
└─ ltr_model      单条记录；模型二进制、样本数、上次训练时间
```

### 5.3 各表字段明细

#### 表 1：songs（歌曲主实体，归一化后的唯一真相）

| 字段 | 类型 | 取值来源 | 生成规则 | 下游用途 | 举例 |
|---|---|---|---|---|---|
| song_id | string | 本地生成 | md5(dedup_key) 前 16 位 | 全局主键 | "a3f9c2e81b7d4f01" |
| dedup_key | string | 本地生成 | norm(title)+"|"+norm(主歌手)+"|"+round(duration/3) | 跨源去重 | "intro\|thexx\|60" |
| source_channels | string[] | 拉取通道 | 多通道命中追加不覆盖 | 召回配额、偏好加权 | ["netease_playlist","soda_like"] |
| title / artist / album | string | 平台字段 | 按源优先级取首个非空；artist 取主歌手 | 展示、相似歌聚合 | "Intro / The xx / xx" |
| duration_sec | int | 平台 duration(ms) | ms/1000 四舍五入；缺失用音频解码时长补 | 硬过滤 60–600s | 128 |
| has_lyrics | bool | 平台歌词接口 | 非空即 true；不可用时按纯音乐标记推断 | 歌词策略、人声兜底 | false |
| language | enum | 平台 language | 缺失按标题字符集+歌词前 200 字判定 | 语种偏好过滤 | "instrumental" |
| bitrate_kbps / audio_format | int / enum | 播放地址元信息 | 取当前账号可用最高档 | 音质优选、QualityScore | 320 / "mp3" |
| stream_url / url_expire_at | string / ts | 平台播放接口 | 只存地址不落音频；过期前 60s 静默换新 | 播放 | "https://.../m4a?e=..." |
| playable | bool | 平台 status + 起播探测 | 任一源可播即 true；起播失败 3s 置 false 并写 load_fail | 硬过滤、容灾切源 | true |
| copyright_available | bool | 平台版权+地区限制字段 | 两者都不受限才 true | 硬过滤（合规底线） | true |
| backup_sources | array | 去重落选版本 | 同 dedup_key 的非主版本降级存入 | 主版本失败时 100ms 内切换 | [{source:"qq",url:"..."}] |
| added_at | ts | 平台收藏时间 | 缺失用首次拉取时间 | 新鲜度、新增同步统计 | 1788500000 |
| first_seen_at / last_matched_at | ts | 本地写入 | 入库写 first；每次被切歌选中刷新 last | 30 天淘汰、FreshnessScore | 1788500000 / 1788600000 |
| blacklisted | bool | 用户点踩/屏蔽 | 写入即生效，不进任何召回 | 硬过滤 | false |
| tag_version / profile_status | string / enum | 打标流水线写入 | status ∈ pending/audio_done/llm_done/failed | 重打标判断、降级使用 | "v3" / "llm_done" |

#### 表 2：song_profiles（歌曲 AI 画像）

| 字段 | 类型 | 来源 | 生成规则 | 下游用途 | 举例 |
|---|---|---|---|---|---|
| song_id | string | 关联 songs | 主键 | 关联 | "a3f9c2e8..." |
| emotion_vector | object | LLM(0.5)+音频(0.3)+平台标签(0.2) | 三源加权融合，缺源权重重归一化 | 情绪召回、EmotionScore | {v:-0.25,a:0.48,t:0.78} |
| music_tags | array | LLM(0.45)+平台(0.25)+歌单(0.20)+音频(0.10) | 加权投票，confidence≥0.4 才写入，可共存 | 标签召回、TagScore | [{tag:"紧张悬疑",c:0.81}] |
| semantic_text | string | LLM 输出 | 歌曲氛围的自由语义描述 | 展示、embedding 输入 | "冷感、克制、夜晚、低频铺垫" |
| semantic_embedding | float[] | embedding(semantic_text) | 与文本侧同一模型；失败置空 | 语义召回、SemanticScore | [0.12,-0.08,...]（1536 维） |
| audio_features | object | 首 30s 本地音频分析 | BPM=自相关onset；vocal_density=HPSS人声能量占比；dynamic_range；energy_curve（每5s RMS） | 硬过滤、ReadingFriendliness、惩罚项 | {bpm:82,vocal:0.1,dyn:0.32} |
| popularity_raw / popularity_score | float | 每 24h 统计 | 0.5z(7日播放)+0.3z(推荐曝光)+0.2z(歌单增量)，Sigmoid 压缩 | PopularityScore（仅进 TOPSIS） | 0.62 / 65 |
| platform_tags | string[] | 平台原生标签 | 直接映射入库 | 打标输入、映射表 | ["后摇","治愈"] |

#### 表 3：user_events（反馈事件流，LTR 训练样本）

| 字段 | 类型 | 来源 | 生成规则 | 下游用途 | 举例 |
|---|---|---|---|---|---|
| id | auto | 自增 | — | 主键 | 1024 |
| ts | ts | 事件发生时 | 客户端时间 | 时间衰减、90 天清理 | 1788600100 |
| window_id | string | 采集层 | hash(chapter_id+起始 paragraph_index) | 场景归因 | "text_window_001" |
| song_id | string | 播放层 | 当时播放歌曲 | 歌曲归因 | "a3f9c2e8..." |
| action | enum | 用户行为 | like/full_play/quick_skip/dislike/close_plugin/manual_switch | LTR 标签 y、Bandit reward | "full_play" |
| scene_bucket | string | 理解层 | valence3档×arousal3档×tension3档×content_type | SceneSongMatch 聚合键 | "v0_a1_t2_novel" |
| context_features | object | 决策时快照 | 42 维 LTR 特征中的上下文 6 维 | LTR 训练 | {state:"focused",cpm:420} |

保留策略：90 天滚动删除；每新增 200 条触发增量重训。

#### 表 4：scene_stats（场景×歌曲适配统计）

| 字段 | 类型 | 来源 | 生成规则 | 下游用途 | 举例 |
|---|---|---|---|---|---|
| scene_bucket | string | 理解层 | 联合主键之一 | SceneSongMatch | "v0_a1_t2_novel" |
| song_id | string | 播放层 | 联合主键之一 | 关联 | "a3f9c2e8..." |
| match_score | float | 反馈归因 | 完整播放+0.04/喜欢+0.08/跳过-0.08/点踩-0.12 | 偏好召回、PreferenceScore | 0.71 |
| play_count / complete_count / skip_count | int | 事件聚合 | 按 action 累计 | CompletionRate、SkipRate | 12 / 10 / 1 |
| updated_at | ts | 本地 | 每次反馈刷新 | 时间衰减 | 1788600100 |

#### 表 5：settings（单条配置）

| 字段 | 类型 | 默认值 | 对应算法参数 | 举例 |
|---|---|---|---|---|
| stable_windows_k / delta_e_threshold | int / float | 3 / 0.10（灵敏2/0.06，保守4/0.15） | 情绪稳定器 | 3 |
| update_interval_sec | int | 6（3–15） | LLM 调用节流 | 6 |
| window_size | int | 300 字（150–600） | visible_text 截断 | 300 |
| min_switch_interval_sec | int | 30（15–120） | 切歌冷却 | 30 |
| fade_out_ms / fade_in_ms | int | 1500（500–3000） | crossfade 包络 | 1500 |
| ai_strength | enum | 标准（W_semantic 0.28/W_tag 0.07） | RuleScore 权重重分配 | "standard" |
| llm_endpoint / llm_key | string | 空 | BYOK；为空走本地兜底 | "https://api.deepseek.com" |
| lyric_policy | enum | 优先纯音乐（max_vocal_density 0.4；只放纯音乐0.2；不限0.8） | 硬过滤+人声惩罚 | "instrumental_preferred" |
| bpm_ranges | object | 日常60–100/高潮80–120 | target_bpm_range | {calm:[60,100],peak:[80,120]} |
| style_blacklist | string[] | 空 | 硬过滤 style_blocked | [] |
| source_weight | enum | 均衡（抖音/汽水优先时对应通道 Top20→30） | 召回配额 | "balanced" |
| enabled_sources | string[] | 全部开启 | 多源优先级与容灾顺序 | ["netease","builtin"] |
| base_volume / autoplay | int / bool | 40 / true | 播放层（不参与打分） | 40 |
| auto_pause | bool | true | inactive 30s 暂停 | true |

#### 表 6：ltr_model（单条模型记录）

| 字段 | 类型 | 来源 | 生成规则 | 下游用途 | 举例 |
|---|---|---|---|---|---|
| model_binary | blob | 训练任务 | 序列化模型（MVP 为逻辑回归系数） | RankScore 推理 | (binary) |
| feature_version | string | 常量 | 42 维特征定义版本 | 特征对齐 | "f42_v1" |
| sample_count | int | user_events | 训练样本数；<200 不训练 | 冷启动判断 | 237 |
| last_trained_at | ts | 训练任务 | 每 +200 样本刷新 | 调度 | 1788600000 |

---

## 6. 核心代码逻辑（伪代码，与 PRD 公式逐字对齐）

### 6.1 歌曲归一化与去重

```text
norm(s) = 转小写 → 全角转半角 → 去空格标点 → 去 feat./(Live)/(Remastered)/【】等后缀
dedup_key = norm(title) + "|" + norm(primary_artist) + "|" + round(duration_sec / 3)

主版本选择（依次比较，先满足胜出）：
  1. playable=true AND copyright_available=true
  2. bitrate_kbps 更高
  3. audio_format: flac > m4a > mp3
  4. 源优先级: 汽水 > 抖音 > 网易云 > QQ > 内置
落选版本 → backup_sources[]，主版本起播失败 100ms 内切换

淘汰（每日 04:00，alarms 触发，启动时按时间戳补跑）：
  now - max(last_matched_at, first_seen_at) > 30天 → 删 song + song_profile
  被淘汰歌不进黑名单；再次拉取按新歌重新打标
```

### 6.2 阅读状态判定

```text
is_reading = page_active
  AND stay_duration_sec >= 3
  AND scroll_speed <= 0.35          // 屏/秒
  AND visible_text_length >= 80

reading_state =
  focused   if is_reading AND 150 <= reading_speed_cpm <= 900
  scanning  if scroll_speed > 0.35 OR stay < 3 OR cpm > 900
  inactive  if page_active = false

触发文本理解：reading_state=focused AND (window_id 变化 OR 距上次分析 >= update_interval)
scanning：只更新正文缓存，不调 LLM、不切歌
inactive：持续 >30s → playback_decision=pause（设置页可关）
```

### 6.3 情绪融合、趋势与稳定器

```text
// 三维各自独立融合，ok_* 为该来源本次是否有值(1/0)
V = (0.5*V_llm*ok_llm + 0.3*V_audio*ok_audio + 0.2*V_platform*ok_platform)
    / (0.5*ok_llm + 0.3*ok_audio + 0.2*ok_platform)   // 缺源自动重归一，缺失不当 0 分

// 本地词典兜底（约 800 词，毫秒级）
V_local = Σ(v_w * weight_w) / Σ(weight_w)   // A、T 同式
句式修正：连续！？→ A+0.1；省略号/破折号密度高 → T+0.1；短句率>0.6 → A+0.05
无命中词：沿用 last_emotion，窗口置信度记 0.3（不足以触发切歌）

// 趋势（相邻窗口差分）
ΔE = sqrt(0.3*ΔV² + 0.3*ΔA² + 0.4*ΔT²)
direction = rising_tension(ΔT≥+0.15) | easing(ΔT≤−0.15) | scene_turning(|ΔV|≥0.4)
          | building_up(ΔA≥+0.15 且 |ΔT|<0.15) | stable(其他)
trend_confidence = 0.6*(近3窗口 direction 一致数/3) + 0.4*min(1, ΔE/0.3)

// 情绪稳定器（切歌前置闸门）
stable_windows_count = 连续满足「direction 一致 AND ΔE≥0.1」的窗口数
允许切歌：stable_windows_count >= K(默认3)
硬闸门：任意 10 秒内切歌次数 ≤ 1，任何分数差不能突破
```

### 6.4 召回与硬过滤

```text
// 五通道并行，各 Top20 合并去重（2000 → 60）
D_emotion = sqrt(0.3*(Vt-Vs)² + 0.3*(At-As)² + 0.4*(Tt-Ts)²)   // < 阈值命中
TagSimilarity  = weighted_jaccard(文本标签, 歌曲标签)            // 权重取各自 confidence
SemanticSimilarity = cosine(text_embedding, song_embedding)
preference_match / freshness_match 同理走场景统计与时间衰减

// 硬过滤（60 → 20，pass/fail 不允许高分抵消）
pass_filter = playable AND copyright_available AND NOT blacklisted
  AND last_played_minutes > 30
  AND 60 <= duration_sec <= 600
  AND vocal_density <= max_vocal_density
  AND quality_score >= 0.7
```

### 6.5 精排打分与 FinalScore

```text
SemanticScore   = cosine(text_emb, song_emb) * 100        // 歌曲向量空 → TagScore*0.8 代偿
EmotionScore    = max(0, 100 * (1 - D_emotion / 0.6))
TagScore        = weighted_jaccard(T, S) * 100
ReadingFriendlinessScore = 100 - vocal_penalty - bpm_penalty - dynamic_penalty - energy_jump_penalty
FreshnessScore  = 100*(1-exp(-hours_since_last_played/12)) * (1-0.1*同歌手近1h播放次数)
QualityScore    = 100*(0.5*norm(bitrate) + 0.3*(1-load_fail_rate_7d) + 0.2*source_stability)
PopularityScore = 100/(1+exp(-popularity_raw))            // 无平台数据记 40

PreferenceScore = clip(40*SongAffinity + 20*SimilarSongAffinity + 20*SceneSongMatch
                 + 10*CompletionRate + 10*StyleAffinity - 30*SkipRate - 80*DislikeFlag, 0, 100)

// AHP 固化权重（CR=0.043<0.1，不随用户变化）
RuleScore = 0.28*Semantic + 0.24*Emotion + 0.20*ReadingFriendliness
          + 0.16*Preference + 0.07*Tag + 0.05*Quality
TopsisScore = D- / (D+ + D-)        // 8 指标向量归一后距理想解/最差解
RankScore   = LTR(42维特征)          // 样本<200 时 = TopsisScore
ExploreBoost = clip(100*(LinUCB(α=0.3) 探索项), 0, 10)   // 前50次决策 0.2→0.1 线性衰减
PenaltyScore = 5*(近5分钟切歌>2次) + 8*(同歌手连续第3首) + 10*(上次该歌被quick_skip)

FinalScore（T3 个性化阶段）=
  0.40*RankScore*100 + 0.30*TopsisScore*100 + 0.20*RuleScore + 0.10*ExploreBoost - PenaltyScore
```

### 6.6 切歌五条件

```text
score_gain = best_candidate_score - current_song_score
should_switch = stable_windows_count >= 3
  AND time_since_last_switch_sec >= 30
  AND current_song_play_duration_sec >= 45
  AND score_gain >= switch_threshold
  AND trend_confidence >= 0.75

should_preload = score_gain >= preload_threshold
  AND trend_direction in [rising_tension, scene_turning] AND NOT should_switch
// 预取：提前 15s 建下一首 audio 缓冲 3s，预取结果 60s 有效（本方案预留 1 首）

decision = switch | keep | preload | pause
transition: crossfade(默认) | hard_cut(手动换一首) | fade_pause(inactive)
```

### 6.7 播放过渡（等功率包络）

```text
淡出 gain = cos(π/2 * p)，淡入 gain = sin(π/2 * p)，p = 过渡进度 0→1
// 避免线性交叉在中段出现音量塌陷；重叠区 = min(1500ms, 当前歌剩余时长)
起播重试：3s 未起播 → 依次切 backup_sources → 全失败取 ranked 第 2 名；写 load_fail 压低 QualityScore
手动「换一首」：跳过五条件直接播 ranked 第 2 名，同时写 manual_switch 反馈
情绪手动选择器：选定情绪覆盖 emotion_vector/scene_tags，锁定 10 分钟，锁定期不调文本理解
```

### 6.8 反馈归因

```text
喜欢：     SongAffinity +0.05；场景 match +0.08；相似音色/BPM/曲风偏好 +0.02~0.04
完整播放： completion_rate 重算；reading_friendliness +0.03；场景适配 +0.04
快速跳过： 场景 match -0.08；高人声/高能量/快BPM 特征 -0.03~-0.04
点踩：     SongAffinity -0.2；场景 match -0.12；必要时 blacklisted=true
关闭插件： min_switch_interval +15s；switch_threshold +5；vocal_penalty +0.05
LinUCB reward：+1 完整播放 / +0.5 播≥60s / -0.5 手动切歌 / -1 跳过或点踩 / -2 关闭插件
```

### 6.9 冷启动四阶段

| 阶段 | 条件 | 生效逻辑 |
|---|---|---|
| T0 未授权 | 无音乐源 | 10 首 CC0 + 情绪通道；Preference/Rank/Explore 全中性化 |
| T1 授权 0–5 分钟 | 元数据已到、音频特征未完 | 平台标签+LLM 标签召回；缺音频特征 ReadingFriendliness 取 70；打标按"当次候选优先"后台补齐 |
| T2 样本<200 | LTR 不可训 | FinalScore = 0.60*Topsis*100 + 0.30*Rule + 0.10*Explore - Penalty |
| T3 样本≥200 | LTR 可用 | 恢复 6.5 完整公式，每 +200 样本增量重训 |

---

## 7. 字段消费审计（单字段单口径索引）

| 字段 | 含义 | 产生环节 | 消费环节 | 存储位置 |
|---|---|---|---|---|
| song_id / dedup_key | 歌曲主键 / 跨源去重键 | 入库归一化 | 全链路引用 | songs |
| playable / copyright_available / blacklisted | 可播·版权·拉黑三底线 | 平台字段+起播探测+用户操作 | 硬过滤 | songs |
| stream_url / url_expire_at | 播放地址与时效 | 平台播放接口 | 播放层；过期前 60s 换新 | songs（内存刷新） |
| backup_sources | 落选源版本 | 去重主版本选择 | 起播失败 100ms 切换 | songs |
| audio_features | BPM/人声密度/动态/能量曲线 | 首次播放本地音频分析 | 硬过滤、ReadingFriendliness、惩罚项 | song_profiles |
| song emotion_vector | 歌曲情绪三维 | LLM+音频+平台三源融合 | 情绪召回、EmotionScore | song_profiles |
| music_tags | 歌曲 18 枚举标签 | 四源加权投票 | 标签召回、TagScore、SceneSongMatch | song_profiles |
| song semantic_embedding | 歌曲氛围向量 | embedding(semantic_text)，一生一次 | 语义召回、SemanticScore | song_profiles |
| popularity_raw | 平台热度原始值 | 每 24h 统计 | PopularityScore（仅 TOPSIS） | song_profiles |
| last_matched_at | 上次被选中时间 | 切歌决策落库 | 重复播放硬过滤、Freshness、30 天淘汰 | songs |
| tag_version / profile_status | 标签版本/打标状态 | 打标流水线 | 重打标触发、降级使用 | songs |
| reading_window / window_id | 当前阅读窗口 | 文本采集 | 文本理解、LLM 节流 | 内存 |
| reading_state | focused/scanning/inactive | 采集规则判定 | 是否调 LLM、是否允许切歌 | 内存 |
| atmosphere_need.emotion_vector | 文本情绪三维 | LLM（失败词典兜底） | 情绪召回、EmotionScore | 内存 |
| scene_tags（文本侧） | 文本 18 枚举标签 | LLM 多标签分类 | 标签召回、TagScore、场景桶 | 内存 |
| semantic_text / embedding（文本侧） | 氛围音乐化描述及向量 | LLM 改写+embedding | 语义召回、SemanticScore | 内存 |
| music_constraints | BPM 区间/人声上限/纯音乐偏好 | content_type+情绪+设置规则推导 | 硬过滤上限、bpm/vocal 惩罚 | 内存 |
| trend / trend_confidence | 情绪趋势与置信度 | 相邻窗口差分 | 预取判断、切歌条件 | 内存 |
| candidate_songs / candidate_sources | 候选及入选通道 | 五通道召回 | 硬过滤、推荐理由解释 | 内存 |
| filtered_out / filter_reason | 被剔除歌与原因 | 硬过滤 | 问题排查"为什么没放这首" | 内存 |
| score_breakdown | 8 项单项分 | 精排 | 综合模型输入、归因定位 | 内存 |
| FinalScore / main_reason | 最终分与推荐理由 | Rank/Topsis/Rule/Explore/Penalty 合成 | 切歌决策 | 内存 |
| playback_decision | keep/preload/switch/pause | 五条件判定 | 播放层执行与过渡 | 日志 |
| user_features | Affinity/Completion/Skip/Style | 反馈归因更新 | 偏好召回、PreferenceScore、LTR | songs / user_events |
| scene_bucket / SceneSongMatch | 场景桶及适配度 | 情绪三维分档×content_type，反馈累加 | 偏好召回、PreferenceScore | scene_stats |
| switch_threshold / min_switch_interval | 切歌门槛与冷却 | 设置页初始化；关插件等负反馈上调 | 切歌决策 | settings |
| visible_text 等正文 | 阅读文本 | 采集 | 仅当前+前一窗口驻留内存 | **不入库** |

---

## 8. 项目目录结构与文件职责

```
mbook/
├─ package.json / wxt.config.ts / tsconfig.json / tailwind.config.ts
├─ assets/cc0/                       # 10 首 CC0 兜底音频 + manifest 预置画像
├─ entrypoints/
│  ├─ background.ts                  # SW 入口：决策编排、消息路由、alarms、offscreen 管理
│  ├─ content.ts                     # 内容脚本：采集注入、悬浮球挂载、MAIN world hook
│  ├─ popup/                         # 控制面板（React）
│  ├─ options/                       # 设置页（React）
│  └─ offscreen/                     # 常驻音频文档（html + ts）
├─ core/
│  ├─ shared/
│  │  ├─ contracts.ts                # 全部类型契约（Song/Profile/AtmosphereNeed/Decision…）
│  │  ├─ messaging.ts                # 跨上下文 typed 消息通道
│  │  ├─ logger.ts                   # 决策链路结构化日志
│  │  └─ errors.ts                   # 全局异常边界（吞掉含 context invalidated）
│  ├─ db/
│  │  ├─ dexie.ts                    # Dexie 实例、6 表 schema、版本迁移
│  │  ├─ songs.repo.ts               # songs CRUD + 索引查询
│  │  ├─ profiles.repo.ts            # song_profiles CRUD
│  │  ├─ events.repo.ts              # user_events 写入 + 90 天清理
│  │  └─ settings.repo.ts            # settings 单条读写 + 默认值
│  ├─ llm/
│  │  ├─ provider.ts                 # OpenAI 兼容 client（endpoint/key 来自 settings）
│  │  ├─ schemas.ts                  # zod 校验：歌曲打标/文本理解两套契约
│  │  └─ embedding.ts                # 文本与歌曲共用 embedding
│  ├─ sources/
│  │  ├─ source.types.ts             # MusicSourceAdapter 接口
│  │  ├─ netease.adapter.ts          # 网易云（MVP 首个外部源）
│  │  ├─ soda.adapter.ts / douyin.adapter.ts / qq.adapter.ts
│  │  ├─ builtin.adapter.ts          # CC0 内置源（最高可用）
│  │  ├─ sign/                       # 各平台签名算法
│  │  └─ source-router.ts            # 源优先级、100ms 竞态、合并去重
│  ├─ library/
│  │  ├─ normalize.ts                # norm() + dedup_key
│  │  ├─ dedup.ts                    # 主版本选择、backup_sources
│  │  ├─ sync.ts                     # 首次全量 + 每小时增量（alarms，启动补跑）
│  │  └─ eviction.ts                 # 每日 04:00 淘汰 30 天未匹配
│  ├─ tagging/
│  │  ├─ taxonomy.ts                 # 18 枚举 + tag_version + 平台标签映射表
│  │  ├─ audio-analysis.ts           # 30s 频谱：BPM/人声/动态/能量曲线（Spike 失败则空实现）
│  │  ├─ llm-tagger.ts               # 歌曲 LLM 打标（一生一次，强制 Schema）
│  │  ├─ fuse-tags.ts                # V/A/T 融合、标签投票、流行度 sigmoid
│  │  └─ pipeline.ts                 # 打标状态机、批量节流（≤20 串行）、候选优先
│  ├─ reading/
│  │  ├─ extractors/weread.ts        # 微信读书：接口拦截 + IntersectionObserver + DOM 兜底
│  │  ├─ extractors/readability-extractor.ts  # 知乎/豆瓣/公众号/小说站
│  │  ├─ extractors/local-book.ts    # v1.2 TXT/EPUB（文件不出本地）
│  │  ├─ reading-state.ts            # is_reading / 三态判定
│  │  └─ windowing.ts                # visible_text 拼接、window_id、前后文
│  ├─ understanding/
│  │  ├─ text-llm.ts                 # 文本理解（窗口节流、1.5s 超时、ΔE 补评估）
│  │  ├─ keyword-dict.ts             # 800 词兜底词典 + 句式修正
│  │  ├─ emotion-fuse.ts             # 情绪融合 + trend 差分
│  │  ├─ stabilizer.ts               # K 窗口确认 + 10s 硬闸门
│  │  └─ constraints.ts              # music_constraints 规则推导
│  ├─ matching/
│  │  ├─ recall.ts                   # 五通道召回 Top20
│  │  ├─ hard-filter.ts              # 6 条硬过滤
│  │  ├─ scores.ts                   # 8 单项分 + 4 打扰惩罚
│  │  ├─ ahp.ts                      # AHP 权重常量
│  │  ├─ topsis.ts                   # TOPSIS 理想解距离
│  │  ├─ ltr.ts                      # RankScore（MVP 逻辑回归 → GBDT）
│  │  ├─ bandit.ts                   # LinUCB 探索
│  │  ├─ final-rank.ts               # FinalScore 合成 + T0–T3 阶段切换
│  │  └─ switch-decision.ts          # 切歌五条件
│  ├─ playback/
│  │  ├─ offscreen-client.ts         # SW 侧播放指令封装
│  │  ├─ audio-engine.ts             # AudioContext、双 GainNode 等功率 crossfade
│  │  ├─ preload.ts                  # 提前 15s 预取 1 首缓冲 3s
│  │  └─ failover.ts                 # 3s 重试 → backup → 第 2 名，写 load_fail
│  ├─ feedback/
│  │  ├─ event-logger.ts             # 6 类行为落库
│  │  ├─ preference-updater.ts       # 归因 delta 更新
│  │  ├─ ltr-trainer.ts              # 每 200 样本增量重训
│  │  └─ bandit-reward.ts            # 行为 → LinUCB reward
│  └─ ui/
│     ├─ player/                     # 悬浮迷你播放器（Shadow DOM）
│     ├─ popup/                      # 控制面板组件
│     └─ options/                    # 设置页组件
└─ tests/
   ├─ unit/                          # Vitest：归一化/打分/过滤/稳定器（全离线）
   └─ e2e/                           # Playwright 加载扩展跑阅读→切歌链路
```

---

## 9. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| 1 | 汽水/抖音无开放 API，签名与风控可能拦死；"永远是你爱听的歌"地基 | 🔴 | Step 0 Spike 预研；MVP 网易云（生态最成熟）+CC0 先行；失败降级为歌单链接导入；全部藏在 adapter 后 |
| 2 | 平台 CDN 流地址无 CORS 头 → AnalyserNode 被静音，BPM/人声/能量特征全失效 | 🔴 | Step 0 用真实流地址 30 分钟 Spike；失败则权重重归一（ok_audio=0），画像以平台标签+LLM 为主 |
| 3 | MV3 下 SW 休眠 + content 随刷新销毁，"歌不能停"是架构级难题 | 🔴 | offscreen document 承载 AudioContext；第一个 Spike 即验证"刷新 5 次+切标签 3 次音乐不断" |
| 4 | 微信读书接口/DOM 改版即挂 | 🟠 | 接口拦截 + DOM 双路；适配器隔离便于热修 |
| 5 | LLM 延迟抖动、首次打标成本冲击、坏输出 | 🟠 | 1.5s 超时词典兜底；打标队列严格串行+批量≤20+候选优先；zod 校验+1 次重试+降级 |
| 6 | 浏览器内训练 GBDT 工程量被低估 | 🟠 | MVP 逻辑回归代偿（PRD 已允许 <200 样本取 Topsis）；二期纯 TS GBDT；三期 WASM |
| 7 | 切歌体感（K/ΔE/阈值）无法单测验证 | 🟡 | 设置项全部可调；开发期自用一周调参；平均切歌间隔 <45s 看板提示 |
| 8 | IndexedDB 被浏览器静默回收/配额 | 🟡 | unlimitedStorage 权限 + persist()；events 90 天、歌曲 30 天淘汰真跑在 alarms |
| 9 | 扩展重载后 Extension context invalidated 等原生报错 | 🟡 | 所有异步调用包错误边界；SW 重启自愈；PRD 要求零原生弹窗 |

**Step 0 三个 Spike 是闸门**：0a offscreen 播放不断、0b CORS 频谱、0c 网易云取流，结论决定后续降级方案。

---

## 10. 外部依赖与分工

### 10.1 技术依赖清单

| 依赖 | 用途 | 形态 | 备注 |
|---|---|---|---|
| WXT + Vite | 扩展框架/构建 | npm 包 | 多浏览器打包预留 |
| React 18 / Zustand / Tailwind | UI 与状态 | npm 包 | — |
| Dexie.js | IndexedDB 封装 | npm 包 | 支持 schema 版本迁移 |
| @mozilla/readability | 通用网页正文抽取 | npm 包 | Firefox 阅读模式同款 |
| Meyda | 音频特征提取 | npm 包 | spectral centroid/flux/RMS |
| epub.js | v1.2 电子书 | npm 包 | — |
| zod | LLM 输出运行时校验 | npm 包 | — |
| Vitest / Playwright | 单测 / E2E | npm 包（dev） | — |
| LLM API | 文本理解+歌曲打标+embedding | 外部服务 | 用户自备 Key，OpenAI 兼容 |
| 网易云/汽水/抖音/QQ | 音乐元数据+播放流 | 外部服务 | 用户授权，host_permissions 直连 |
| 10 首 CC0 音乐 | 兜底素材 | 打包进扩展 | Pixabay/FMA 等，需确认授权条款 |

### 10.2 分工

| 事项 | AI 独立完成 | 需用户协助 |
|---|---|---|
| 全部代码、单测、文档 | ✅ | — |
| 网易云账号授权/登录态 | — | ✅ 扫码/cookie |
| LLM API Key | — | ✅ DeepSeek/豆包等 |
| Spike 0b/0c 失败后降级拍板 | 给方案 | ✅ 最终决策 |
| CC0 素材授权确认 | 筛选候选 | ✅ 确认条款 |
| Step 3/6"耳朵验收"体感 | — | ✅ 真实阅读验收 |

---

## 11. 施工计划

| 步骤 | 目标 | 交付物 | 验收要点 | 明确不做 |
|---|---|---|---|---|
| Step 0 风险 Spike（2–3 天） | 三个🔴变实锤 | 3 个最小实验（演进为正式代码） | 刷新5次+切标签3次音乐不断；频谱非零；网易云 ≥20 首元数据且 ≥1 首完整播放 | 不搭架构、不写算法 |
| Step 1 地基 | 扩展能装能响、数据关机不丢 | 脚手架+Dexie 6 表+offscreen 播放+Popup | 退浏览器重开设置还在；persisted()=true；无红错 | 不做采集/智能/外部源 |
| Step 2 阅读采集 | 知道用户读哪、读多快 | content 脚本+三态判定+Popup 调试区 | 微信读书/知乎抽取正确；三态切换准确 | 不做情绪/切歌 |
| Step 3 T0 闭环 | 读文字→情绪→CC0 自动切歌 | 词典+召回+过滤+TOPSIS+切歌五条件+crossfade | 平静/悲伤/紧张三段对照文本音乐走向正确；10s 内绝不切 2 次；无 Key 全程可用 | 不接 LLM/外部源/反馈 |
| Step 4 音乐源 | 网易云曲库入库+容灾 | adapter+归一去重+每小时同步+淘汰 | ≥50 首真实歌曲；断网自动回退 CC0 无报错；重开曲库还在 | 不做 LLM 打标 |
| Step 5 歌曲打标 | 每首歌 AI 画像 | LLM client+zod+融合+打标状态机 | 同歌不二次调 LLM；坏 key 重试 1 次后 failed 仍可匹配；tag_version+1 触发重打标 | 不做文本侧 LLM |
| Step 6 AI 文本理解 | 语义通道开通 | text-llm+语义召回+完整 FinalScore | 断网 1.5s 内词典顶上；同窗口不重复扣费；SemanticScore 生效 | 不做反馈学习 |
| Step 7 反馈学习 | 行为真实改变推荐 | 事件库+归因更新+LinUCB | 点踩歌永不再现；完播后场景分上升；关插件后门槛上调 | 不做 GBDT 训练 |
| Step 8 设置页+看板+打磨 | 完整产品形态 | Options 全参数+悬浮球+5 项看板+异常边界 | 每个设置项真实改变算法；打包 <10MB；零原生报错 | 不加新算法 |

---

## 12. 产品演进规划

| 版本 | 主题 | 内容 |
|---|---|---|
| v1.0（MVP） | T0–T3 闭环 | Step 0–8 全部内容；网易云+CC0 双源；本地词典+BYOK LLM；逻辑回归代偿 LTR |
| v1.1 | 个性化成熟 | 纯 TS 浅层 GBDT 上线；LinUCB 全量；数据看板完善；Firefox 打包（WXT 一键） |
| v1.2 | 阅读载体扩展 | 本地 TXT/EPUB 导入（epub.js，文件不出本地）；更多通用站点抽取规则 |
| v1.3 | 音乐源扩展 | 视 Spike 结论接入汽水/抖音；QQ 音乐；歌单链接导入兜底模式 |
| v2.0（远期） | 跨端与云 | opt-in 云同步（曲库画像/偏好跨设备，schema 已结构化预留）；移动端（采集层重写，core 逻辑平台无关可复用）；可选自建 LLM 网关（免填 Key 模式） |

**演进不被卡住的三个结构性保障**：

1. 音乐源/LLM/阅读载体全部适配器化，单点替换不动主链路；
2. tag_version 机制承载标签体系、embedding 模型、算法规则的持续升级（存量分批刷数）；
3. core 决策逻辑（理解/匹配/打分/反馈）与浏览器 API 解耦，为移动端/跨端复用留路。

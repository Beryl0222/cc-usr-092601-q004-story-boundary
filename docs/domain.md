# 领域约定

管理文化短视频事实主张、素材许可、翻译和渠道发布之间的引用事件。所有状态由领域事件折叠得到；`src/contracts.js` 只做信封与载荷字段的基础校验，`src/service.js` 承载业务不变量。所有发生时间必须携带时区，版本号从 1 开始递增，基础校验不改写调用方输入。

## 聚合与事件

- `source_record` 来源（含版本）：`SOURCE_REGISTERED`、`SOURCE_WITHDRAWN`
- `person_grant` 人物/素材授权：`GRANT_RECORDED`
- `fact_claim` 事实主张：`CLAIM_PROPOSED`、`CLAIM_ATTESTED`、`CLAIM_QUESTIONED`、`CLAIM_RESOLVED`
- `cultural_context` 文化语境：`CONTEXT_ATTACHED`
- `analogy_note` 类比说明：`ANALOGY_NOTED`
- `translation_candidate` 翻译候选：`TRANSLATION_PROPOSED`、`TRANSLATION_REVIEWED`
- `video_segment` 剪辑片段：`SEGMENT_PLANNED`、`SEGMENT_FROZEN`
- `channel_release` 渠道发布：`RELEASE_POSTED`、`RELEASE_QUARANTINED`、`RELEASE_ARCHIVED`
- `correction_notice` 纠错通知：`CORRECTION_ISSUED`、`CORRECTION_PROPAGATED`

## 来源与主张分级（四种声音）

`source_kind`：`testimony`（传承人口述）、`public_material`（公开资料）、`author_experience`（作者体验）、`analogy`（类比）。
`claim_kind`：`confirmed_fact`、`personal_experience`、`inference`、`analogy`。

- 撰稿人可以提出 `inference`，但推测、口述、体验、类比一律**不能登记为 `confirmed_fact`**（错误码 `speculation_not_fact`）。
- 每类主张冻结时必带限定语：
  - `confirmed_fact` → `source_attribution`
  - `personal_experience` → `oral_attestation`、`not_historical_conclusion`
  - `inference` → `writer_inference`
  - `analogy` → `analogy_note`
- 传承人只能对本人经历类主张作 `own_experience` 确认，且须先有 `own_experience_attestation` 授权；`historical_conclusion` 不接受传承人签署——确认自身经历不等于批准历史结论，历史结论由事实编辑在冻结时签署。

## 翻译双签

每个语种的翻译候选必须分别由 `fact_editor` 与 `cross_language_reviewer` 签署，且两人不得为同一人（`separate_signatures_required`）。中文仅需事实编辑。

## 片段冻结与发布

- `SEGMENT_FROZEN` 冻结片段实际引用的主张、限定语、各语种翻译候选与签署：来源撤回、存在未决争议、口述未经本人确认、类比缺说明、素材缺 `material_use` 授权、缺必带限定语或翻译未双签，均拒绝冻结。
- 冻结指纹（`content_hash`/`subtitle_hash`）即发布依据；`RELEASE_POSTED` 的指纹必须与冻结快照一致。
- 同一平台回执（`receipt_id`）重放且内容一致：幂等返回，不增加一次发布。
- 编号相同（渠道+片段槽位或回执）但片段指纹或字幕指纹不同：不覆盖在线版本，登记 `RELEASE_QUARANTINED` 隔离。

## 撤回与更正的范围化处置

- 来源撤回（`SOURCE_WITHDRAWN`）：不得据此新登记主张或确认；未发布稿（规划或已冻结但无在线发布）置为暂停。
- 结论更正（`CORRECTION_ISSUED`，`scope` 为 `unpublished`/`online`/`archived`）：
  - 未发布稿暂停（错误码 `unpublished_paused`/`claim_corrected`）；
  - 在线版本经后台任务 `propagateCorrection` 范围化下发 `CORRECTION_PROPAGATED`；
  - 已归档版本保留当时上下文（`retained_archive_receipts`，溯源中标记 `archived_context_retained`），不回改。
- 传播按回执设置检查点：成功记 `propagated`，传输失败记 `failed` 且不阻断后续渠道；故障恢复后重放事件流，已传播的跳过、未完成的继续。

## 查询

- `channelWording(channel_id, language)`：按渠道和语种返回可用措辞、必带限定（键与本语种措辞）和许可状态（`granted`/`missing`、`usable`/`correction_pending`/`source_withdrawn`/`archived_context_retained`）。
- `traceSubtitle(subtitle_hash)`：从任一句字幕指纹追到发布回执、冻结签署、每条主张的证据来源与版本、翻译候选及两位审校人、类比与语境、仍未确认的争议、更正及传播状态。
- 公开投影一律剥离 `private_contact` 等私人联系方式字段。

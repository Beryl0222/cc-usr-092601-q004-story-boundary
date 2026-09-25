# 领域约定

管理文化短视频事实主张、素材许可、翻译和渠道发布之间的引用事件。

聚合对象包括`source_record`、`fact_claim`、`video_segment`、`channel_release`。事件类型包括`SOURCE_REGISTERED`、`CLAIM_PROPOSED`、`TRANSLATION_REVIEWED`、`RELEASE_POSTED`、`CORRECTION_PROPAGATED`。所有发生时间都必须携带时区，版本号从 1 开始递增，基础校验不会改写调用方输入。

## 事件载荷

- `CLAIM_PROPOSED`：载荷还需包含 `claim_kind`, `source_ref`。
- `RELEASE_POSTED`：载荷还需包含 `channel_id`, `content_hash`。
- `CORRECTION_PROPAGATED`：载荷还需包含 `supersedes`, `scope`。

相同事件标识的业务幂等、冲突隔离和状态推进由上层服务负责；本仓库只定义可稳定交换的基础事实。

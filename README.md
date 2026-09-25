# 文化短视频事实边界台

管理文化短视频事实主张、素材许可、翻译和渠道发布之间的引用事件。

## 目录

- `contracts/domain.schema.json`：对象、事件和载荷字段约定。
- `data/sample.json`：可直接校验的联调样例。
- `src/`：基础契约校验与命令行入口。
- `tests/`：信封、时间、版本和事件载荷测试。
- `docs/domain.md`：领域对象与事件语义。

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例校验

```bash
npm run check:sample
```

样例有效时输出 `valid`；发现问题时逐行给出字段、代码和中文说明，并返回非零状态。

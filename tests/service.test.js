import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";
import { createService } from "../src/service.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const stream = JSON.parse(await readFile(new URL("../data/sample.stream.json", import.meta.url), "utf8"));

// 搭出一条可发布的完整故事线；各测试可在任意步骤前分叉。
function buildStory() {
  const svc = createService({ now: () => "2026-10-01T08:00:00+08:00" });
  const c = svc.commands;
  c.registerSource("s-pub", { source_kind: "public_material", source_version: 2, private_contact: "editor@example.invalid" });
  c.registerSource("s-t", { source_kind: "testimony", source_version: 1, person_id: "p1" });
  c.registerSource("s-an", { source_kind: "analogy", source_version: 1 });
  c.recordGrant({ person_id: "p1", grant_scope: "own_experience_attestation" });
  c.recordGrant({ person_id: "p1", grant_scope: "material_use", material_ids: ["m1"] });
  c.proposeClaim("c-fact", { claim_kind: "confirmed_fact", source_ref: "s-pub", wording: "地方志有载" });
  c.proposeClaim("c-exp", { claim_kind: "personal_experience", source_ref: "s-t", wording: "我十六岁分线" });
  c.attestClaim("c-exp", { person_id: "p1", attestation_scope: "own_experience" });
  c.proposeClaim("c-an", { claim_kind: "analogy", source_ref: "s-an", wording: "如同时装周走秀" });
  c.noteAnalogy({ claim_ref: "c-an", analogy_text: "仅为解释，不描述历史组织方式" });
  for (const [id, subject, candidate, qualifier_wording = {}] of [
    ["tr-fact-en", "c-fact", "recorded in the gazetteer", { source_attribution: "according to the gazetteer" }],
    ["tr-exp-en", "c-exp", "she handed out thread in her teens", {
      oral_attestation: "as she recalled",
      not_historical_conclusion: "this is her personal recollection, not a historical conclusion",
    }],
    ["tr-an-en", "c-an", "likened to a runway show", { analogy_note: "explanatory analogy only" }],
  ]) {
    c.proposeTranslation({ candidate_id: id, subject_ref: subject, language: "en", candidate, qualifier_wording });
    c.reviewTranslation({ candidate_id: id, subject_ref: subject, language: "en", reviewer_role: "fact_editor", reviewer_id: "fe" });
    c.reviewTranslation({ candidate_id: id, subject_ref: subject, language: "en", reviewer_role: "cross_language_reviewer", reviewer_id: "lr" });
  }
  c.planSegment({
    segment_no: "SEG-1",
    content_hash: "h-content-1",
    subtitle_hash: "h-sub-1",
    claim_refs: ["c-fact", "c-exp", "c-an"],
    material_refs: ["m1"],
  });
  c.freezeSegment({
    segment_no: "SEG-1",
    content_hash: "h-content-1",
    subtitle_hash: "h-sub-1",
    languages: ["en"],
    claim_refs: ["c-fact", "c-exp", "c-an"],
    required_qualifiers: ["source_attribution", "oral_attestation", "not_historical_conclusion", "analogy_note"],
    translations: {
      en: { "c-fact": "tr-fact-en", "c-exp": "tr-exp-en", "c-an": "tr-an-en" },
    },
    signatures: { fact_editor: "fe", cross_language_reviewer: "lr" },
  });
  return svc;
}

const postPayload = (overrides = {}) => ({
  channel_id: "ch-1",
  channel_language: "en",
  content_hash: "h-content-1",
  subtitle_hash: "h-sub-1",
  segment_ref: "SEG-1",
  receipt_id: "rcpt-1",
  ...overrides,
});

test("契约：载荷枚举值非法时被拒绝", () => {
  const e = { ...stream[0], payload: { source_kind: "rumor", source_version: 1 } };
  assert.ok(validateEvent(e, schema).some((x) => x.field === "payload.source_kind"));
});

test("契约：样例事件流全部通过基础校验", () => {
  for (const e of stream) assert.deepEqual(validateEvent(e, schema), []);
});

test("推测不能登记为事实；撰稿人可提推测", () => {
  const svc = buildStory();
  assert.throws(
    () => svc.commands.proposeClaim("bad", { claim_kind: "confirmed_fact", source_ref: "s-t", wording: "口述被当事实" }),
    (err) => err.code === "speculation_not_fact",
  );
  svc.commands.proposeClaim("c-guess", { claim_kind: "inference", source_ref: "s-t", wording: "撰稿人推测" });
  assert.equal(svc.state.claims.get("c-guess").claim_kind, "inference");
});

test("传承人只能确认自身经历，且须有授权；不能批准历史结论", () => {
  const svc = createService();
  svc.commands.registerSource("s", { source_kind: "testimony", source_version: 1, person_id: "p1" });
  svc.commands.proposeClaim("c", { claim_kind: "personal_experience", source_ref: "s", wording: "w" });
  assert.throws(
    () => svc.commands.attestClaim("c", { person_id: "p1", attestation_scope: "own_experience" }),
    (err) => err.code === "grant_required",
  );
  svc.commands.recordGrant({ person_id: "p1", grant_scope: "own_experience_attestation" });
  assert.throws(
    () => svc.commands.attestClaim("c", { person_id: "p2", attestation_scope: "own_experience" }),
    (err) => err.code === "not_the_bearer",
  );
  assert.throws(
    () => svc.commands.attestClaim("c", { person_id: "p1", attestation_scope: "historical_conclusion" }),
    (err) => err.code === "historical_conclusion_not_attestable",
  );
  svc.commands.attestClaim("c", { person_id: "p1", attestation_scope: "own_experience" });
  assert.deepEqual(svc.state.claims.get("c").own_attestations, ["p1"]);
});

test("翻译双签：同一人不能兼签，跨语种审校不可缺", () => {
  const svc = buildStory();
  svc.commands.registerSource("s2", { source_kind: "public_material", source_version: 1 });
  svc.commands.proposeClaim("c2", { claim_kind: "confirmed_fact", source_ref: "s2", wording: "w" });
  svc.commands.proposeTranslation({ candidate_id: "t2", subject_ref: "c2", language: "en", candidate: "w" });
  svc.commands.reviewTranslation({ candidate_id: "t2", subject_ref: "c2", language: "en", reviewer_role: "fact_editor", reviewer_id: "fe" });
  assert.throws(
    () => svc.commands.reviewTranslation({ candidate_id: "t2", subject_ref: "c2", language: "en", reviewer_role: "cross_language_reviewer", reviewer_id: "fe" }),
    (err) => err.code === "separate_signatures_required",
  );
  svc.commands.planSegment({ segment_no: "SEG-2", content_hash: "h2", subtitle_hash: "s2h", claim_refs: ["c2"] });
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "SEG-2", content_hash: "h2", subtitle_hash: "s2h", languages: ["en"],
      claim_refs: ["c2"], required_qualifiers: ["source_attribution"],
      translations: { en: { c2: "t2" } }, signatures: { fact_editor: "fe" },
    }),
    (err) => err.code === "cross_language_signature_required",
  );
});

test("未决争议阻止冻结；解决后可冻结", () => {
  const svc = createService();
  svc.commands.registerSource("s", { source_kind: "testimony", source_version: 1, person_id: "p1" });
  svc.commands.recordGrant({ person_id: "p1", grant_scope: "own_experience_attestation" });
  svc.commands.proposeClaim("c", { claim_kind: "personal_experience", source_ref: "s", wording: "w" });
  svc.commands.attestClaim("c", { person_id: "p1", attestation_scope: "own_experience" });
  svc.commands.questionClaim("c", { dispute_id: "d1", question: "年龄是否约数" });
  svc.commands.proposeTranslation({ candidate_id: "t", subject_ref: "c", language: "zh", candidate: "w" });
  svc.commands.reviewTranslation({ candidate_id: "t", subject_ref: "c", language: "zh", reviewer_role: "fact_editor", reviewer_id: "fe" });
  svc.commands.planSegment({ segment_no: "S", content_hash: "h", subtitle_hash: "sh", claim_refs: ["c"] });
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "S", content_hash: "h", subtitle_hash: "sh", languages: ["zh"],
      claim_refs: ["c"], required_qualifiers: ["oral_attestation", "not_historical_conclusion"],
      translations: { zh: { c: "t" } }, signatures: { fact_editor: "fe" },
    }),
    (err) => err.code === "open_dispute",
  );
  svc.commands.resolveClaim("c", { dispute_id: "d1", resolution: "reworded" });
  svc.commands.freezeSegment({
    segment_no: "S", content_hash: "h", subtitle_hash: "sh", languages: ["zh"],
    claim_refs: ["c"], required_qualifiers: ["oral_attestation", "not_historical_conclusion"],
    translations: { zh: { c: "t" } }, signatures: { fact_editor: "fe" },
  });
  assert.ok(svc.state.segments.get("S").frozen);
});

test("冻结校验：指纹、限定语、素材授权、类比说明", () => {
  const svc = buildStory();
  svc.commands.planSegment({ segment_no: "SEG-X", content_hash: "hx", subtitle_hash: "sx", claim_refs: ["c-fact"], material_refs: ["m-missing"] });
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "SEG-X", content_hash: "other", subtitle_hash: "sx", languages: ["en"],
      claim_refs: ["c-fact"], required_qualifiers: [],
      translations: { en: { "c-fact": "tr-fact-en" } }, signatures: { fact_editor: "fe", cross_language_reviewer: "lr" },
    }),
    (err) => err.code === "content_hash_mismatch",
  );
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "SEG-X", content_hash: "hx", subtitle_hash: "sx", languages: ["en"],
      claim_refs: ["c-fact"], required_qualifiers: [],
      translations: { en: { "c-fact": "tr-fact-en" } }, signatures: { fact_editor: "fe", cross_language_reviewer: "lr" },
    }),
    (err) => err.code === "qualifier_required",
  );
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "SEG-X", content_hash: "hx", subtitle_hash: "sx", languages: ["en"],
      claim_refs: ["c-fact"], required_qualifiers: ["source_attribution"],
      translations: { en: { "c-fact": "tr-fact-en" } }, signatures: { fact_editor: "fe", cross_language_reviewer: "lr" },
    }),
    (err) => err.code === "material_grant_required",
  );
});

test("回执重放不增加发布；指纹不同则隔离", () => {
  const svc = buildStory();
  const first = svc.postRelease(postPayload());
  assert.equal(first.status, "posted");
  const replay = svc.postRelease(postPayload());
  assert.equal(replay.status, "replayed");
  assert.equal(replay.event, null);
  assert.equal(svc.events().filter((e) => e.event_type === "RELEASE_POSTED").length, 1);

  const tampered = svc.postRelease(postPayload({ content_hash: "h-content-tampered" }));
  assert.equal(tampered.status, "quarantined");
  assert.equal(tampered.event.payload.reason, "receipt_content_mismatch");
  assert.equal(svc.events().filter((e) => e.event_type === "RELEASE_POSTED").length, 1);

  const otherSlot = svc.postRelease(postPayload({ receipt_id: "rcpt-2", subtitle_hash: "h-sub-cut" }));
  assert.equal(otherSlot.status, "quarantined");
  assert.equal(otherSlot.event.payload.reason, "fingerprint_mismatch");
});

test("来源撤回：未发布稿暂停、禁止新主张；在线版本不受暂停影响", () => {
  const unpublished = createService();
  unpublished.commands.registerSource("s", { source_kind: "public_material", source_version: 1 });
  unpublished.commands.proposeClaim("c", { claim_kind: "confirmed_fact", source_ref: "s", wording: "w" });
  unpublished.commands.planSegment({ segment_no: "D1", content_hash: "h", subtitle_hash: "sh", claim_refs: ["c"] });
  unpublished.commands.withdrawSource("s", { reason: "条目撤稿" });
  assert.deepEqual(unpublished.pausedDrafts().map((d) => d.segment_no), ["D1"]);
  assert.throws(
    () => unpublished.commands.proposeClaim("c2", { claim_kind: "confirmed_fact", source_ref: "s", wording: "w2" }),
    (err) => err.code === "source_withdrawn",
  );

  const online = buildStory();
  online.postRelease(postPayload());
  online.commands.withdrawSource("s-t", { reason: "传承人要求撤回口述" });
  assert.deepEqual(online.pausedDrafts(), []);
});

test("结论更正：未发布稿暂停，在线版本传播，归档版本保留上下文", async () => {
  const svc = buildStory();
  // 同一冻结片段发布到两个渠道；先归档其中一个。
  svc.postRelease(postPayload());
  svc.postRelease(postPayload({ channel_id: "ch-2", receipt_id: "rcpt-2" }));
  svc.commands.archiveRelease("rcpt-2");

  // 另一条尚未发布的规划稿引用同一主张，应被暂停。
  svc.commands.planSegment({ segment_no: "D2", content_hash: "hd", subtitle_hash: "sd", claim_refs: ["c-fact"] });
  svc.commands.issueCorrection("corr-1", { supersedes: "c-fact", scope: "online", reason: "勘误表撤回条目" });

  assert.deepEqual(svc.pausedDrafts().map((d) => d.segment_no), ["D2"]);
  assert.throws(
    () => svc.commands.freezeSegment({
      segment_no: "D2", content_hash: "hd", subtitle_hash: "sd", languages: ["en"],
      claim_refs: ["c-fact"], required_qualifiers: ["source_attribution"],
      translations: { en: { "c-fact": "tr-fact-en" } }, signatures: { fact_editor: "fe", cross_language_reviewer: "lr" },
    }),
    (err) => err.code === "claim_corrected",
  );

  const correction = svc.state.corrections.get("corr-1");
  assert.deepEqual(correction.retained_archive_receipts, ["rcpt-2"]);

  // 在线传播：第一次下发失败，记录 failed 检查点且不丢目标。
  let shouldFail = true;
  const first = await svc.propagateCorrection("corr-1", async () => {
    if (shouldFail) throw new Error("network down");
  });
  assert.equal(first[0].status, "failed");
  assert.deepEqual(svc.pendingPropagation("corr-1").map((p) => p.receipt_id), ["rcpt-1"]);

  // 故障恢复：用事件流重建服务，已传播的跳过，未完成的继续。
  const recovered = createService();
  recovered.replay(svc.events());
  shouldFail = false;
  const second = await recovered.propagateCorrection("corr-1", async () => {});
  assert.deepEqual(second.map((r) => [r.receipt_id, r.status]), [["rcpt-1", "propagated"]]);
  const again = await recovered.propagateCorrection("corr-1", async () => {
    throw new Error("must not be retried");
  });
  assert.deepEqual(again.map((r) => r.status), ["skipped_propagated"]);
});

test("渠道措辞查询：按语言返回措辞、必带限定、许可状态", () => {
  const svc = buildStory();
  svc.postRelease(postPayload());
  const [view] = svc.channelWording("ch-1", "en");
  assert.equal(view.claims.length, 3);
  const exp = view.claims.find((c) => c.claim_id === "c-exp");
  assert.equal(exp.wording, "she handed out thread in her teens");
  assert.deepEqual(exp.required_qualifiers, ["oral_attestation", "not_historical_conclusion"]);
  assert.equal(exp.permission, "granted");
  assert.equal(exp.status, "usable");
  // 限定语键保留供机器核对，本语种措辞来自 qualifier_wording。
  assert.equal(exp.qualifier_wording.not_historical_conclusion, "this is her personal recollection, not a historical conclusion");
  // 公开投影不泄露来源登记中的私人联系方式。
  assert.ok(!JSON.stringify(view).includes("editor@example.invalid"));
});

test("字幕溯源：追到证据、翻译选择、签署责任、争议与更正", async () => {
  const svc = buildStory();
  svc.postRelease(postPayload());
  svc.commands.questionClaim("c-exp", { dispute_id: "d-open", question: "新发现的异说，仍在核对" });
  svc.commands.issueCorrection("corr-9", { supersedes: "c-fact", scope: "online", reason: "表述更新" });
  await svc.propagateCorrection("corr-9", async () => {});

  const trace = svc.traceSubtitle("h-sub-1");
  assert.equal(trace.release.receipt_id, "rcpt-1");
  assert.deepEqual(trace.segment.signatures, { fact_editor: "fe", cross_language_reviewer: "lr" });
  const fact = trace.claims.find((c) => c.claim_id === "c-fact");
  assert.equal(fact.evidence.source_id, "s-pub");
  assert.equal(fact.evidence.source_version, 2);
  assert.equal(fact.translation.reviewers.cross_language_reviewer, "lr");
  assert.equal(fact.analogies.length, 0);
  assert.deepEqual(trace.unresolved_disputes.map((d) => d.dispute_id), ["d-open"]);
  const note = trace.correction_notes.find((n) => n.correction_id === "corr-9");
  assert.equal(note.propagated, true);
  assert.equal(note.disposition, "online_propagated");
  assert.ok(!JSON.stringify(trace).includes("editor@example.invalid"));
});

test("归档版本溯源保留当时上下文", () => {
  const svc = buildStory();
  svc.postRelease(postPayload());
  svc.commands.archiveRelease("rcpt-1");
  svc.commands.issueCorrection("corr-a", { supersedes: "c-fact", scope: "archived", reason: "后世研究修订" });
  const trace = svc.traceSubtitle("h-sub-1");
  assert.equal(trace.release.status, "archived");
  const note = trace.correction_notes.find((n) => n.correction_id === "corr-a");
  assert.equal(note.disposition, "archived_context_retained");
  assert.equal(note.propagated, false);
});

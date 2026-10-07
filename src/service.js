// 文化短视频事实边界台：事件溯源领域服务。
// 所有状态都由领域事件折叠得到；append() 先校验不变量再落事件，
// 故障恢复后重新折叠事件即可继续传播更正。

export class DomainError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.field = field;
  }
}

// 各主张种类必带的限定语键，渠道查询再把键翻译成本语种措辞。
export const REQUIRED_QUALIFIERS = {
  confirmed_fact: ["source_attribution"],
  personal_experience: ["oral_attestation", "not_historical_conclusion"],
  inference: ["writer_inference"],
  analogy: ["analogy_note"],
};

const KIND_BY_SOURCE = {
  public_material: "confirmed_fact",
  testimony: "personal_experience",
  author_experience: "personal_experience",
  analogy: "analogy",
};

const PRIVATE_KEYS = ["private_contact", "contact", "phone", "email"];

export function createService(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  let seq = 0;

  const state = {
    sources: new Map(),
    grants: new Map(), // person_id -> [{scope, material_ids}]
    claims: new Map(),
    disputes: new Map(),
    contexts: new Map(), // subject_ref -> [text]
    analogies: new Map(), // claim_id -> [text]
    translations: new Map(),
    segments: new Map(),
    releases: new Map(), // receipt_id -> release
    channelSlot: new Map(), // channel_id\x00segment_no -> receipt_id
    corrections: new Map(),
    events: [],
  };
  const versions = new Map(); // aggregate_id -> version
  const seenEventIds = new Set();

  function nextVersion(aggregateId) {
    const v = (versions.get(aggregateId) ?? 0) + 1;
    versions.set(aggregateId, v);
    return v;
  }

  function stripPrivate(value) {
    if (Array.isArray(value)) return value.map(stripPrivate);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([k]) => !PRIVATE_KEYS.includes(k))
          .map(([k, v]) => [k, stripPrivate(v)]),
      );
    }
    return value;
  }

  function getClaim(id) {
    const claim = state.claims.get(id);
    if (!claim) throw new DomainError("unknown_claim", `主张 ${id} 尚未登记`, "claim_ref");
    return claim;
  }

  function claimOpenDispute(claimId) {
    return [...state.disputes.values()].some((d) => d.claim_id === claimId && d.open);
  }

  function claimHasCorrection(claimId) {
    return [...state.corrections.values()].some((c) => c.supersedes === claimId);
  }

  function sourceWithdrawn(sourceId) {
    return state.sources.get(sourceId)?.withdrawn === true;
  }

  // ---- 事件折叠 ----
  function apply(e) {
    const p = e.payload;
    switch (e.event_type) {
      case "SOURCE_REGISTERED":
        state.sources.set(e.aggregate_id, {
          id: e.aggregate_id,
          source_kind: p.source_kind,
          source_version: p.source_version,
          person_id: p.person_id,
          withdrawn: false,
        });
        break;
      case "SOURCE_WITHDRAWN": {
        const s = state.sources.get(e.aggregate_id);
        if (s) s.withdrawn = true;
        for (const seg of state.segments.values()) {
          if (
            segmentTouches(seg, e.aggregate_id) &&
            segmentOnlineReceipts(seg.segment_no).length === 0
          ) {
            seg.paused = true;
            seg.pause_reasons.push(`source_withdrawn:${e.aggregate_id}`);
          }
        }
        break;
      }
      case "GRANT_RECORDED": {
        const list = state.grants.get(p.person_id) ?? [];
        list.push({ scope: p.grant_scope, material_ids: p.material_ids ?? [] });
        state.grants.set(p.person_id, list);
        break;
      }
      case "CLAIM_PROPOSED":
        state.claims.set(e.aggregate_id, {
          id: e.aggregate_id,
          claim_kind: p.claim_kind,
          source_ref: p.source_ref,
          wording: p.wording,
          own_attestations: [],
        });
        break;
      case "CLAIM_ATTESTED": {
        const claim = state.claims.get(e.aggregate_id);
        if (p.attestation_scope === "own_experience") claim.own_attestations.push(p.person_id);
        else claim.historical_conclusion_by = p.person_id;
        break;
      }
      case "CLAIM_QUESTIONED":
        state.disputes.set(p.dispute_id, {
          dispute_id: p.dispute_id,
          claim_id: e.aggregate_id,
          question: p.question,
          open: true,
        });
        break;
      case "CLAIM_RESOLVED": {
        const d = state.disputes.get(p.dispute_id);
        if (d) Object.assign(d, { open: false, resolution: p.resolution });
        break;
      }
      case "CONTEXT_ATTACHED": {
        const list = state.contexts.get(p.subject_ref) ?? [];
        list.push(p.context_text);
        state.contexts.set(p.subject_ref, list);
        break;
      }
      case "ANALOGY_NOTED": {
        const list = state.analogies.get(p.claim_ref) ?? [];
        list.push(p.analogy_text);
        state.analogies.set(p.claim_ref, list);
        break;
      }
      case "TRANSLATION_PROPOSED":
        state.translations.set(p.candidate_id, {
          candidate_id: p.candidate_id,
          subject_ref: p.subject_ref,
          language: p.language,
          candidate: p.candidate,
          qualifier_wording: p.qualifier_wording ?? {},
          reviews: {},
        });
        break;
      case "TRANSLATION_REVIEWED": {
        const t = state.translations.get(p.candidate_id);
        if (t) t.reviews[p.reviewer_role] = p.reviewer_id;
        break;
      }
      case "SEGMENT_PLANNED":
        state.segments.set(p.segment_no, {
          segment_no: p.segment_no,
          planned_content_hash: p.content_hash,
          planned_subtitle_hash: p.subtitle_hash,
          planned_claim_refs: p.claim_refs ?? [],
          material_refs: p.material_refs ?? [],
          frozen: null,
          paused: false,
          pause_reasons: [],
        });
        break;
      case "SEGMENT_FROZEN": {
        const seg = state.segments.get(p.segment_no);
        seg.frozen = {
          frozen_at: e.occurred_at,
          content_hash: p.content_hash,
          subtitle_hash: p.subtitle_hash,
          claim_refs: [...p.claim_refs],
          required_qualifiers: [...p.required_qualifiers],
          languages: [...p.languages],
          translations: JSON.parse(JSON.stringify(p.translations)),
          signatures: { ...p.signatures },
        };
        break;
      }
      case "RELEASE_POSTED": {
        const release = {
          receipt_id: p.receipt_id,
          channel_id: p.channel_id,
          channel_language: p.channel_language,
          segment_no: p.segment_ref,
          content_hash: p.content_hash,
          subtitle_hash: p.subtitle_hash,
          status: "posted",
          posted_at: e.occurred_at,
        };
        state.releases.set(p.receipt_id, release);
        state.channelSlot.set(`${p.channel_id}\0${p.segment_ref}`, p.receipt_id);
        break;
      }
      case "RELEASE_QUARANTINED": {
        const id = e.aggregate_id;
        state.releases.set(id, {
          receipt_id: id,
          channel_id: p.channel_id,
          segment_no: p.segment_no,
          content_hash: p.content_hash,
          subtitle_hash: p.subtitle_hash,
          status: "quarantined",
          reason: p.reason,
          posted_at: e.occurred_at,
        });
        break;
      }
      case "RELEASE_ARCHIVED": {
        const r = state.releases.get(p.receipt_id);
        if (r) r.status = "archived";
        break;
      }
      case "CORRECTION_ISSUED": {
        state.corrections.set(e.aggregate_id, {
          correction_id: e.aggregate_id,
          supersedes: p.supersedes,
          scope: p.scope,
          reason: p.reason,
          retained_archive_receipts: [],
        });
        for (const seg of state.segments.values()) {
          if (segmentTouches(seg, p.supersedes) && segmentOnlineReceipts(seg.segment_no).length === 0) {
            seg.paused = true;
            seg.pause_reasons.push(e.aggregate_id);
          }
        }
        for (const r of state.releases.values()) {
          if (r.status !== "archived") continue;
          const seg = state.segments.get(r.segment_no);
          if (segmentTouches(seg, p.supersedes)) {
            state.corrections
              .get(e.aggregate_id)
              .retained_archive_receipts.push(r.receipt_id);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function segmentTouches(seg, target) {
    if (!seg) return false;
    const refs = seg.frozen ? seg.frozen.claim_refs : seg.planned_claim_refs;
    return (
      refs.includes(target) || refs.some((r) => state.claims.get(r)?.source_ref === target)
    );
  }

  function segmentOnlineReceipts(segmentNo) {
    return [...state.releases.values()].filter(
      (r) => r.segment_no === segmentNo && r.status === "posted",
    );
  }

  function append(eventType, aggregateType, aggregateId, payload) {
    const eventId = payload.event_id ?? `evt-${++seq}`;
    if (seenEventIds.has(eventId)) {
      throw new DomainError("duplicate_event", `事件标识 ${eventId} 已存在`, "event_id");
    }
    const event = {
      event_id: eventId,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: payload.occurred_at ?? now(),
      payload: stripEventMeta(payload),
    };
    guard(event);
    event.version = nextVersion(aggregateId);
    seenEventIds.add(eventId);
    state.events.push(event);
    apply(event);
    return event;
  }

  function stripEventMeta(payload) {
    const { event_id: _a, occurred_at: _b, ...rest } = payload;
    return rest;
  }

  // ---- 不变量 ----
  function guard(e) {
    const p = e.payload;
    switch (e.event_type) {
      case "SOURCE_REGISTERED":
        if (state.sources.has(e.aggregate_id))
          throw new DomainError("already_exists", "来源已登记", "source_id");
        if (!Number.isInteger(p.source_version) || p.source_version < 1)
          throw new DomainError("positive_integer", "来源版本必须是正整数", "source_version");
        break;

      case "GRANT_RECORDED":
        if (!p.person_id)
          throw new DomainError("required", "授权必须指明人物", "person_id");
        if (!["own_experience_attestation", "material_use"].includes(p.grant_scope))
          throw new DomainError("unsupported_value", "授权范围未登记", "grant_scope");
        break;

      case "CLAIM_PROPOSED": {
        const source = state.sources.get(p.source_ref);
        if (!source)
          throw new DomainError("unknown_source", `来源 ${p.source_ref} 尚未登记`, "source_ref");
        if (source.withdrawn)
          throw new DomainError("source_withdrawn", "来源已撤回，不能据此新登记主张", "source_ref");
        if (
          p.claim_kind === "confirmed_fact" &&
          source.source_kind !== "public_material"
        ) {
          throw new DomainError(
            "speculation_not_fact",
            "口述、体验或类比不能登记为已确认事实；可登记为经历、推测或类比并携带限定语",
            "claim_kind",
          );
        }
        const expected = KIND_BY_SOURCE[source.source_kind];
        if (source.source_kind === "analogy" && p.claim_kind !== "analogy")
          throw new DomainError("kind_mismatch", "类比来源只能支撑类比说明", "claim_kind");
        if (expected && p.claim_kind !== expected && p.claim_kind !== "inference")
          throw new DomainError(
            "kind_mismatch",
            `${source.source_kind} 来源的主张种类应为 ${expected}（或撰稿人推测）`,
            "claim_kind",
          );
        break;
      }

      case "CLAIM_ATTESTED": {
        const claim = getClaim(e.aggregate_id);
        const source = state.sources.get(claim.source_ref);
        if (!source || source.withdrawn)
          throw new DomainError("source_withdrawn", "来源已撤回，不能再作确认", "source_ref");
        if (p.attestation_scope === "own_experience") {
          if (claim.claim_kind !== "personal_experience")
            throw new DomainError(
              "attestation_scope_mismatch",
              "只有个人经历类主张可由本人确认亲身经历",
              "attestation_scope",
            );
          if (source.person_id !== p.person_id)
            throw new DomainError(
              "not_the_bearer",
              "亲身经历只能由来源所指的本人确认",
              "person_id",
            );
          const granted = (state.grants.get(p.person_id) ?? []).some(
            (g) => g.scope === "own_experience_attestation",
          );
          if (!granted)
            throw new DomainError(
              "grant_required",
              "缺少本人经历口述授权，不能记录确认",
              "person_id",
            );
        } else {
          throw new DomainError(
            "historical_conclusion_not_attestable",
            "传承人确认自身经历不等于批准历史结论；历史结论由事实编辑在片段冻结时签署",
            "attestation_scope",
          );
        }
        break;
      }

      case "CLAIM_RESOLVED": {
        if (!state.disputes.has(p.dispute_id))
          throw new DomainError("unknown_dispute", "争议不存在", "dispute_id");
        break;
      }

      case "ANALOGY_NOTED":
        getClaim(p.claim_ref);
        break;

      case "TRANSLATION_PROPOSED":
        if (state.translations.has(p.candidate_id))
          throw new DomainError("already_exists", "翻译候选已存在", "candidate_id");
        break;

      case "TRANSLATION_REVIEWED": {
        const t = state.translations.get(p.candidate_id);
        if (!t)
          throw new DomainError("unknown_translation", "翻译候选不存在", "candidate_id");
        if (!p.reviewer_id)
          throw new DomainError("required", "审校必须指明签署人", "reviewer_id");
        if (t.reviews[p.reviewer_role] === p.reviewer_id)
          throw new DomainError("already_signed", "该角色已由此人签署", "reviewer_role");
        for (const [role, id] of Object.entries(t.reviews)) {
          if (id === p.reviewer_id && role !== p.reviewer_role)
            throw new DomainError(
              "separate_signatures_required",
              "事实编辑与跨语种审校必须分别签署，不能为同一人",
              "reviewer_id",
            );
        }
        break;
      }

      case "SEGMENT_PLANNED":
        if (state.segments.has(p.segment_no))
          throw new DomainError("already_exists", "片段编号已存在", "segment_no");
        break;

      case "SEGMENT_FROZEN":
        guardFreeze(p);
        break;

      case "RELEASE_POSTED":
        guardRelease(p);
        break;

      case "CORRECTION_ISSUED":
        if (!state.claims.has(p.supersedes) && !state.sources.has(p.supersedes))
          throw new DomainError(
            "unknown_target",
            "更正必须指向已登记的主张或来源",
            "supersedes",
          );
        if (state.corrections.has(e.aggregate_id))
          throw new DomainError("already_exists", "更正通知已存在", "correction_id");
        break;

      default:
        break;
    }
  }

  function translationApproved(candidateId, language, subjectRef) {
    const t = state.translations.get(candidateId);
    return (
      t &&
      t.language === language &&
      t.subject_ref === subjectRef &&
      t.reviews.fact_editor &&
      (language === "zh" || Boolean(t.reviews.cross_language_reviewer))
    );
  }

  function guardFreeze(p) {
    const seg = state.segments.get(p.segment_no);
    if (!seg) throw new DomainError("unknown_segment", "片段尚未规划", "segment_no");
    if (seg.frozen)
      throw new DomainError("already_frozen", "片段已冻结，不能再次冻结", "segment_no");
    if (p.content_hash !== seg.planned_content_hash)
      throw new DomainError("content_hash_mismatch", "冻结指纹必须与规划的片段一致", "content_hash");
    if (p.subtitle_hash !== seg.planned_subtitle_hash)
      throw new DomainError("subtitle_hash_mismatch", "冻结字幕指纹必须与规划一致", "subtitle_hash");

    const signatures = p.signatures ?? {};
    const factEditor = signatures.fact_editor;
    const crossReviewer = signatures.cross_language_reviewer;
    if (!factEditor)
      throw new DomainError("fact_editor_signature_required", "冻结必须有事实编辑签署", "signatures");
    const needsCrossLanguage = p.languages.some((l) => l !== "zh");
    if (needsCrossLanguage && !crossReviewer)
      throw new DomainError(
        "cross_language_signature_required",
        "跨语种发布必须有跨语种审校签署",
        "signatures",
      );
    if (crossReviewer && factEditor === crossReviewer)
      throw new DomainError(
        "separate_signatures_required",
        "事实编辑与跨语种审校必须是两人",
        "signatures",
      );

    for (const claimId of p.claim_refs) {
      const claim = getClaim(claimId);
      const source = state.sources.get(claim.source_ref);
      if (source.withdrawn)
        throw new DomainError("source_withdrawn", `主张 ${claimId} 的来源已撤回`, "claim_refs");
      if (claimHasCorrection(claimId))
        throw new DomainError(
          "claim_corrected",
          `主张 ${claimId} 已有结论更正，未发布稿暂停`,
          "claim_refs",
        );
      if (claimOpenDispute(claimId))
        throw new DomainError("open_dispute", `主张 ${claimId} 仍有未解决争议，不能冻结`, "claim_refs");
      if (claim.claim_kind === "personal_experience" && claim.own_attestations.length === 0)
        throw new DomainError(
          "bearer_attestation_required",
          `口述主张 ${claimId} 未经本人确认，不能冻结`,
          "claim_refs",
        );
      if (claim.claim_kind === "analogy" && !(state.analogies.get(claimId)?.length > 0))
        throw new DomainError("analogy_note_required", `类比主张 ${claimId} 缺少类比说明`, "claim_refs");

      for (const q of REQUIRED_QUALIFIERS[claim.claim_kind] ?? []) {
        if (!p.required_qualifiers.includes(q))
          throw new DomainError(
            "qualifier_required",
            `主张 ${claimId} 冻结时必带限定语 ${q}`,
            "required_qualifiers",
          );
      }

      for (const language of p.languages) {
        const candidateId = p.translations?.[language]?.[claimId];
        if (!candidateId)
          throw new DomainError(
            "translation_required",
            `主张 ${claimId} 缺少 ${language} 语种候选`,
            "translations",
          );
        if (!translationApproved(candidateId, language, claimId))
          throw new DomainError(
            "translation_not_reviewed",
            `主张 ${claimId} 的 ${language} 翻译未经事实编辑与跨语种审校双签`,
            "translations",
          );
      }
    }

    for (const materialId of seg.material_refs) {
      const covered = [...state.grants.values()].some((list) =>
        list.some((g) => g.scope === "material_use" && g.material_ids.includes(materialId)),
      );
      if (!covered)
        throw new DomainError("material_grant_required", `素材 ${materialId} 缺少使用授权`, "material_refs");
    }
  }

  function guardRelease(p) {
    const seg = state.segments.get(p.segment_ref);
    if (!seg || !seg.frozen)
      throw new DomainError("segment_not_frozen", "只能发布已冻结片段", "segment_ref");
    if (p.content_hash !== seg.frozen.content_hash)
      throw new DomainError("content_hash_mismatch", "发布片段指纹与冻结快照不一致", "content_hash");
    if (p.subtitle_hash !== seg.frozen.subtitle_hash)
      throw new DomainError("subtitle_hash_mismatch", "发布字幕指纹与冻结快照不一致", "subtitle_hash");
    if (!seg.frozen.languages.includes(p.channel_language))
      throw new DomainError("language_not_frozen", "发布语种不在冻结快照内", "channel_language");
    if (seg.paused)
      throw new DomainError(
        "unpublished_paused",
        "来源撤回或结论更正尚未处置，未发布稿暂停发布",
        "segment_ref",
      );
  }

  // ---- 命令 ----
  const commands = {
    registerSource(id, payload) {
      return append("SOURCE_REGISTERED", "source_record", id, payload);
    },
    withdrawSource(id, payload) {
      if (!state.sources.has(id))
        throw new DomainError("unknown_source", "来源不存在", "source_id");
      return append("SOURCE_WITHDRAWN", "source_record", id, payload);
    },
    recordGrant(payload) {
      return append("GRANT_RECORDED", "person_grant", `grant:${payload.person_id}:${payload.grant_scope}`, payload);
    },
    proposeClaim(id, payload) {
      return append("CLAIM_PROPOSED", "fact_claim", id, payload);
    },
    attestClaim(claimId, payload) {
      return append("CLAIM_ATTESTED", "fact_claim", claimId, payload);
    },
    questionClaim(claimId, payload) {
      if (state.disputes.has(payload.dispute_id))
        throw new DomainError("already_exists", "争议已登记", "dispute_id");
      getClaim(claimId);
      return append("CLAIM_QUESTIONED", "fact_claim", claimId, payload);
    },
    resolveClaim(claimId, payload) {
      return append("CLAIM_RESOLVED", "fact_claim", claimId, payload);
    },
    attachContext(payload) {
      return append("CONTEXT_ATTACHED", "cultural_context", `ctx:${payload.subject_ref}`, payload);
    },
    noteAnalogy(payload) {
      return append("ANALOGY_NOTED", "analogy_note", `analogy:${payload.claim_ref}`, payload);
    },
    proposeTranslation(payload) {
      return append("TRANSLATION_PROPOSED", "translation_candidate", payload.candidate_id, payload);
    },
    reviewTranslation(payload) {
      return append("TRANSLATION_REVIEWED", "translation_candidate", payload.candidate_id, payload);
    },
    planSegment(payload) {
      return append("SEGMENT_PLANNED", "video_segment", `segment:${payload.segment_no}`, payload);
    },
    freezeSegment(payload) {
      return append("SEGMENT_FROZEN", "video_segment", `segment:${payload.segment_no}`, payload);
    },
    archiveRelease(receiptId, payload = {}) {
      if (!state.releases.has(receiptId))
        throw new DomainError("unknown_release", "发布不存在", "receipt_id");
      return append("RELEASE_ARCHIVED", "channel_release", receiptId, {
        ...payload,
        receipt_id: receiptId,
      });
    },
    issueCorrection(id, payload) {
      return append("CORRECTION_ISSUED", "correction_notice", id, payload);
    },
  };

  // 发布：平台回执重放幂等；编号相同但指纹/字幕不同则隔离，不新增发布。
  function postRelease(payload) {
    const seg = state.segments.get(payload.segment_ref);
    if (!seg || !seg.frozen)
      throw new DomainError("segment_not_frozen", "只能发布已冻结片段", "segment_ref");

    const byReceipt = state.releases.get(payload.receipt_id);
    if (byReceipt && byReceipt.status === "posted") {
      const same =
        byReceipt.content_hash === payload.content_hash &&
        byReceipt.subtitle_hash === payload.subtitle_hash &&
        byReceipt.channel_id === payload.channel_id;
      if (same) return { status: "replayed", event: null };
      return quarantine(payload, "receipt_content_mismatch");
    }

    if (
      payload.content_hash !== seg.frozen.content_hash ||
      payload.subtitle_hash !== seg.frozen.subtitle_hash
    ) {
      return quarantine(payload, "fingerprint_mismatch");
    }
    if (!seg.frozen.languages.includes(payload.channel_language))
      throw new DomainError("language_not_frozen", "发布语种不在冻结快照内", "channel_language");
    if (seg.paused)
      throw new DomainError(
        "unpublished_paused",
        "来源撤回或结论更正尚未处置，未发布稿暂停发布",
        "segment_ref",
      );

    const slotKey = `${payload.channel_id}\0${payload.segment_ref}`;
    const existingReceipt = state.channelSlot.get(slotKey);
    if (existingReceipt) {
      const existing = state.releases.get(existingReceipt);
      const same =
        existing.content_hash === payload.content_hash &&
        existing.subtitle_hash === payload.subtitle_hash;
      if (same) return { status: "replayed", event: null };
      return quarantine(payload, "fingerprint_mismatch");
    }

    const event = append("RELEASE_POSTED", "channel_release", payload.receipt_id, payload);
    return { status: "posted", event };
  }

  function quarantine(payload, reason) {
    const aggregateId = `quarantine:${payload.channel_id}:${payload.segment_ref}:${payload.receipt_id}`;
    const event = append("RELEASE_QUARANTINED", "channel_release", aggregateId, {
      channel_id: payload.channel_id,
      segment_no: payload.segment_ref,
      content_hash: payload.content_hash,
      subtitle_hash: payload.subtitle_hash,
      reason,
    });
    return { status: "quarantined", event };
  }

  // ---- 更正传播（后台任务，可恢复）----
  function affectedOnlineReleases(correction) {
    return [...state.releases.values()].filter(
      (r) =>
        r.status === "posted" &&
        segmentTouches(state.segments.get(r.segment_no), correction.supersedes),
    );
  }

  function propagationStatus(correctionId, receiptId) {
    return state.events.find(
      (e) =>
        e.event_type === "CORRECTION_PROPAGATED" &&
        e.payload.correction_id === correctionId &&
        e.payload.receipt_id === receiptId &&
        e.payload.status === "propagated",
    );
  }

  // transport 为实际下发渠道的适配器；抛错记 failed 并保留检查点，恢复后重试未完成部分。
  async function propagateCorrection(correctionId, transport) {
    const correction = state.corrections.get(correctionId);
    if (!correction) throw new DomainError("unknown_correction", "更正通知不存在", "correction_id");
    const results = [];
    for (const release of affectedOnlineReleases(correction)) {
      if (propagationStatus(correctionId, release.receipt_id)) {
        results.push({ receipt_id: release.receipt_id, status: "skipped_propagated" });
        continue;
      }
      try {
        await transport(release);
        const event = append("CORRECTION_PROPAGATED", "channel_release", release.receipt_id, {
          correction_id: correctionId,
          channel_id: release.channel_id,
          receipt_id: release.receipt_id,
          checkpoint: release.receipt_id,
          status: "propagated",
        });
        results.push({ receipt_id: release.receipt_id, status: "propagated", event });
      } catch (err) {
        const event = append("CORRECTION_PROPAGATED", "channel_release", release.receipt_id, {
          correction_id: correctionId,
          channel_id: release.channel_id,
          receipt_id: release.receipt_id,
          checkpoint: release.receipt_id,
          status: "failed",
          error: String(err?.message ?? err),
        });
        results.push({ receipt_id: release.receipt_id, status: "failed", event });
      }
    }
    return results;
  }

  // ---- 查询投影 ----

  // 按渠道和语种返回：可用措辞、必带限定与许可状态；公开查询隐藏私人联系方式。
  function channelWording(channelId, language) {
    const releases = [...state.releases.values()]
      .filter((r) => r.channel_id === channelId && r.channel_language === language)
      .filter((r) => r.status === "posted" || r.status === "archived");
    return releases.map((r) => {
      const seg = state.segments.get(r.segment_no);
      return {
        channel_id: channelId,
        language,
        receipt_id: r.receipt_id,
        segment_no: r.segment_no,
        release_status: r.status,
        claims: seg.frozen.claim_refs.map((claimId) => projectClaim(claimId, language, seg, r)),
      };
    });
  }

  function projectClaim(claimId, language, seg, release) {
    const claim = state.claims.get(claimId);
    const source = state.sources.get(claim.source_ref);
    const candidateId = seg.frozen.translations[language]?.[claimId];
    const translation = state.translations.get(candidateId);
    const correction = [...state.corrections.values()].find((c) => c.supersedes === claimId);
    const permission = claimPermission(claim, source, seg);
    const base = {
      claim_id: claimId,
      claim_kind: claim.claim_kind,
      wording: translation?.candidate ?? claim.wording,
      required_qualifiers: REQUIRED_QUALIFIERS[claim.claim_kind] ?? [],
      qualifier_wording: translation
        ? Object.fromEntries(
            (REQUIRED_QUALIFIERS[claim.claim_kind] ?? []).map((q) => [
              q,
              translation.qualifier_wording[q] ?? q,
            ]),
          )
        : {},
      permission,
      source: {
        id: source.id,
        source_kind: source.source_kind,
        source_version: source.source_version,
        withdrawn: source.withdrawn,
      },
    };
    const status = correction
      ? "correction_pending"
      : source.withdrawn
        ? "source_withdrawn"
        : release.status === "archived"
          ? "archived_context_retained"
          : "usable";
    return { ...base, status, correction_id: correction?.correction_id };
  }

  function claimPermission(claim, source, seg) {
    if (claim.claim_kind === "personal_experience") {
      const attested = claim.own_attestations.includes(source.person_id);
      const granted = (state.grants.get(source.person_id) ?? []).some(
        (g) => g.scope === "own_experience_attestation",
      );
      return attested && granted ? "granted" : "missing";
    }
    const materialsMissing = seg.material_refs.some(
      (m) =>
        ![...state.grants.values()].some((list) =>
          list.some((g) => g.scope === "material_use" && g.material_ids.includes(m)),
        ),
    );
    return materialsMissing ? "missing" : "granted";
  }

  function pausedDrafts() {
    return [...state.segments.values()]
      .filter((s) => s.paused)
      .map((s) => ({
        segment_no: s.segment_no,
        pause_reasons: [...s.pause_reasons],
        frozen: s.frozen !== null,
      }));
  }

  // 从任一句字幕（字幕指纹）追到证据、翻译选择、审核责任和未确认争议。
  function traceSubtitle(subtitleHash, { includePrivate = false } = {}) {
    const release = [...state.releases.values()].find(
      (r) => r.subtitle_hash === subtitleHash && (r.status === "posted" || r.status === "archived"),
    );
    if (!release) return null;
    const seg = state.segments.get(release.segment_no);
    const f = seg.frozen;
    const trace = {
      release: {
        receipt_id: release.receipt_id,
        channel_id: release.channel_id,
        channel_language: release.channel_language,
        status: release.status,
        posted_at: release.posted_at,
      },
      segment: {
        segment_no: seg.segment_no,
        content_hash: f.content_hash,
        subtitle_hash: f.subtitle_hash,
        frozen_at: f.frozen_at,
        signatures: f.signatures,
      },
      claims: f.claim_refs.map((claimId) => {
        const claim = state.claims.get(claimId);
        const source = state.sources.get(claim.source_ref);
        const candidateId = f.translations[release.channel_language]?.[claimId];
        const translation = state.translations.get(candidateId);
        const disputes = [...state.disputes.values()].filter((d) => d.claim_id === claimId);
        return {
          claim_id: claimId,
          claim_kind: claim.claim_kind,
          evidence: {
            source_id: source.id,
            source_kind: source.source_kind,
            source_version: source.source_version,
            withdrawn: source.withdrawn,
            own_attestations: [...claim.own_attestations],
          },
          translation: translation
            ? {
                candidate_id: translation.candidate_id,
                language: translation.language,
                candidate: translation.candidate,
                reviewers: { ...translation.reviews },
              }
            : null,
          analogies: state.analogies.get(claimId) ?? [],
          context: state.contexts.get(claimId) ?? [],
          disputes: disputes.map((d) => ({
            dispute_id: d.dispute_id,
            question: d.question,
            open: d.open,
            resolution: d.resolution ?? null,
          })),
        };
      }),
      unresolved_disputes: [],
      correction_notes: [],
    };
    trace.unresolved_disputes = trace.claims.flatMap((c) =>
      c.disputes.filter((d) => d.open).map((d) => ({ claim_id: c.claim_id, ...d })),
    );
    for (const correction of state.corrections.values()) {
      if (f.claim_refs.includes(correction.supersedes)) {
        const archived = correction.retained_archive_receipts.includes(release.receipt_id);
        trace.correction_notes.push({
          correction_id: correction.correction_id,
          reason: correction.reason,
          scope: correction.scope,
          disposition: archived ? "archived_context_retained" : "online_propagated",
          propagated: Boolean(propagationStatus(correction.correction_id, release.receipt_id)),
        });
      }
    }
    return includePrivate ? trace : stripPrivate(trace);
  }

  function pendingPropagation(correctionId) {
    const correction = state.corrections.get(correctionId);
    if (!correction) return [];
    return affectedOnlineReleases(correction)
      .filter((r) => !propagationStatus(correctionId, r.receipt_id))
      .map((r) => ({ receipt_id: r.receipt_id, channel_id: r.channel_id }));
  }

  return {
    commands,
    postRelease,
    propagateCorrection,
    channelWording,
    traceSubtitle,
    pausedDrafts,
    pendingPropagation,
    // 恢复：用历史事件重新折叠出完全相同的服务状态。
    replay(events) {
      for (const e of events) {
        if (seenEventIds.has(e.event_id)) continue;
        seenEventIds.add(e.event_id);
        versions.set(e.aggregate_id, Math.max(versions.get(e.aggregate_id) ?? 0, e.version));
        if (e.event_id.startsWith("evt-")) {
          const n = Number(e.event_id.slice(4));
          if (Number.isInteger(n)) seq = Math.max(seq, n);
        }
        state.events.push(e);
        apply(e);
      }
    },
    events: () => state.events.slice(),
    state,
    DomainError,
  };
}

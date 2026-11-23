// 家人健康簿 · Worker：静态页 + 多模型代理（不落库，资料只存在用户浏览器）

const HK = 'https://api.openai-hk.com/v1';
const SLOTS = {
  A: { provider: 'OpenAI', model: 'gpt-5.4-mini', base: HK, key: 'HK_KEY' },
  B: { provider: 'Anthropic', model: 'claude-sonnet-4-6', base: HK, key: 'HK_KEY' },
  C: { provider: 'Google', model: 'gemini-3.1-flash', base: HK, key: 'HK_KEY' },
  D: { provider: 'DeepSeek', model: 'deepseek-chat', base: 'https://api.deepseek.com', key: 'DS_KEY' },
};
const SYNTH = { provider: 'Anthropic', model: 'claude-sonnet-4-6', base: HK, key: 'HK_KEY' };
const VISION = { provider: 'OpenAI', model: 'gpt-5.4-mini', base: HK, key: 'HK_KEY' };

const BASE_RULES = `你是家庭健康资料分析助手，不是医生，不能做诊断、不能修改处方、不能冒充会诊。
规则：
- 只依据给你的资料快照和问题；资料没有的不要编造病史、检查结果或医院信息。
- 区分来源：医嘱/医生意见、报告原文、家属转述、AI 推断。你的结论一律属于“AI 推断”。
- 不输出概率或可信度百分比；用“当前倾向 / 需要排除 / 现有资料无法区分”表达。
- “未检查”“结果空白”“正常”是不同的事，不要混为一谈；标为“待核对”的数值不能当作已确认事实。
- 出现可能危及生命的表现（如胸痛伴出汗、呼吸困难、意识改变、口角歪斜肢体无力、大出血、抽搐等）时，urgent 设为 "now" 并在 urgent_reason 中说明，建议立即拨打 120 或就近急诊。
- 用简体中文，面向家属，通俗、简短。只输出合法 JSON，不要任何其他文字；字符串里需要引号时用「」，不要用英文双引号。`;

const INDEP_SCHEMA = `输出 JSON 结构：
{"urgent":"none|consider|now","urgent_reason":"",
"answer_now":"现在能回答的部分，2-4 句",
"explanations":[{"name":"可能解释","tendency":"当前倾向|需要排除|无法区分","support":["支持依据，引用资料编号如[F3]"],"against":["反对依据"]}],
"gaps":["信息缺口"],
"questions":[{"q":"关键追问（一句话）","why":"为什么问","impact":"影响紧急行动|区分解释|其他"}],
"next_step":"建议的下一步（标明是否需医务人员确认）"}
explanations 最多 4 条按可能性排序；questions 最多 3 条按对紧急行动的影响排序。`;

const SYNTH_SCHEMA = `输出 JSON 结构：
{"tags":["当前可回答","需要补充","需要持续观察","需医务人员确认"中选一个或多个],
"headline":"先直接回答用户问题，再说下一步，2-3 句",
"next_steps":[{"text":"","source":"医嘱（仅当资料中医生明确说过）|AI推断"}],
"judgments":[{"claim":"具体判断","support":["A"],"reserve":["B"],"cannot":["C"],"note":"分歧点"}],
"minority":[{"model":"B","view":"少数意见","reason":"理由","question":"能澄清它的补充问题"}],
"conflicts":["证据冲突或假设差异"],
"evidence":{"complete":"关键资料是否齐备","verified":"来源是否已核对","timely":"时效是否满足","missing":["缺什么"]},
"boundary":{"leaning":["当前倾向"],"rule_out":["需要排除"],"indistinguishable":["现有资料无法区分"]},
"question":{"q":"下一个最该问的一个问题","why":"它会怎样改变判断","options":["可能的回答1","回答2"]},
"changes":[{"new_evidence":"新增证据","before":"原判断","after":"新判断","reason":"改变原因"}],
"unchanged_reason":"若判断没变，说明为什么",
"no_new_info":false,
"verify_list":["待核实/待医生确认事项"],
"doctor_summary":"给医生看的 150 字内摘要：主诉、时间线、关键资料、用药过敏、家属关心的问题"}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function parseJSON(text) {
  if (!text) throw new Error('空回复');
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j < 0) throw new Error('回复不是 JSON');
  return JSON.parse(t.slice(i, j + 1));
}

async function chat(env, cfg, messages, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.base + (cfg.base.endsWith('/v1') ? '' : '/v1') + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + String(env[cfg.key] || '').trim() },
      body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3 }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      // 上游原始错误（可能含 key 片段、额度信息）只进日志，不发给用户
      console.error('upstream error', cfg.provider, cfg.model, r.status, String((d.error && d.error.message) || '').slice(0, 300));
      throw new Error('AI 服务暂时繁忙，请稍后重试');
    }
    return { text: d.choices?.[0]?.message?.content || '', model: d.model || cfg.model };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI 响应超时，请稍后重试');
    if (e.message === 'AI 服务暂时繁忙，请稍后重试') throw e;
    console.error('upstream fetch failed', cfg.provider, String(e.message || e).slice(0, 300));
    throw new Error('AI 服务暂时繁忙，请稍后重试');
  } finally {
    clearTimeout(timer);
  }
}

async function chatJSON(env, cfg, messages, timeoutMs) {
  const r = await chat(env, cfg, messages, timeoutMs);
  try {
    return { data: parseJSON(r.text), model: r.model };
  } catch (e) {
    // 偶发非法 JSON（多为字符串里混了英文引号）：让同一模型修一次
    const fix = await chat(env, cfg, [
      { role: 'system', content: '把用户给的内容修成合法 JSON，内容不变；字符串内的引号改成「」。只输出 JSON。' },
      { role: 'user', content: r.text },
    ], timeoutMs);
    return { data: parseJSON(fix.text), model: r.model };
  }
}

const ENTRY = {
  urgent: '马上处理：用户正遇到突发不适，需要即时行动。先给紧急行动，不等完整病史，不承诺远程判断病因。',
  records: '结合资料看：用户已有报告、病史或医生意见，请基于选定资料解释、比较、整理可能性，标出未确认与过期信息。',
  clarify: '通过追问弄清：描述不清或模型间有分歧，重点找出最能改变行动的问题。',
  observe: '持续观察：一次信息不足，需要多日记录。请关注趋势、反例、缺失天数，不把相关性写成因果。',
};

async function handleModel(env, body) {
  const cfg = SLOTS[body.slot];
  if (!cfg) return json({ ok: false, error: '未知模型槽位' }, 400);
  const sys = BASE_RULES + '\n' + INDEP_SCHEMA;
  const user = `【入口】${ENTRY[body.entry] || ''}\n【用户问题】${body.question}\n【资料快照】\n${body.snapshot}\n\n请独立给出你的判断（你看不到其他模型的答案）。`;
  try {
    const r = await chatJSON(env, cfg, [{ role: 'system', content: sys }, { role: 'user', content: user }], 75000);
    return json({ ok: true, slot: body.slot, provider: cfg.provider, model: r.model, data: r.data });
  } catch (e) {
    return json({ ok: false, slot: body.slot, provider: cfg.provider, model: cfg.model, error: e.message });
  }
}

async function handleSynth(env, body) {
  const answers = (body.answers || []).map(a => `### 模型 ${a.slot}（${a.provider} ${a.model}）\n${JSON.stringify(a.data)}`).join('\n\n');
  const sys = BASE_RULES + `
你是“综合器”。以下几份独立答案已冻结。请先做交叉审阅：逐份指出遗漏、证据冲突和假设差异；再逐条整理一致与分歧。
- 少数意见必须保留并写明理由，不能以多数票判定安全；模型间一致不等于诊断准确，证据不足时即使一致也要标“需要补充”或“需医务人员确认”。
- 有效参与的模型只有：${(body.answers || []).map(a => a.slot).join('、') || '无'}；不得编造未参与模型的意见。
- 若提供了上一版结论，请对比写出 changes（判断变化）；没变也要写 unchanged_reason。若与上一版相比没有新增有效信息，no_new_info 设为 true。
- question 只给一个问题，选最可能改变行动的那个。
` + SYNTH_SCHEMA;
  const user = `【入口】${ENTRY[body.entry] || ''}\n【用户问题】${body.question}\n【资料快照】\n${body.snapshot}\n\n【上一版结论】${body.previous ? JSON.stringify(body.previous) : '无（首版）'}\n\n【独立答案】\n${answers}`;
  try {
    const r = await chatJSON(env, SYNTH, [{ role: 'system', content: sys }, { role: 'user', content: user }], 90000);
    return json({ ok: true, provider: SYNTH.provider, model: r.model, data: r.data });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

async function handleExtract(env, body) {
  const sys = `你从医疗资料（化验单、检查报告文字、处方、出院记录、病历）中提取关键项，供家属核对。只输出 JSON。
规则：看不清或不确定的数值，clear 设为 false，不要猜；“未检查/空白”与“正常”要区分；quote 写原文中对应的那一行原话。
结构：{"title":"资料标题","date":"资料日期 YYYY-MM-DD 或空","source":"医院/科室，若有","text":"资料全文转写（图片时）",
"items":[{"kind":"指标|诊断|药物|过敏|症状|医嘱|其他","name":"","value":"","unit":"","ref":"参考范围","flag":"偏高|偏低|正常|未检查|空白|","date":"","quote":"原文","clear":true}]}`;
  const content = [];
  if (body.text) content.push({ type: 'text', text: '资料文字：\n' + body.text.slice(0, 12000) });
  if (body.image) content.push({ type: 'image_url', image_url: { url: body.image } });
  if (!content.length) return json({ ok: false, error: '没有内容' }, 400);
  try {
    const r = await chatJSON(env, VISION, [{ role: 'system', content: sys }, { role: 'user', content }], 90000);
    return json({ ok: true, model: r.model, data: r.data });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

async function handlePlan(env, body) {
  const sys = BASE_RULES + `
请为家属起草一个观察记录计划。阈值和频次如果资料中有医嘱就用医嘱并标 source "医嘱"，否则标 "AI建议，需医生确认"，不要给出精确危险阈值，只写“出现……请联系医生/拨打120”。
结构：{"title":"","items":[{"name":"记录项（如 体温、头痛有无）","how":"怎么记（有/无、数值+单位、0-10分）"}],"freq":"每天几次/何时","review_days":7,"contact":["出现这些变化应联系医务人员"],"urgent":["出现这些立即拨打120"],"source":"医嘱|AI建议，需医生确认"}
items 不超过 5 项。`;
  const user = `【用户关心】${body.question}\n【资料快照】\n${body.snapshot}`;
  try {
    const r = await chatJSON(env, SYNTH, [{ role: 'system', content: sys }, { role: 'user', content: user }], 60000);
    return json({ ok: true, model: r.model, data: r.data });
  } catch (e) {
    return json({ ok: false, error: e.message });
  }
}

// ---------- 随手记：语音转文字 + 整理 ----------
function toB64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function handleTranscribe(env, req) {
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 800) return json({ ok: false, error: '没录到声音，请再说一次' }, 400);
  if (buf.byteLength > 12 * 1024 * 1024) return json({ ok: false, error: '录音太长了，请控制在 2 分钟以内' }, 413);
  try {
    const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: toB64(buf), language: 'zh', task: 'transcribe', vad_filter: true,
      initial_prompt: '以下是家属口述老人的健康情况，包括血压、血糖、心率、吃饭、大小便、睡眠、症状、用药和看病经过，使用简体中文和标点。',
    });
    const text = String(r?.text || '').trim();
    if (!text) return json({ ok: false, error: '没听清，请靠近麦克风再说一次' }, 422);
    return json({ ok: true, text });
  } catch (e) {
    return json({ ok: false, error: '语音识别失败，可以改用打字' });
  }
}

const ORGANIZE_SYS = `你是家庭健康记录助手。家属会口述或打字记录老人的情况，你把它整理成结构化记录。只输出 JSON。
规则：
- 只整理原话里有的内容，绝不编造数值、时间、药名、医院；听不清或含糊的（如「10多」「正常」没给数字）照实写并标 uncertain=true。
- 「昨天」「今早」等相对时间，按给定的当前时间换算成具体日期；没说时间就留空。
- 医生说的话、诊断、医嘱单独成条（type 医生意见），写明医院/科室（如果提到）。复诊、吃药、检查等需要以后去做的事，生成 todo。
- 每日记录字段（field）及 value 结构：
  bp {sys,dia,hr}（数字或 null）；glucose {val, when: 空腹|餐前|餐后2小时|睡前|随机}；med {name, dose, taken: 已吃|漏吃|没吃, note}；
  breakfast/lunch/dinner {amount: 正常|偏少|没吃|偏多, what}；stool {count, status: 正常|异常, note}；urine {status: 正常|异常, note}；
  sleep {quality: 好|一般|差, wakes, note}；activity {note}；discomfort {what, score(0-10 或 null), note}；other {note}。
- 归不进以上任何一项、也不属于症状/用药/就医/检查/医生意见的内容（如情绪、天气、家里发生的事、照护细节），记为 daily 的 other，不要丢掉。
- 「没有大便」记 stool count=0；「没测」不要生成记录。
- 约数（「七十多」「10多」「一百四左右」）不要换成精确数字：数值字段填 null，原话写进 note，并标 uncertain=true。
- 当天实际吃了（或漏吃）什么药，记为 daily 的 med，一种药一条（「早上吃了诺和龙和降压药半片」= 两条）；医生开药、改药、让继续吃或停药，记为 event 医生意见。
- todo 只用于以后某个时间要做的一次性事情（复诊、做检查、取报告、买药）。「某药继续吃/停掉/改量」是医嘱，记为 event（type 医生意见 或 用药），不是 todo。
- 血压只说「正常/偏高」没有数字时，question 优先问具体数值。
- 出现危及生命的表现（说话不清、口角歪斜、一侧肢体无力、意识不清、胸痛、呼吸困难、抽搐、大出血、剧烈头痛、反复呕吐等），danger=true 并说明。
- question：只问一个问题。出现下列任一情况必须提问（按顺序取第一个）：①血压/血糖/体温只说「正常」「偏高」或约数，没有具体数字；②去看了医生但没说医生的结论；③提到用药但没说药名或剂量；④提到不舒服但没有程度（0-10 分）。都没有才为 null。已问过的不要重复问。
结构：
{"items":[
 {"kind":"daily","field":"bp","date":"YYYY-MM-DD","time":"HH:MM 或 早上/午饭后 等原话或空","value":{},"text":"一句话整理","quote":"对应原话","uncertain":false},
 {"kind":"event","type":"症状|用药|就医|检查|医生意见","date":"","time":"","text":"","quote":"","uncertain":false},
 {"kind":"todo","text":"要做的事","due":"YYYY-MM-DD 或空","quote":""}
],
"question":{"q":"","why":""} 或 null,
"danger":false,"danger_reason":""}`;

async function handleOrganize(env, body) {
  const text = String(body.text || '').slice(0, 6000);
  if (!text.trim()) return json({ ok: false, error: '没有内容' }, 400);
  const asked = (body.asked || []).map(q => '- ' + q).join('\n') || '无';
  const custom = (body.custom || []).slice(0, 20).map(c => `- field="${c.key}"：${c.name}（${{ num: '数值 value {val}' + (c.unit ? '，单位 ' + c.unit : ''), yn: '有/无 value {yn: 有|无, note}', score: '0-10 分 value {score, note}', text: '文字 value {note}' }[c.kind] || '文字 value {note}'}）`).join('\n');
  const user = `【当前时间】${body.now}\n【患者】${body.profile || ''}\n${custom ? '【额外的每日记录项】原话涉及这些时，用对应 field 记为 daily：\n' + custom + '\n' : ''}【已经问过的问题】\n${asked}\n${(body.asked || []).length >= 2 ? '已问满两次，question 必须为 null。\n' : ''}【记录原文】\n${text}`;
  const msgs = [{ role: 'system', content: ORGANIZE_SYS }, { role: 'user', content: user }];
  for (const cfg of [SLOTS.A, SLOTS.D]) {
    try {
      const r = await chatJSON(env, cfg, msgs, 45000);
      return json({ ok: true, model: r.model, data: r.data });
    } catch (e) { var last = e.message; }
  }
  return json({ ok: false, error: '整理失败：' + last });
}

// ---------- 多设备同步：加密保险箱（服务器只见密文） ----------
const HEX64 = /^[0-9a-f]{64}$/;
const BID = /^[a-z0-9]{4,32}$/;
const MAX_DATA = 1800000;

async function handleVault(env, req, parts) {
  const [vid, kind, bid] = parts;
  if (!HEX64.test(vid || '')) return json({ ok: false, error: 'bad id' }, 400);
  if (kind === 'blob') {
    if (!BID.test(bid || '')) return json({ ok: false, error: 'bad blob id' }, 400);
    if (req.method === 'GET') {
      const r = await env.DB.prepare('SELECT iv, data FROM blob WHERE vid = ? AND bid = ?').bind(vid, bid).first();
      return r ? json({ ok: true, ...r }) : json({ ok: false, error: 'not found' }, 404);
    }
    if (req.method === 'PUT') {
      const b = await req.json().catch(() => ({}));
      if (!b.iv || !b.data || b.data.length > MAX_DATA) return json({ ok: false, error: '图片太大或格式不对' }, 413);
      await env.DB.prepare('INSERT INTO blob (vid, bid, iv, data, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(vid, bid) DO UPDATE SET iv = excluded.iv, data = excluded.data, updated = excluded.updated')
        .bind(vid, bid, b.iv, b.data, Date.now()).run();
      return json({ ok: true });
    }
    return json({ error: 'method' }, 405);
  }
  if (req.method === 'GET') {
    const r = await env.DB.prepare('SELECT v, iv, data, updated FROM vault WHERE id = ?').bind(vid).first();
    return json(r ? { ok: true, ...r } : { ok: true, v: 0 });
  }
  if (req.method === 'PUT') {
    const b = await req.json().catch(() => ({}));
    if (!b.iv || !b.data) return json({ ok: false, error: '数据不对' }, 400);
    if (b.data.length > MAX_DATA) return json({ ok: false, error: '资料太大，暂时无法同步' }, 413);
    const base = Number(b.baseV) || 0, t = Date.now();
    const res = base === 0
      ? await env.DB.prepare('INSERT INTO vault (id, v, iv, data, updated) VALUES (?, 1, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(vid, b.iv, b.data, t).run()
      : await env.DB.prepare('UPDATE vault SET v = v + 1, iv = ?, data = ?, updated = ? WHERE id = ? AND v = ?').bind(b.iv, b.data, t, vid, base).run();
    if (!res.meta.changes) {
      const cur = await env.DB.prepare('SELECT v FROM vault WHERE id = ?').bind(vid).first();
      return json({ ok: false, conflict: true, v: cur ? cur.v : 0 }, 409);
    }
    return json({ ok: true, v: base + 1 });
  }
  return json({ error: 'method' }, 405);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'GET' && url.pathname === '/api/models')
      return json({ slots: Object.fromEntries(Object.entries(SLOTS).map(([k, v]) => [k, { provider: v.provider, model: v.model }])), synth: { provider: SYNTH.provider, model: SYNTH.model } });
    const isVault = url.pathname.startsWith('/api/vault/');
    if (!isVault && req.method !== 'POST') return json({ error: 'method' }, 405);

    if (env.LIMITER && !(isVault && req.method === 'GET')) {
      const ip = req.headers.get('cf-connecting-ip') || 'x';
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json({ ok: false, error: '请求太频繁，请稍后再试' }, 429);
    }
    if (isVault) return handleVault(env, req, url.pathname.slice('/api/vault/'.length).split('/'));
    if (url.pathname === '/api/transcribe') return handleTranscribe(env, req);
    const body = await req.json().catch(() => ({}));
    if (url.pathname === '/api/organize') return handleOrganize(env, body);
    if (url.pathname === '/api/model') return handleModel(env, body);
    if (url.pathname === '/api/synthesize') return handleSynth(env, body);
    if (url.pathname === '/api/extract') return handleExtract(env, body);
    if (url.pathname === '/api/plan') return handlePlan(env, body);
    return json({ error: 'not found' }, 404);
  },
};

import { displayTeamspeakAddress, parseTeamspeak } from './teamspeak.js';
import { createPollService } from './poll-service.js';
import { HELP, TS_HELP, FACEIT_HELP } from './text.js';

const COMMANDS = [
  ['menu', 'Меню'], ['last', 'Мой последний матч или /last ник'], ['stats', 'Мои 30 матчей или /stats ник'],
  ['setfaceit', 'Мой ник FACEIT: /setfaceit ник'], ['unsetfaceit', 'Удалить мой ник в этой группе'],
  ['poll', 'Играть сегодня — опрос'], ['ts', 'TeamSpeak этой группы'],
  ['setts', 'Настроить TeamSpeak (админ)'], ['setup', 'Настройка бота'], ['help', 'Помощь'],
].map(([command, description]) => ({ command, description }));
const MENU = { inline_keyboard: [
  [{ text: 'Последний матч', callback_data: 'last' }, { text: '30 матчей', callback_data: 'stats' }],
  [{ text: 'Мой FACEIT', callback_data: 'myfaceit' }],
  [{ text: 'Играть сегодня', callback_data: 'poll' }, { text: 'TeamSpeak', callback_data: 'ts' }],
  [{ text: 'Настроить TeamSpeak', callback_data: 'hint:setts' }, { text: 'Помощь', callback_data: 'help' }],
] };

function command(text) {
  const match = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:[ \t]+([\s\S]*))?$/i.exec(text ?? '');
  return match ? { name: match[1].toLowerCase(), bot: match[2]?.toLowerCase(), args: match[3] ?? '' } : null;
}
function context(message) {
  return { chatId: message.chat.id, topicId: message.message_thread_id ?? null,
    replyToMessageId: Number.isSafeInteger(message.message_id) && message.message_id > 0 ? message.message_id : null };
}
function destination(ctx) {
  return { chat_id: ctx.chatId, ...(ctx.topicId == null ? {} : { message_thread_id: ctx.topicId }),
    ...(Number.isSafeInteger(ctx.replyToMessageId) && ctx.replyToMessageId > 0
      ? { reply_parameters: { message_id: ctx.replyToMessageId, allow_sending_without_reply: true } } : {}) };
}
function knownFailure(error) { return Number.isInteger(error?.code) && error.code >= 400 && error.code < 500; }
function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(1, Math.floor(number))) : fallback;
}
function personalMessage(message) {
  return Boolean(message && !message.sender_chat && !message.forward_origin && !message.forward_from
    && !message.forward_from_chat && !message.forward_sender_name && !message.forward_date && !message.is_automatic_forward);
}
function validNickname(value) { return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\s@\u0000-\u001f\u007f]/.test(value); }
function safeError(error) {
  switch (error?.code) {
    case 'FACEIT_DEADLINE': return 'FACEIT не ответил за отведённое время. Попробуйте команду ещё раз позже.';
    case 'INVALID_NICKNAME': return 'Укажите один ник FACEIT без @ и пробелов: /setfaceit ник, /last ник или /stats ник.';
    case 'PLAYER_NOT_FOUND': case 'FACEIT_NOT_FOUND': return 'Игрок FACEIT не найден. Проверьте ник.';
    case 'PLAYER_NO_CS2': case 'NO_CS2': case 'FACEIT_NO_CS2': return 'У этого игрока нет профиля FACEIT CS2.';
    case 'FACEIT_ACCESS_DENIED': case 'FACEIT_AUTH': case 'FACEIT_FORBIDDEN': return 'FACEIT отклонил ключ API. Владельцу бота нужно проверить доступ.';
    case 'FACEIT_NOT_CONFIGURED': return 'FACEIT пока не настроен. Владельцу бота нужно безопасно добавить ключ API.';
    case 'FACEIT_RATE_LIMITED': case 'FACEIT_TEMPORARY': case 'FACEIT_RATE_LIMIT': case 'FACEIT_UNAVAILABLE': case 'FACEIT_NETWORK': return 'FACEIT временно недоступен. Попробуйте позже.';
    case 'TS_ADDRESS': case 'TS_SYNTAX': return `Некорректный адрес или команда.\n${TS_HELP}`;
    default: return 'Не удалось выполнить запрос. Попробуйте новой командой позже. Секреты и подробности ошибки не публикуются.';
  }
}

export function createBot({ api, store, faceit, sealer, settings, renderCard, inputFile, reportCache, shouldContinue, waitUntil, now = () => Math.floor(Date.now() / 1000) }) {
  // Optional invocation-scoped budget. It is never serialized into a checkpoint.
  const canContinue = () => typeof shouldContinue !== 'function' || shouldContinue();
  const polls = createPollService({ api, store, now });
  let me;
  const getMe = async () => me ?? (me = await api.getMe());
  const say = (ctx, text, keyboard = MENU) => api.sendMessage({ ...destination(ctx), text, ...(keyboard ? { reply_markup: keyboard } : {}) });

  async function chatMember(ctx, user, admin = false) {
    if (!user || user.is_bot) return false;
    try {
      const member = await api.getChatMember({ chat_id: ctx.chatId, user_id: user.id });
      return admin ? ['creator', 'administrator'].includes(member.status)
        : ['creator', 'administrator', 'member'].includes(member.status)
          || (member.status === 'restricted' && member.is_member === true);
    } catch { return false; } // Fail closed, including when bot lacks admin visibility.
  }

  async function access(ctx, user, admin = false) {
    return Boolean(user && !user.is_bot && await store.allowed(ctx.chatId) && await chatMember(ctx, user, admin));
  }

  async function maintainStore() {
    // Keep retention bounded without putting maintenance on the reply's critical path.
    // Still awaited before the update is acknowledged; failures must not send a second reply.
    try { await store.cleanup(); } catch { /* Maintenance is best effort, not a delivery failure. */ }
  }

  async function claim(updateId, ctx, kind) {
    if (!Number.isSafeInteger(updateId)) return false;
    return store.claimDelivery(`u:${updateId}`, ctx.chatId, ctx.topicId, kind);
  }

  async function poll(ctx, requestId) {
    let result;
    try { result = await polls.run(ctx, requestId); }
    catch { result = { status: 'outcome_unknown' }; }
    try { await store.finishDelivery(requestId, result.status === 'busy' ? 'rejected' : result.status, result.message); }
    catch { /* The original update claim prevents blindly repeating an uncertain send. */ }
    if (result.warning) return say(ctx, result.warning);
    if (result.status === 'sent') return;
    if (result.status === 'busy') return say(ctx, 'Опрос уже обрабатывается. Подождите немного и вызовите /poll снова.');
    return say(ctx, result.status === 'rejected'
      ? 'Не удалось создать опрос или переслать предыдущий. Проверьте права отправлять опросы и закреплять сообщения; при flood limit подождите.'
      : 'Ответ об отправке опроса потерян. Возможно, он уже создан — проверьте чат. До конца текущего периода МСК не буду создавать дубликат.');
  }

  function executionBudget() {
    const deadline = now() + boundedInteger(settings.autoAdvanceSeconds, 90, 120);
    const active = () => canContinue() && now() < deadline;
    return { active, async wait(retryAt) {
      if (!Number.isFinite(retryAt) || retryAt >= deadline || !active()) return false;
      if (retryAt <= now()) return true;
      if (typeof waitUntil !== 'function') return false;
      try { return await waitUntil(retryAt) === true && now() >= retryAt && active(); }
      catch { return false; }
    } };
  }
  const deadlineError = () => Object.assign(new Error('FACEIT_DEADLINE'), { code: 'FACEIT_DEADLINE' });

  async function startReport(nickname, kind, options, budget) {
    const attempts = boundedInteger(settings.autoAdvanceBatches, 32, 32);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!budget.active()) throw deadlineError();
      try { return await faceit.start(nickname, kind, options); }
      catch (error) {
        if (!Number.isFinite(error?.retryAt)) throw error;
        if (!(await budget.wait(error.retryAt))) throw deadlineError();
      }
    }
    throw deadlineError();
  }

  async function failure(ctx, requestId, title, text) {
    const id = `notice:${requestId}`; // Preserve existing delivery tombstones.
    if (!(await store.claimDelivery(id, ctx.chatId, ctx.topicId, 'error'))) return;
    let status = 'rejected';
    let message;
    try { message = await say(ctx, `${title}\n${text}`, null); status = 'sent'; }
    catch (error) { status = knownFailure(error) ? 'rejected' : 'outcome_unknown'; }
    try { await store.finishDelivery(id, status, message); } catch { /* Never repeat an uncertain POST. */ }
  }

  function validFileId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(value); }
  function largestFileId(message) {
    let best = null;
    for (const photo of Array.isArray(message?.photo) ? message.photo : []) {
      if (!validFileId(photo?.file_id)) continue;
      const area = Number(photo.width) * Number(photo.height);
      const size = Number(photo.file_size) || 0;
      const score = Number.isFinite(area) && area > 0 ? area : 0;
      if (!best || score > best.area || (score === best.area && size > best.size)) best = { id: photo.file_id, area: score, size };
    }
    return best?.id ?? null;
  }

  async function deliverImage(ctx, requestId, report, filename, keyboard, { fileId, beforeSend, afterSend } = {}) {
    // Claim before rendering/POST. One definitely invalid cached file ID may
    // fall back to bytes under this same claim; ambiguous sends never retry.
    if (!(await store.claimDelivery(requestId, ctx.chatId, ctx.topicId, 'photo'))) return;
    try { await beforeSend?.(); } catch { /* A cache is an optional optimization. */ }
    let status = 'rejected';
    let message;
    let reportSent = false;
    let needsBytes = true;
    if (validFileId(fileId)) {
      try {
        message = await api.sendPhoto({ ...destination(ctx), photo: fileId, reply_markup: keyboard });
        status = 'sent'; reportSent = true; needsBytes = false;
      } catch (error) {
        if (error?.invalidFileId !== true) {
          status = knownFailure(error) ? 'rejected' : 'outcome_unknown';
          needsBytes = false;
        }
      }
    }
    if (needsBytes) {
      let bytes;
      try { bytes = renderCard(report); } catch { /* Rendering failed before any upload; a final text refusal is safe. */ }
      if (bytes) {
        try {
          message = await api.sendPhoto({ ...destination(ctx), photo: inputFile(bytes, filename), reply_markup: keyboard });
          status = 'sent'; reportSent = true;
        } catch (error) { status = knownFailure(error) ? 'rejected' : 'outcome_unknown'; }
      }
    }
    if (status === 'sent' && reportSent) {
      try { await afterSend?.(message, { uploaded: needsBytes }); } catch { /* Delivery is independent of cache persistence. */ }
    }
    // The original claim remains an at-most-once tombstone if persistence fails.
    try { await store.finishDelivery(requestId, status, message); } catch { /* Keep the original claim. */ }
    // Only a definite rejection or a pre-POST render failure permits a text
    // fallback. An unknown photo POST may already have reached the chat.
    if (status === 'rejected') return failure(ctx, `delivery:${requestId}`, 'Карточка недоступна', 'Не удалось отправить карточку. Попробуйте команду ещё раз позже.');
  }

  async function reportDelivery(ctx, jobId, report, state, cached = null) {
    const matchUrl = report.match?.url ?? report.matches?.[0]?.url;
    const keyboard = { inline_keyboard: [
      ...(/^https:\/\/(?:www\.)?faceit\.com\//.test(matchUrl ?? '')
        ? [[{ text: 'Открыть матч FACEIT', url: matchUrl }]] : []),
      [{ text: 'Меню', callback_data: 'help' }],
    ] };
    const filename = report.kind === 'last' ? 'faceit-last-match.png' : 'faceit-stats.png';
    return deliverImage(ctx, `photo:${jobId}`, report, filename, keyboard, {
      fileId: cached?.fileId,
      beforeSend: reportCache && state && !cached ? () => reportCache.put(state, report) : undefined,
      afterSend: reportCache && state ? async (message, { uploaded }) => {
        const fileId = largestFileId(message);
        if (fileId && (uploaded || fileId !== cached?.fileId)) await reportCache.put(state, report, fileId);
      } : undefined,
    });
  }

  async function cachedReport(state) {
    if (!reportCache || state.cacheChecked || state.phase !== 'details' || (state.matches?.length ?? 0) !== 0) return null;
    state.cacheChecked = true;
    try {
      const cached = await reportCache.get(state);
      if (cached?.report?.kind !== state.kind) return null;
      return { report: cached.report, fileId: validFileId(cached.fileId) ? cached.fileId : null,
        rendererScope: reportCache.rendererScope };
    } catch { return null; } // A failed cache cannot prevent a fresh report.
  }

  async function advanceJob(ctx, jobId, requestId, budget = executionBudget()) {
    const batches = boundedInteger(settings.autoAdvanceBatches, 32, 32);
    const timedOut = () => failure(ctx, requestId, 'Не удалось получить статистику', safeError(deadlineError()));
    const densityWarning = () => failure(ctx, requestId, 'История слишком плотная', 'Не могу надёжно определить последние завершённые матчи. Неполную выборку не выдаю за полную. Попробуйте позже.');
    for (let batch = 0; batch < batches; batch++) {
      const job = await store.getJob(jobId);
      if (!job || job.chat_id !== ctx.chatId || job.topic_id !== ctx.topicId) return failure(ctx, requestId, 'Запрос недоступен', 'Этот запрос недоступен в текущем чате/теме. Отправьте /stats ник заново.');
      if (Number.isSafeInteger(job.state.replyToMessageId) && job.state.replyToMessageId > 0) {
        ctx = { ...ctx, replyToMessageId: job.state.replyToMessageId };
      }
      if (job.status === 'blocked') return densityWarning();
      // A ready checkpoint needs no new FACEIT reads. Keep photo tombstones,
      // renderer scope and original command anchors when old buttons are used.
      if (job.status === 'ready') {
        if (job.state.cachedReport) {
          const stale = now() - job.state.cachedReport.updatedAt > 300;
          const report = { ...job.state.cachedReport, stale };
          const sameRenderer = typeof reportCache?.rendererScope === 'string'
            && job.state.cachedRendererScope === reportCache.rendererScope;
          return reportDelivery(ctx, jobId, report, job.state, { fileId: stale || !sameRenderer ? null : job.state.cachedFileId });
        }
        let result;
        try { result = await faceit.advance(job.state, { maxRequests: settings.maxRequests, shouldContinue: budget.active }); }
        catch (error) { return failure(ctx, requestId, 'Не удалось выполнить запрос', safeError(error)); }
        if (result.done) return reportDelivery(ctx, jobId, result.report, result.state);
        return failure(ctx, requestId, 'Запрос недоступен', 'Сохранённый отчёт повреждён. Отправьте /stats ник или /last ник заново.');
      }
      if (!budget.active()) return timedOut();
      if (job.state.retryAt && job.state.retryAt > now()) {
        // saveJob releases the lease before this passive wait. Re-read/lease
        // afterward: another legacy button may have advanced the checkpoint.
        if (!(await budget.wait(job.state.retryAt))) return timedOut();
        continue;
      }
      if (!(await store.leaseJob(jobId, job.version))) return failure(ctx, requestId, 'Запрос уже обрабатывается', 'Отправьте команду ещё раз позже.');
      let result;
      try {
        const historyOnly = Boolean(reportCache && !job.state.cacheChecked && job.state.phase === 'history');
        result = await faceit.advance(job.state, { maxRequests: settings.maxRequests, shouldContinue: budget.active, ...(historyOnly ? { historyOnly: true } : {}) });
      }
      catch (error) {
        await store.saveJob(jobId, job.version, job.state, 'pending');
        return failure(ctx, requestId, 'Не удалось выполнить запрос', safeError(error));
      }
      const cached = await cachedReport(result.state);
      if (cached) {
        result.state.cachedReport = cached.report;
        result.state.cachedFileId = cached.fileId;
        result.state.cachedRendererScope = cached.rendererScope;
        await store.saveJob(jobId, job.version, result.state, 'ready');
        return reportDelivery(ctx, jobId, cached.report, result.state, cached);
      }
      const blocked = result.progress?.reason === 'HISTORY_DENSITY_UNRESOLVED'
        || result.state.blocked === 'HISTORY_DENSITY_UNRESOLVED';
      await store.saveJob(jobId, job.version, result.state, blocked ? 'blocked' : result.done ? 'ready' : 'pending');
      if (blocked) return densityWarning();
      if (result.done) return reportDelivery(ctx, jobId, result.report, result.state);
    }
    return timedOut();
  }

  async function action(name, args, ctx, user, message, updateId) {
    const requestId = `u:${updateId}`;
    if (name === 'start' || name === 'menu' || name === 'help') {
      // Default Telegram command scope; personal FACEIT links stay chat-scoped.
      try { await api.setMyCommands({ commands: COMMANDS }); } catch { /* Menu still usable via buttons. */ }
      return say(ctx, HELP);
    }
    if (name === 'myfaceit' || (name === 'setfaceit' && !args.trim())) {
      if (name === 'setfaceit' && !personalMessage(message)) return say(ctx, 'Настройку FACEIT нужно отправить лично от своего аккаунта, не пересланным сообщением.');
      const link = await store.getPlayerLink(ctx.chatId, user.id);
      return say(ctx, `${link ? `Ваш FACEIT в этой группе: ${link.nickname}.` : 'Ваш FACEIT в этой группе ещё не указан.'}\n\n${FACEIT_HELP}`);
    }
    if (name === 'setfaceit' || name === 'unsetfaceit') {
      if (!personalMessage(message)) return say(ctx, 'Настройку FACEIT нужно отправить лично от своего аккаунта, не пересланным сообщением.');
      if (name === 'unsetfaceit') {
        if (args.trim()) return say(ctx, 'Используйте /unsetfaceit без аргументов — удаляется только ваш ник в этой группе.');
        await store.deletePlayerLink(ctx.chatId, user.id);
        return say(ctx, 'Ваш ник FACEIT удалён только из этой группы. Можно снова указать /setfaceit ник или запрашивать /last ник и /stats ник.');
      }
      const nickname = args.trim();
      if (!validNickname(nickname)) return say(ctx, FACEIT_HELP);
      // Validation fetches one CS2 profile only, never the history or a report.
      const state = await faceit.start(nickname, 'last');
      await store.savePlayerLink(ctx.chatId, user.id, state.profile);
      return say(ctx, `Ваш FACEIT в этой группе: ${state.profile.nickname}. Теперь /last и /stats без ника показывают вашу статистику.\nДля замены: /setfaceit другой_ник. Для удаления: /unsetfaceit.`);
    }
    if (name === 'setup') {
      const admin = await access(ctx, user, true);
      return say(ctx, `Чат: ${ctx.chatId}\nДоступ к боту: включён. Ваши права: ${admin ? 'администратор' : 'участник'}.\nБот должен быть администратором, чтобы проверять членство и удалять команды с паролем. Нужны права отправлять сообщения, фото и опросы, а также закреплять сообщения.\n\n${TS_HELP}`);
    }
    if (name === 'poll') {
      if (args.trim()) return say(ctx, 'Опрос запускается командой /poll без аргументов.');
      return poll(ctx, requestId);
    }
    if (name === 'ts') {
      if (args.trim()) return say(ctx, 'Используйте /ts без аргументов — только для текущего чата.');
      const row = await store.getSettings(ctx.chatId);
      if (!row?.ciphertext) return say(ctx, `В этом чате TeamSpeak ещё не настроен.\n${TS_HELP}`);
      const credentials = sealer.open(ctx.chatId, row.ciphertext);
      return say(ctx, `TeamSpeak этого чата\nАдрес: ${displayTeamspeakAddress(credentials.host)}\nПароль: ${credentials.password || '(без пароля)'}`);
    }
    if (name === 'setts') {
      if (!message || message.sender_chat || message.forward_origin || message.forward_from || message.forward_date || message.is_automatic_forward) {
        return say(ctx, 'Настройку нужно отправить лично от своего аккаунта, не пересланным сообщением.');
      }
      if (!(await access(ctx, user, true))) return say(ctx, 'Настраивать TeamSpeak может только администратор группы от своего аккаунта.');
      if (!args) return say(ctx, TS_HELP);
      const credentials = parseTeamspeak(args);
      await store.saveSettings(ctx.chatId, credentials, sealer);
      let deleted = false;
      try { await api.deleteMessage({ chat_id: ctx.chatId, message_id: message.message_id }); deleted = true; } catch { /* Save stays committed. */ }
      return say(deleted ? { ...ctx, replyToMessageId: null } : ctx, `TeamSpeak для этого чата обновлён.${deleted ? '' : '\nНе удалось удалить команду с реквизитами: удалите её вручную.'}`);
    }
    if (name === 'last' || name === 'stats') {
      const budget = executionBudget();
      const nickname = args.trim();
      if (nickname && !validNickname(nickname)) return failure(ctx, requestId, 'Укажите ник FACEIT', `Укажите один ник FACEIT без @ и пробелов: /${name} ник. Либо сохраните свой: /setfaceit ник.`);
      let link = null;
      if (!nickname) {
        if (message?.sender_chat) return failure(ctx, requestId, 'Нужен ваш аккаунт', 'Отправьте команду от своего аккаунта, чтобы получить личную статистику, либо укажите ник явно.');
        link = await store.getPlayerLink(ctx.chatId, user.id);
        if (!link) return failure(ctx, requestId, 'Укажите ваш FACEIT', `Сначала сохраните свой ник: /setfaceit ник. Или запросите любого игрока: /${name} ник.`);
      }
      let state = await startReport(nickname || link.nickname, name, link ? { playerId: link.player_id } : undefined, budget);
      // Persist the command anchor across resumable FACEIT checkpoints.
      if (ctx.replyToMessageId != null) state.replyToMessageId = ctx.replyToMessageId;
      const jobId = `${(-ctx.chatId).toString(36)}_${updateId.toString(36)}`;
      if (reportCache && budget.active()) {
        const history = await faceit.advance(state, { maxRequests: settings.maxRequests, shouldContinue: budget.active, historyOnly: true });
        state = history.state;
        const cached = await cachedReport(state);
        if (cached) return reportDelivery(ctx, jobId, cached.report, state, cached);
      }
      await store.createJob(jobId, ctx.chatId, ctx.topicId, state);
      return advanceJob(ctx, jobId, requestId, budget);
    }
    return say(ctx, 'Такой команды нет. Используйте /menu.');
  }

  async function handleMessage(message, rawContext) {
    const updateId = rawContext?.update?.update_id;
    if (!message?.chat || message.edit_date || rawContext?.update?.edited_message
      || rawContext?.update?.edited_channel_post) return;
    const ctx = context(message);
    // Telegram-generated migration service messages, not user-supplied arguments.
    if (message.migrate_to_chat_id != null || message.migrate_from_chat_id != null) {
      const movingTo = Number.isSafeInteger(message.migrate_to_chat_id) && message.chat.type === 'group'
        && message.migrate_from_chat_id == null;
      const movingFrom = Number.isSafeInteger(message.migrate_from_chat_id) && message.chat.type === 'supergroup'
        && message.migrate_to_chat_id == null;
      if (!movingTo && !movingFrom) return;
      const oldId = movingFrom ? message.migrate_from_chat_id : ctx.chatId;
      const newId = movingTo ? message.migrate_to_chat_id : ctx.chatId;
      if (await claim(updateId, ctx, 'migration')) await store.migrateChat(oldId, newId, sealer);
      return;
    }
    const cmd = command(message.text);
    if (!cmd) return;
    if (cmd.bot && cmd.bot !== (await getMe()).username.toLowerCase()) return;
    const faceitCommand = cmd.name === 'last' || cmd.name === 'stats';
    if (!['group', 'supergroup'].includes(message.chat.type)) {
      if (faceitCommand) {
        if (await claim(updateId, ctx, cmd.name)) return failure(ctx, `u:${updateId}`, 'Нужна группа', 'Добавьте меня в группу и отправьте /menu. FACEIT команды доступны только в группе.');
        return;
      }
      return say(ctx, 'Добавьте меня в группу и отправьте /menu. TeamSpeak, опросы и FACEIT команды доступны только в группе.');
    }
    if (!(await store.allowed(ctx.chatId))) return;
    if (!(await chatMember(ctx, message.from))) {
      if (faceitCommand) {
        if (await claim(updateId, ctx, cmd.name)) return failure(ctx, `u:${updateId}`, 'Нет доступа', 'Не могу подтвердить членство. Выдайте боту права администратора; команды должен отправлять участник от своего аккаунта.');
        return;
      }
      return say(ctx, 'Не могу подтвердить членство. Выдайте боту права администратора; команды должен отправлять участник от своего аккаунта.');
    }
    if (!(await claim(updateId, ctx, cmd.name))) return;
    try {
      await action(cmd.name, cmd.args, ctx, message.from, message, updateId);
    } catch (error) {
      if (faceitCommand) return await failure(ctx, `u:${updateId}`, 'Не удалось выполнить запрос', safeError(error));
      await say(ctx, safeError(error));
    } finally {
      await maintainStore();
    }
  }

  async function handleCallback(query, rawContext) {
    try { await api.answerCallbackQuery({ callback_query_id: query.id }); } catch { /* expired callback: no data read yet */ }
    const message = query.message;
    if (!message?.chat || !['group', 'supergroup'].includes(message.chat.type)) return;
    const ctx = context(message);
    const updateId = rawContext?.update?.update_id;
    const faceitCallback = query.data?.startsWith('continue:') || ['last', 'stats', 'hint:last', 'hint:stats'].includes(query.data);
    if (!(await access(ctx, query.from))) {
      if (faceitCallback && await store.allowed(ctx.chatId) && await claim(updateId, ctx, 'callback')) {
        return failure(ctx, `u:${updateId}`, 'Нет доступа', 'Не могу подтвердить членство. Команду должен отправить участник этой группы.');
      }
      return;
    }
    if (!(await claim(updateId, ctx, 'callback'))) return;
    try {
      if (query.data?.startsWith('continue:')) return await advanceJob(ctx, query.data.slice(9), `u:${updateId}`);
      if (query.data === 'hint:setts') return await say(ctx, TS_HELP);
      if (['last', 'stats', 'hint:last', 'hint:stats'].includes(query.data)) return await action(query.data.replace('hint:', ''), '', ctx, query.from, null, updateId);
      if (['help', 'ts', 'poll', 'myfaceit'].includes(query.data)) return await action(query.data, '', ctx, query.from, null, updateId);
      return await say(ctx, 'Кнопка устарела. Используйте /menu.');
    } catch (error) {
      if (faceitCallback) return await failure(ctx, `u:${updateId}`, 'Не удалось выполнить запрос', safeError(error));
      return await say(ctx, safeError(error));
    } finally {
      await maintainStore();
    }
  }
  return { handleMessage, handleCallback };
}

import { parseTeamspeak } from './teamspeak.js';
import { todayPoll } from './poll.js';
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
  return { chatId: message.chat.id, topicId: message.message_thread_id ?? null };
}
function destination(ctx) {
  return { chat_id: ctx.chatId, ...(ctx.topicId == null ? {} : { message_thread_id: ctx.topicId }) };
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

export function createBot({ api, store, faceit, sealer, settings, renderCard, inputFile, reportCache, shouldContinue, now = () => Math.floor(Date.now() / 1000) }) {
  // Optional invocation-scoped budget. It is never serialized into a checkpoint.
  const canContinue = () => typeof shouldContinue !== 'function' || shouldContinue();
  const requestBudget = typeof shouldContinue === 'function' ? { shouldContinue } : {};
  let me;
  const getMe = async () => me ?? (me = await api.getMe());
  const say = (ctx, text, keyboard = MENU) => api.sendMessage({ ...destination(ctx), text, ...(keyboard ? { reply_markup: keyboard } : {}) });

  async function access(ctx, user, admin = false) {
    if (!user || user.is_bot || !(await store.allowed(ctx.chatId, settings.allowedChatIds))) return false;
    try {
      const member = await api.getChatMember({ chat_id: ctx.chatId, user_id: user.id });
      return admin ? ['creator', 'administrator'].includes(member.status)
        : ['creator', 'administrator', 'member'].includes(member.status)
          || (member.status === 'restricted' && member.is_member === true);
    } catch { return false; } // Fail closed, including when bot lacks admin visibility.
  }

  async function claim(updateId, ctx, kind) {
    if (!Number.isSafeInteger(updateId)) return false;
    return store.claimDelivery(`u:${updateId}`, ctx.chatId, ctx.topicId, kind);
  }

  async function poll(ctx, requestId) {
    try {
      const message = await api.sendPoll(todayPoll(ctx.chatId, ctx.topicId));
      await store.finishDelivery(requestId, 'sent', message);
    } catch (error) {
      await store.finishDelivery(requestId, knownFailure(error) ? 'rejected' : 'outcome_unknown');
      await say(ctx, knownFailure(error)
        ? 'Не удалось создать опрос. Проверьте право бота отправлять опросы; при flood limit подождите и вызовите /poll заново.'
        : 'Ответ об отправке опроса потерян. Возможно, он уже создан — проверьте чат. Автоматически повторять не буду.');
    }
  }

  const continueKeyboard = (jobId) => ({ inline_keyboard: [
    [{ text: 'Продолжить', callback_data: `continue:${jobId}` }], [{ text: 'Меню', callback_data: 'help' }],
  ] });
  const noticeReport = (title, message, nickname) => ({ kind: 'notice', title, message,
    ...(nickname ? { nickname } : {}), updatedAt: now() });

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
    if (!(await store.claimDelivery(requestId, ctx.chatId, ctx.topicId, report.kind === 'notice' ? 'notice' : 'photo'))) return;
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
      let renderedReport = false;
      try { bytes = renderCard(report); renderedReport = Boolean(bytes); } catch { /* Try one image-only error notice below. */ }
      if (!bytes && report.kind !== 'notice') {
        try {
          bytes = renderCard(noticeReport('Карточка недоступна', 'Не удалось создать карточку. Попробуйте новой командой позже.', report.nickname));
          filename = 'faceit-status.png';
        } catch { /* Never fall back to plain-text FACEIT output. */ }
      }
      if (bytes) {
        try {
          message = await api.sendPhoto({ ...destination(ctx), photo: inputFile(bytes, filename), reply_markup: keyboard });
          status = 'sent'; reportSent = renderedReport;
        } catch (error) { status = knownFailure(error) ? 'rejected' : 'outcome_unknown'; }
      }
    }
    if (status === 'sent' && reportSent) {
      try { await afterSend?.(message, { uploaded: needsBytes }); } catch { /* Delivery is independent of cache persistence. */ }
    }
    // The original claim remains an at-most-once tombstone if persistence fails.
    try { await store.finishDelivery(requestId, status, message); } catch { /* Keep the original claim. */ }
  }

  const notice = (ctx, requestId, title, message, keyboard = MENU, nickname) =>
    deliverImage(ctx, `notice:${requestId}`, noticeReport(title, message, nickname), 'faceit-status.png', keyboard);

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
      return { report: cached.report, fileId: validFileId(cached.fileId) ? cached.fileId : null };
    } catch { return null; } // A failed cache cannot prevent a fresh report.
  }

  async function advanceJob(ctx, jobId, requestId) {
    // Serverless keeps one bounded batch per invocation. A long-lived local
    // runner may await several batches, persisting a checkpoint after each one.
    const batches = boundedInteger(settings.autoAdvanceBatches, 1, 32);
    const deadline = now() + boundedInteger(settings.autoAdvanceSeconds, 90, 120);
    const densityWarning = () => notice(ctx, requestId, 'История слишком плотная', 'Не могу надёжно определить последние завершённые матчи: история слишком плотная даже после разделения по секундам. Неполную выборку не выдаю за полную. Этот запрос остановлен; повторное нажатие не поможет.');
    const continuation = (state, progress) => {
      const retry = progress?.retryAt ?? state.retryAt;
      const waiting = retry && retry > now() ? ` FACEIT просит подождать ещё ${retry - now()} сек.` : '';
      const timedOut = !canContinue() || now() >= deadline;
      const reason = timedOut && !waiting ? 'Загрузка FACEIT не уложилась в безопасное время одного запроса' : progress?.message ?? 'Загружаю историю и статистику';
      const loaded = state.selected?.length ? `Загружено ${state.matches?.length ?? 0} из ${state.selected.length} матчей.\n` : '';
      return notice(ctx, requestId, 'Сохранила прогресс', `${reason}.${waiting}\n${loaded}Нажмите «Продолжить». Повторять ник не нужно.`, continueKeyboard(jobId), state.profile?.nickname ?? state.nickname);
    };
    let progress;
    for (let batch = 0; batch < batches; batch++) {
      const job = await store.getJob(jobId);
      if (!job || job.chat_id !== ctx.chatId || job.topic_id !== ctx.topicId) return notice(ctx, requestId, 'Запрос недоступен', 'Этот запрос недоступен в текущем чате/теме. Отправьте /stats ник заново.');
      if (job.status === 'blocked') return densityWarning();
      // A ready checkpoint can survive a crash before/during delivery. The
      // service rebuilds it without HTTP; delivery tombstones prevent repeats.
      if (job.status === 'ready') {
        if (job.state.cachedReport) {
          const stale = now() - job.state.cachedReport.updatedAt > 300;
          const report = { ...job.state.cachedReport, stale };
          return reportDelivery(ctx, jobId, report, job.state, { fileId: stale ? null : job.state.cachedFileId });
        }
        const result = await faceit.advance(job.state, { maxRequests: settings.maxRequests, ...requestBudget });
        if (result.done) return reportDelivery(ctx, jobId, result.report, result.state);
        return notice(ctx, requestId, 'Запрос недоступен', 'Сохранённый отчёт повреждён. Отправьте /stats ник или /last ник заново.');
      }
      if ((job.state.retryAt && job.state.retryAt > now()) || !canContinue() || (batch > 0 && now() >= deadline)) {
        return continuation(job.state, progress);
      }
      if (!(await store.leaseJob(jobId, job.version))) return notice(ctx, requestId, 'Запрос уже обрабатывается', 'Если выполнение прервалось, подождите две минуты и нажмите ещё раз.', continueKeyboard(jobId));
      let result;
      try {
        const historyOnly = Boolean(reportCache && !job.state.cacheChecked && job.state.phase === 'history');
        result = await faceit.advance(job.state, { maxRequests: settings.maxRequests, ...requestBudget, ...(historyOnly ? { historyOnly: true } : {}) });
      }
      catch (error) {
        await store.saveJob(jobId, job.version, job.state, 'pending');
        throw error;
      }
      const cached = await cachedReport(result.state);
      if (cached) {
        result.state.cachedReport = cached.report;
        result.state.cachedFileId = cached.fileId;
        await store.saveJob(jobId, job.version, result.state, 'ready');
        return reportDelivery(ctx, jobId, cached.report, result.state, cached);
      }
      const blocked = result.progress?.reason === 'HISTORY_DENSITY_UNRESOLVED'
        || result.state.blocked === 'HISTORY_DENSITY_UNRESOLVED';
      await store.saveJob(jobId, job.version, result.state, blocked ? 'blocked' : result.done ? 'ready' : 'pending');
      if (blocked) return densityWarning();
      if (result.done) return reportDelivery(ctx, jobId, result.report, result.state);
      progress = result.progress;
      const retry = progress?.retryAt ?? result.state.retryAt;
      if (batch + 1 >= batches || now() >= deadline || !canContinue() || (retry && retry > now())) return continuation(result.state, progress);
    }
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
      return say(ctx, `Чат: ${ctx.chatId}\nДоступ к боту: включён. Ваши права: ${admin ? 'администратор' : 'участник'}.\nБот должен быть администратором, чтобы проверять членство и удалять команды с паролем. Нужны права отправлять сообщения, фото и опросы.\n\n${TS_HELP}`);
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
      return say(ctx, `TeamSpeak этого чата\nАдрес: ${credentials.host}\nПароль: ${credentials.password || '(без пароля)'}`);
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
      return say(ctx, `TeamSpeak для этого чата обновлён.${deleted ? '' : '\nНе удалось удалить команду с реквизитами: удалите её вручную.'}`);
    }
    if (name === 'last' || name === 'stats') {
      const nickname = args.trim();
      if (nickname && !validNickname(nickname)) return notice(ctx, requestId, 'Укажите ник FACEIT', `Укажите один ник FACEIT без @ и пробелов: /${name} ник. Либо сохраните свой: /setfaceit ник.`);
      let link = null;
      if (!nickname) {
        if (message?.sender_chat) return notice(ctx, requestId, 'Нужен ваш аккаунт', 'Отправьте команду от своего аккаунта, чтобы получить личную статистику, либо укажите ник явно.');
        link = await store.getPlayerLink(ctx.chatId, user.id);
        if (!link) return notice(ctx, requestId, 'Укажите ваш FACEIT', `Сначала сохраните свой ник: /setfaceit ник. Или запросите любого игрока: /${name} ник.`);
      }
      let state = await faceit.start(nickname || link.nickname, name, ...(link ? [{ playerId: link.player_id }] : []));
      const jobId = `${(-ctx.chatId).toString(36)}_${updateId.toString(36)}`;
      if (reportCache) {
        const history = await faceit.advance(state, { maxRequests: settings.maxRequests, ...requestBudget, historyOnly: true });
        state = history.state;
        const cached = await cachedReport(state);
        if (cached) return reportDelivery(ctx, jobId, cached.report, state, cached);
      }
      await store.createJob(jobId, ctx.chatId, ctx.topicId, state);
      return advanceJob(ctx, jobId, requestId);
    }
    return say(ctx, 'Такой команды нет. Используйте /menu.');
  }

  async function handleMessage(message, rawContext) {
    const updateId = rawContext?.update?.update_id;
    if (!message?.chat || message.edit_date || rawContext?.update?.edited_message
      || rawContext?.update?.edited_channel_post) return;
    const ctx = context(message);
    // Telegram-generated migration service messages, not user-supplied arguments.
    if (message.migrate_to_chat_id || message.migrate_from_chat_id) {
      const oldId = message.migrate_from_chat_id ?? ctx.chatId;
      const newId = message.migrate_to_chat_id ?? ctx.chatId;
      if (await claim(updateId, ctx, 'migration')) await store.migrateChat(oldId, newId, settings.allowedChatIds, sealer);
      return;
    }
    const cmd = command(message.text);
    if (!cmd) return;
    if (cmd.bot && cmd.bot !== (await getMe()).username.toLowerCase()) return;
    const faceitCommand = cmd.name === 'last' || cmd.name === 'stats';
    if (!['group', 'supergroup'].includes(message.chat.type)) {
      if (faceitCommand) {
        if (await claim(updateId, ctx, cmd.name)) return notice(ctx, `u:${updateId}`, 'Нужна группа', 'Добавьте меня в разрешённую группу и отправьте /menu. FACEIT команды доступны только в группе.');
        return;
      }
      return say(ctx, 'Добавьте меня в группу и отправьте /menu. TeamSpeak, опросы и FACEIT команды доступны только в разрешённой группе.');
    }
    if (!(await store.allowed(ctx.chatId, settings.allowedChatIds))) {
      if (cmd.name === 'setup' || cmd.name === 'start' || cmd.name === 'menu') return say(ctx, `Этот чат ещё не разрешён. Его ID: ${ctx.chatId}. Владелец бота должен добавить ID в конфигурацию и развернуть её. Пароли и ключи сюда не отправляйте.`, null);
      return;
    }
    if (!(await access(ctx, message.from))) {
      if (faceitCommand) {
        if (await claim(updateId, ctx, cmd.name)) return notice(ctx, `u:${updateId}`, 'Нет доступа', 'Не могу подтвердить членство. Выдайте боту права администратора; команды должен отправлять участник от своего аккаунта.');
        return;
      }
      return say(ctx, 'Не могу подтвердить членство. Выдайте боту права администратора; команды должен отправлять участник от своего аккаунта.');
    }
    if (!(await claim(updateId, ctx, cmd.name))) return;
    try {
      await store.cleanup();
      await action(cmd.name, cmd.args, ctx, message.from, message, updateId);
    } catch (error) {
      if (faceitCommand) return notice(ctx, `u:${updateId}`, 'Не удалось выполнить запрос', safeError(error));
      await say(ctx, safeError(error));
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
      if (faceitCallback && await store.allowed(ctx.chatId, settings.allowedChatIds) && await claim(updateId, ctx, 'callback')) {
        return notice(ctx, `u:${updateId}`, 'Нет доступа', 'Не могу подтвердить членство. Команду должен отправить участник разрешённой группы.');
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
      if (faceitCallback) return notice(ctx, `u:${updateId}`, 'Не удалось выполнить запрос', safeError(error));
      return say(ctx, safeError(error));
    }
  }
  return { handleMessage, handleCallback };
}

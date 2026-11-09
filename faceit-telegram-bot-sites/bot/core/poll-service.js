import { todayPoll } from './poll.js';
import { pollWindow } from './poll-window.js';

function definiteRejection(error) {
  return Number.isInteger(error?.code) && error.code >= 400 && error.code < 500;
}
function alreadyUnpinned(error) {
  // A removed/not-pinned bot message needs no further cleanup. Other 400s may
  // mean missing rights and must remain pending, not be mistaken for success.
  return error?.code === 400 && (error.unpinTargetMissing === true
    || /message (?:to unpin )?(?:not found|is not pinned)/i.test(error.description ?? error.message ?? ''));
}

export function createPollService({ api, store, now = () => Math.floor(Date.now() / 1000) }) {
  return { async run(ctx, requestId) {
    let claim;
    try { claim = await store.claimPollRun(ctx.chatId, requestId); } catch {
      return { status: 'rejected', warning: 'Не удалось сохранить состояние опроса. Новый опрос не отправлен.' };
    }
    if (claim.status !== 'claimed') return { status: claim.status === 'outcome_unknown' ? 'outcome_unknown' : 'busy' };
    let state = claim.state;
    let result;
    const warnings = [];
    let remainingUnpins = 4; // One bounded budget across recovery and new-delivery cleanup.
    const finish = async () => {
      try { await store.finishPollRun(ctx.chatId, requestId, result.status); } catch {
        warnings.push('Не удалось подтвердить сохранение состояния. Автоматически повторять отправку не буду.');
      }
      if (warnings.length) result.warning = [...new Set([result.warning, ...warnings].filter(Boolean))].join(' ');
      return result;
    };
    const persistPins = async () => store.updatePollPins(ctx.chatId, requestId, state.pinned_message_id, state.pending_unpin_ids);
    const cleanPins = async () => {
      // Only IDs recorded by this bot; never unpinAll or infer arbitrary pins.
      for (const messageId of [...state.pending_unpin_ids]) {
        if (messageId === state.pinned_message_id) continue;
        if (remainingUnpins <= 0) break;
        remainingUnpins -= 1;
        try {
          await store.renewPollRun(ctx.chatId, requestId);
          await api.unpinChatMessage({ chat_id: ctx.chatId, message_id: messageId });
        } catch (error) {
          if (!alreadyUnpinned(error)) {
            warnings.push('Не удалось открепить предыдущий опрос; попробую при следующем /poll.');
            continue;
          }
        }
        state.pending_unpin_ids = state.pending_unpin_ids.filter(id => id !== messageId);
        await persistPins();
      }
    };
    const pinLatest = async () => {
      if (!state.latest_message_id || state.pinned_message_id === state.latest_message_id) return;
      await store.renewPollRun(ctx.chatId, requestId);
      try {
        await api.pinChatMessage({ chat_id: ctx.chatId, message_id: state.latest_message_id, disable_notification: true });
      } catch {
        warnings.push('Опрос отправлен, но закрепить его не удалось. Выдайте боту право закреплять сообщения; прежний закреп сохранён.');
        return;
      }
      const previous = state.pinned_message_id;
      state.pinned_message_id = state.latest_message_id;
      if (previous && previous !== state.pinned_message_id) state.pending_unpin_ids.push(previous);
      await persistPins();
    };
    try {
      // Recover a known accepted POST whose previous pin failed or runtime died.
      await pinLatest();
      await cleanPins();
      const window = pollWindow(now());
      const fresh = !state.original_message_id || !Number.isSafeInteger(state.created_at)
        || state.created_at < window.start || state.created_at >= window.end;
      await store.preparePollPost(ctx.chatId, requestId);
      let message;
      try {
        message = fresh
          ? await api.sendPoll({ ...todayPoll(ctx.chatId, ctx.topicId),
            ...(ctx.replyToMessageId == null ? {} : { reply_parameters: { message_id: ctx.replyToMessageId, allow_sending_without_reply: true } }) })
          // Bot API forwardMessage has no reply_parameters. Forwarding, rather
          // than copying, preserves the original shared poll and its votes.
          : await api.forwardMessage({ chat_id: ctx.chatId, from_chat_id: ctx.chatId,
            message_id: state.original_message_id,
            ...(ctx.topicId == null ? {} : { message_thread_id: ctx.topicId }), disable_notification: false });
      } catch (error) {
        if (definiteRejection(error)) {
          await store.clearPollPostFence(ctx.chatId, requestId);
          result = { status: 'rejected', warning: fresh
            ? 'Не удалось создать опрос. Проверьте право отправлять опросы; при flood limit подождите.'
            : 'Не удалось переслать прежний опрос: он мог быть удалён или пересылка запрещена. До конца текущего периода МСК новый опрос не создаю, чтобы не разделять голоса.' };
        } else {
          result = { status: 'outcome_unknown' };
        }
        return finish();
      }
      // This must precede pinning: DB failure after an accepted POST leaves
      // the persisted unknown fence, never an unsafe blind send retry.
      await store.recordPollPost(ctx.chatId, requestId, fresh, message);
      state = await store.getPollState(ctx.chatId);
      result = { status: 'sent', message };
      await pinLatest();
      await cleanPins();
      return finish();
    } catch {
      result = result?.status === 'sent' ? result : { status: 'outcome_unknown' };
      warnings.push('Не удалось завершить сохранение опроса. Автоматически повторять отправку не буду.');
      return finish();
    }
  } };
}

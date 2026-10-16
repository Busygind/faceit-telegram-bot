export const POLL_OPTIONS = Object.freeze([
  'да, в 17', 'да, в 18', 'да, в 19', 'да, в 20',
  'да, в 21', 'да, в 22', 'да, в 23', 'да, позже', 'нет',
]);

export function todayPoll(chatId, topicId) {
  return {
    chat_id: chatId,
    ...(topicId == null ? {} : { message_thread_id: topicId }),
    question: 'Играть сегодня (время по МСК)',
    options: POLL_OPTIONS.map((text) => ({ text })),
    type: 'regular',
    is_anonymous: false,
    allows_multiple_answers: true,
    allows_revoting: true,
    shuffle_options: false,
    allow_adding_options: false,
    hide_results_until_closes: false,
    is_closed: false,
    disable_notification: false,
    protect_content: false,
    allow_paid_broadcast: false,
  };
}

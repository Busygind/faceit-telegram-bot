export default function Home() {
  return <main style={{ minHeight: '100vh', background: '#131318', color: '#f6f6f7', padding: '72px 24px', fontFamily: 'system-ui,sans-serif' }}>
    <section style={{ maxWidth: 620, margin: '0 auto' }}>
      <div style={{ color: '#ff6b2b', letterSpacing: 2, fontSize: 14 }}>FACEIT / COUNTER-STRIKE 2</div>
      <h1 style={{ fontSize: 44, marginTop: 26 }}>Road to 3 ELO</h1>
      <p style={{ color: '#b2b2ba', fontSize: 19, lineHeight: 1.7 }}>Облачная копия Telegram-бота. Команды и карточки доступны только в разрешённом Telegram-чате.</p>
      <div style={{ background: '#202027', borderRadius: 18, padding: 26, marginTop: 30, lineHeight: 1.9 }}>
        <div><code>/last ник</code> — последний матч</div><div><code>/stats ник</code> — последние 30 матчей</div><div><code>/poll</code> — играть сегодня</div><div><code>/ts</code> — TeamSpeak чата</div>
      </div>
      <p style={{ color: '#848491', marginTop: 30, lineHeight: 1.7 }}>Эта страница не показывает реквизиты сервера, историю чата, ключи или статистику участников. Публичный webhook принимает только авторизованные запросы Telegram.</p>
    </section>
  </main>;
}

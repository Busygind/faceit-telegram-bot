import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Road to 3 ELO', description: 'Cloud webhook deployment of a private FACEIT CS2 Telegram bot.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}

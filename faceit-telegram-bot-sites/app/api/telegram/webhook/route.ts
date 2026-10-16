import { env } from 'cloudflare:workers';
import { createWebhook } from '../../../../bot/webhook.mjs';
export const dynamic = 'force-dynamic';
const handle = createWebhook({ getEnv: () => env });
export async function POST(request: Request) { return handle(request); }
export async function GET(request: Request) { return handle(request); }

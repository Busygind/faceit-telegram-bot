import { env } from 'cloudflare:workers';
import { health } from '../../../bot/webhook.mjs';
import { createDependencyProbe } from '../../../bot/probe.mjs';
export const dynamic = 'force-dynamic';
export async function GET() { return health(env); }
const probe = createDependencyProbe({ getEnv: () => env });
export async function POST(request: Request) { return probe(request); }

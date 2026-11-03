// Real SDKs at their default hosts with the placeholder key: a provider auth error proves the full path and TLS trust.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import Stripe from 'stripe';
import twilio from 'twilio';
const PH = process.env.PH;
const out = {};
const probe = async (name, call) => {
  try { await call(); out[name] = 'unexpected success'; }
  catch (e) { out[name] = `${e.constructor?.name} ${e.status ?? e.statusCode ?? e.code ?? ''} ${String(e.message).slice(0, 160)}`; }
};
await probe('openai', () => new OpenAI({ apiKey: PH }).models.list());
await probe('anthropic', () => new Anthropic({ apiKey: PH }).models.list());
await probe('stripe', () => new Stripe(PH).balance.retrieve());
await probe('twilio', () => twilio('AC00000000000000000000000000000000', PH).api.v2010.accounts.list({ limit: 1 }));
console.log(JSON.stringify(out));

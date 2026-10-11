/**
 * noon studio — pré-briefing Worker
 *
 * Receives the PDF (already generated client-side, as base64) and relays it
 * as an email attachment via the official Resend SDK. The SDK's attachment
 * API wants a Buffer, so this file needs the `nodejs_compat` compatibility
 * flag enabled (see wrangler.toml) and the `resend` package installed
 * (`npm install resend` in this folder before deploying).
 *
 * Required environment variables / secrets (see README section in the chat
 * reply for how to set these):
 *   RESEND_API_KEY   — secret. Your Resend API key. Set with
 *                       `wrangler secret put RESEND_API_KEY` — never hardcode
 *                       it in this file, since that would ship the key to
 *                       anyone who can read the source or the git history.
 *   TO_EMAIL         — the studio's inbox that should receive briefings.
 *   FROM_EMAIL       — a sender address on a domain verified in Resend
 *                       (e.g. "pre-briefing@seudominio.com").
 *   ALLOWED_ORIGIN    — the exact origin of your Cloudflare Pages site
 *                       (e.g. "https://briefing.noonstudio.com"), used for CORS.
 *                       Set to "*" only while testing locally.
 */

import { Resend } from 'resend';

const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8MB safety cap on the decoded PDF

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405, env);
    }

    if (!env.RESEND_API_KEY || !env.TO_EMAIL || !env.FROM_EMAIL) {
      return jsonResponse(
        { error: 'worker misconfigured — missing RESEND_API_KEY, TO_EMAIL or FROM_EMAIL' },
        500,
        env
      );
    }

    let payload;
    try {
      payload = await request.json();
    } catch (err) {
      return jsonResponse({ error: 'invalid json body' }, 400, env);
    }

    const { filename, pdfBase64, clientName, clientEmail, clientCompany } = payload || {};

    if (!pdfBase64 || typeof pdfBase64 !== 'string') {
      return jsonResponse({ error: 'missing pdfBase64' }, 400, env);
    }
    if (!clientName || !clientEmail) {
      return jsonResponse({ error: 'missing clientName or clientEmail' }, 400, env);
    }

    // rough size check before we hand it to Resend — base64 is ~4/3 the
    // size of the original bytes
    const approxBytes = Math.floor((pdfBase64.length * 3) / 4);
    if (approxBytes > MAX_PDF_BYTES) {
      return jsonResponse({ error: 'pdf too large' }, 413, env);
    }

    const safeFilename =
      (filename && String(filename).replace(/[^a-zA-Z0-9._-]/g, '-')) || 'pre-briefing.pdf';

    const subject = `Novo pré-briefing — ${clientCompany || clientName}`;
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.6;">
        <p><strong>Novo pré-briefing recebido.</strong></p>
        <p>
          Nome: ${escapeHtml(clientName)}<br/>
          Empresa: ${escapeHtml(clientCompany || '—')}<br/>
          E-mail: ${escapeHtml(clientEmail)}
        </p>
        <p>O PDF com todas as respostas está em anexo.</p>
      </div>
    `;

    // instantiated per-request: `env` (and so the secret) is only
    // available inside the fetch handler, not at module scope
    const resend = new Resend(env.RESEND_API_KEY);

    let result;
    try {
      result = await resend.emails.send({
        from: env.FROM_EMAIL,
        to: [env.TO_EMAIL],
        reply_to: clientEmail,
        subject,
        html,
        attachments: [
          {
            filename: safeFilename,
            content: Buffer.from(pdfBase64, 'base64'),
          },
        ],
      });
    } catch (err) {
      return jsonResponse({ error: 'failed to reach resend', detail: String(err) }, 502, env);
    }

    if (result.error) {
      return jsonResponse({ error: 'resend rejected the request', detail: result.error }, 502, env);
    }

    return jsonResponse({ ok: true, id: (result.data && result.data.id) || null }, 200, env);
  },
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

import 'dotenv/config';
import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

// Adapted directly from deal-analysis-mcp's oauth.ts (already proven to
// work with Claude's remote MCP connector system) — same flow, distinct
// env vars so the two services never share a signing secret or issuer.

const router = Router();

const ISSUER = process.env.OAUTH_ISSUER!;
const JWT_SECRET = process.env.JWT_SECRET!;

const authCodes = new Map<string, {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}>();

const clients = new Map<string, {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}>();

router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  res.json({
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  });
});

router.post('/oauth/register', (req: Request, res: Response) => {
  const { redirect_uris, client_name, token_endpoint_auth_method } = req.body;
  const clientId = randomUUID();
  const clientSecret = randomUUID();

  clients.set(clientId, {
    clientId,
    clientSecret,
    redirectUris: redirect_uris ?? [],
  });

  console.error(`Client registered: ${client_name ?? 'unknown'} (${clientId})`);

  res.status(201).json({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: redirect_uris ?? [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: token_endpoint_auth_method ?? 'client_secret_basic',
    client_name: client_name ?? 'MCP Client',
  });
});

router.get('/oauth/authorize', (req: Request, res: Response) => {
  const {
    client_id,
    redirect_uri,
    code_challenge,
    code_challenge_method,
    state,
    response_type,
  } = req.query as Record<string, string>;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type' });
    return;
  }

  const client = clients.get(client_id);
  if (!client) {
    res.status(400).json({ error: 'invalid_client', error_description: 'Client not registered' });
    return;
  }

  // Auto-approve — internal team use, same as deal-analysis-mcp
  const code = randomUUID();
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge ?? '',
    expiresAt: Date.now() + 5 * 60 * 1000,
  });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  console.error(`Auth code issued for client: ${client_id}`);
  res.redirect(redirectUrl.toString());
});

router.post('/oauth/token', (req: Request, res: Response) => {
  const {
    grant_type,
    code,
    redirect_uri,
    code_verifier,
    client_id,
  } = req.body;

  if (grant_type !== 'authorization_code') {
    res.status(400).json({ error: 'unsupported_grant_type' });
    return;
  }

  const stored = authCodes.get(code);
  if (!stored) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found' });
    return;
  }

  if (Date.now() > stored.expiresAt) {
    authCodes.delete(code);
    res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
    return;
  }

  if (stored.clientId !== client_id) {
    res.status(400).json({ error: 'invalid_grant', error_description: 'Client mismatch' });
    return;
  }

  if (code_verifier && stored.codeChallenge) {
    const challenge = createHash('sha256')
      .update(code_verifier)
      .digest('base64url');

    if (challenge !== stored.codeChallenge) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      return;
    }
  }

  authCodes.delete(code);

  const token = jwt.sign(
    { sub: client_id, scope: 'mcp' },
    JWT_SECRET,
    { expiresIn: '24h', issuer: ISSUER }
  );

  console.error(`Token issued for client: ${client_id}`);

  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: 86400,
  });
});

export default router;

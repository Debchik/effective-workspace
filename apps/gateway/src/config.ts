import path from 'node:path';

export type AppConfig = {
  host: string;
  port: number;
  dataDir: string;
  accessToken: string;
  allowedOrigins: string[];
  runtime: 'codex' | 'mock';
  codexBin: string;
  codexModel?: string;
  webDistDir: string;
};

export function loadConfig(): AppConfig {
  const accessToken = process.env.GATEWAY_ACCESS_TOKEN?.trim();
  if (!accessToken || accessToken.length < 24) {
    throw new Error('GATEWAY_ACCESS_TOKEN must be set and contain at least 24 characters.');
  }

  const runtimeValue = process.env.RUNTIME?.trim() || 'codex';
  if (runtimeValue !== 'codex' && runtimeValue !== 'mock') {
    throw new Error('RUNTIME must be either codex or mock.');
  }

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

  return {
    host: process.env.HOST?.trim() || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
    dataDir: path.resolve(process.cwd(), process.env.DATA_DIR?.trim() || '../../.data'),
    accessToken,
    allowedOrigins,
    runtime: runtimeValue,
    codexBin: process.env.CODEX_BIN?.trim() || 'codex',
    codexModel: process.env.CODEX_MODEL?.trim() || undefined,
    webDistDir: path.resolve(
      process.cwd(),
      process.env.WEB_DIST_DIR?.trim() || '../web/dist'
    )
  };
}

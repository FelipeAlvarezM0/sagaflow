import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  redact: process.env.LOG_SENSITIVE === 'true' ? [] : ['req.headers.authorization', '*.password', '*.token', '*.cardNumber']
});

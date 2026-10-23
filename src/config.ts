import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

// A current, cost-efficient model. Override with OPENAI_MODEL in .env.
export const DEFAULT_MODEL = "gpt-5.4-mini";

const EnvSchema = z.object({
  // Optional at load time so tests run without a key.
  // The OpenAI client checks for it when it is actually created (CLI and server fail fast).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default(DEFAULT_MODEL),
  OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  // The OpenAI SDK retries 408/409/429/5xx and connection errors with exponential backoff.
  OPENAI_MAX_RETRIES: z.coerce.number().int().min(0).default(2),
  PORT: z.coerce.number().int().positive().default(3000),
  // 127.0.0.1 keeps the server local; use 0.0.0.0 to accept connections from other machines.
  HOST: z.string().default("127.0.0.1"),
});

export interface AppConfig {
  openai: {
    apiKey: string | undefined;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  port: number;
  host: string;
}

/**
 * Validates environment variables and returns a typed config.
 * Takes `env` as a parameter so tests can pass their own values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat `OPENAI_MODEL=` (empty, as in .env.example) the same as "not set".
  const nonEmpty = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));

  const parsed = EnvSchema.safeParse(nonEmpty);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(parsed.error)}`);
  }

  const vars = parsed.data;
  return {
    openai: {
      apiKey: vars.OPENAI_API_KEY,
      model: vars.OPENAI_MODEL,
      timeoutMs: vars.OPENAI_TIMEOUT_MS,
      maxRetries: vars.OPENAI_MAX_RETRIES,
    },
    port: vars.PORT,
    host: vars.HOST,
  };
}

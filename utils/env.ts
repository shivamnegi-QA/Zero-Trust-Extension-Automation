import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  EXTENSION_LOGIN_EMAIL: z.string().email(),
  EXTENSION_LOGIN_PASSWORD: z.string().min(1),
  EXTENSION_DEPLOYMENT_PAGE_URL: z.string().url(),
  DASHBOARD_ACCESS_API: z.string().min(1),
  SQRX_BASE_URL: z.string().url(),
  EXTENSION_PATH: z.string().min(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Missing or invalid env vars:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

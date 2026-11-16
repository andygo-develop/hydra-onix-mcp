/** The `~/.hydra-onix-mcp/config.json` schema: which agents the user set up. */
import { z } from 'zod';

import { TARGET_IDS } from '../generators/targets/types.js';

export const configSchema = z.object({
  version: z.literal(1),
  targets: z.array(z.enum(TARGET_IDS)),
});

export type UserConfig = z.infer<typeof configSchema>;

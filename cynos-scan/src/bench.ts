/** The benchmark CLI (dist/bench.js), built beside the action: the engine's benchMain. */
import { benchMain } from '@averlon-ai/cynos-scan-engine';

if (require.main === module) void benchMain().then(code => process.exit(code));

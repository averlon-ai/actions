import { run } from '@averlon/claude-agent-utils/setup-skills';

export { run };

if (require.main === module) {
  run();
}

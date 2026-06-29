import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function localBin(pkg: string, bin: string): string {
  return resolve(root, pkg, 'node_modules', '.bin', bin);
}

function run(bin: string, args: string[], cwd: string, color: string) {
  const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const label = bin.split('/').pop() ?? bin;
  p.stdout?.on('data', (d: Buffer) => process.stdout.write(`\x1b[${color}m[${label}]\x1b[0m ${d}`));
  p.stderr?.on('data', (d: Buffer) => process.stderr.write(`\x1b[${color}m[${label}]\x1b[0m ${d}`));
  p.on('exit', (code) => { if (code) process.exit(code); });
  return p;
}

run(localBin('server', 'tsx'), ['--watch', 'src/index.ts'], resolve(root, 'server'), '36');
run(localBin('client', 'vite'), [], resolve(root, 'client'), '35');

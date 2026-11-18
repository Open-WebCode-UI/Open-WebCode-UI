// Operator update from the command line (the same steps as the admin API). Run it from the repository root or the server folder:
//   npm run update -w server                  -> install the newest release, if there is one
//   npm run update -w server -- check         -> only report the installed and newest versions
//   npm run update -w server -- apply 1.2.0   -> install a specific newer release
// Restart the server afterwards: a running process keeps the code it started with.
import { updater, UpdateError } from '../updates/updater.js';

const [cmd = 'update', version] = process.argv.slice(2);

async function main() {
  if (cmd === 'check') {
    await updater.check({ force: true });
    const s = await updater.status();
    console.log(`Installed: ${s.currentVersion}\nNewest release: ${s.latest ?? 'none published'}`);
    if (!s.latest) console.log('No release tags (vMAJOR.MINOR.PATCH) exist in the repository yet.');
    else console.log(s.updateAvailable ? `Update available (${s.updateType}).` : 'Up to date.');
    return 0;
  }
  if (cmd !== 'update' && cmd !== 'apply') throw new Error(`unknown command "${cmd}"; use check, update or apply <version>`);
  if (cmd === 'apply' && !version) throw new Error('apply needs a version, for example: apply 1.2.0');

  const { job, done } = await updater.startApply({ version: cmd === 'apply' ? version : undefined });
  console.log(`Updating ${job.from} -> ${job.to}`);
  let printed = 0;
  const flush = () => { for (; printed < job.log.length; printed++) console.log(job.log[printed]); };
  const timer = setInterval(flush, 500);
  await done;
  clearInterval(timer);
  flush();
  if (job.state === 'succeeded') { console.log(`\nDone. Restart the server to run ${job.to}.`); return 0; }
  console.error(`\nNot updated: ${job.error}`);
  return 1;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof UpdateError && e.code === 'no_update') { console.log(e.message); process.exitCode = 0; }
  else { console.error(e instanceof UpdateError ? e.message : `Error: ${e.message}`); process.exitCode = 1; }
}

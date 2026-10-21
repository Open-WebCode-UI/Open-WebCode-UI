import { config } from './config.js';
import { initDb } from './db/index.js';
import { createApp, bootstrap } from './app.js';
import { resolveTls, createServer, tlsManagement, setTlsRuntime, effectiveBaseUrl } from './tls.js';
import { getSettings } from './settings.js';
import { attachTerminalWs } from './terminal/ws.js';

initDb(config.dbFile);
const generated = bootstrap();
if (generated) {
  console.log('\n================ BREAK-GLASS ACCOUNT ================');
  console.log(`  username: breakglass\n  password: ${generated}\n  (shown once; you must change it and enroll MFA at first login)`);
  console.log('=====================================================\n');
}
const managedBy = tlsManagement({ baseUrl: config.baseUrl });
const choice = managedBy === 'admin' ? getSettings('tls').mode : 'unset';
let tls = null;
try {
  tls = await resolveTls({ baseUrl: config.baseUrl, dataDir: config.dataDir, choice });
} catch (e) {
  // A broken environment-supplied certificate is a deployment error; a failure of the administrator's choice must not lock them out.
  if (managedBy !== 'admin') throw e;
  console.error(`Could not set up the self-signed certificate (${e.message}); serving plain HTTP so an administrator can still sign in.`);
}
if (managedBy === 'admin') {
  config.baseUrl = effectiveBaseUrl(config.baseUrl, !!tls);
  config.plainHttp = !tls;
}
setTlsRuntime({ https: !!tls, source: tls?.source ?? null, managedBy, cert: tls?.cert ?? null });
const server = createServer(createApp(), tls);
attachTerminalWs(server);
server.listen(config.port, () => {
  console.log(`Listening on ${config.baseUrl} (port ${config.port}, ${tls ? `HTTPS, ${tls.source} certificate` : 'HTTP'})`);
  if (tls?.source === 'self-signed') console.log(`  Self-signed certificate: ${tls.certFile}\n  Your browser will warn once; trust that file (or proceed past the warning).`);
  if (managedBy === 'admin' && choice === 'unset') console.log('  HTTPS is not configured. Sign in as an administrator and open Admin > HTTPS to choose a self-signed certificate or no HTTPS.');
  if (managedBy === 'admin' && !tls) console.warn('  WARNING: traffic (including passwords) is unencrypted.');
});

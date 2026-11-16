import { webConfig, checkWebFiles } from './web-config';
import { clientFromDir } from './client-files';

async function bootstrap() {
  const config = webConfig();
  checkWebFiles(config);
  // Validate configuration before importing services that capture environment paths.
  const { startServer } = await import('./server.js');
  const app = await startServer({
    host: config.host,
    port: config.port,
    origins: [config.origin],
    client: clientFromDir(config.clientDir),
    access: config.access,
    logger: ['error', 'warn', 'log'],
  });
  console.log('Web app listening on ' + (await app.getUrl()));
}
void bootstrap().catch(() => {
  // Never print environment values or driver errors to production logs.
  console.error(
    'Web startup failed. Check PUBLIC_ORIGIN, APP_USER, password secret, client build, Rust binary and writable session directory.',
  );
  process.exitCode = 1;
});

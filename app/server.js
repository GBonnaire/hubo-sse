(async () => {
  const { loadConfig }        = await import('./dist/config.js');
  const { buildApp }          = await import('./dist/app.js');
  const { TenantsManager }    = await import('./dist/tenants/TenantsManager.js');
  const { SubscriberRegistry }= await import('./dist/subscriber/SubscriberRegistry.js');
  const { MetricsRegistry }   = await import('./dist/metrics/MetricsRegistry.js');
  const { closeRedis }        = await import('./dist/redis/redis.js');
  const { prisma }            = await import('./dist/db/prisma.js');

  const config   = loadConfig();
  const manager  = new TenantsManager();
  const metrics  = new MetricsRegistry();
  const registry = new SubscriberRegistry(metrics);
  const app      = await buildApp(config, manager, undefined, registry, metrics);

  try {
    await manager.load();
  } catch (err) {
    console.error(`Erreur chargement tenants : ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  process.on('SIGHUP', () => {
    manager.reload().catch(err => app.log.error(err, 'tenant reload failed'));
  });

  setInterval(() => {
    manager.reload().catch(err => app.log.error(err, 'tenant reload failed'));
  }, 60_000).unref();

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  app.log.info({ port: config.port, tenants: manager.getAllTenants().length }, 'Hubo started');

  let isShuttingDown = false;

  async function gracefulShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info({ signal }, 'Graceful shutdown initiated');

    const forceExitTimer = setTimeout(() => {
      app.log.error('Graceful shutdown timeout — forcing exit');
      process.exit(1);
    }, 30_000);
    forceExitTimer.unref();

    try {
      await app.close();
      registry.notifyShutdown();
      await closeRedis();
      await prisma.$disconnect();
      app.log.info('Graceful shutdown complete');
      clearTimeout(forceExitTimer);
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM').catch(err => { console.error(err); process.exit(1); }));
  process.once('SIGINT',  () => gracefulShutdown('SIGINT').catch(err => { console.error(err); process.exit(1); }));
})();

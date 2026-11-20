function installGracefulQuit(app, close) {
  let closing = false;
  let closed = false;
  app.on('before-quit', event => {
    if (closed) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.resolve().then(close).catch(() => {
      console.error('Could not finish closing the application server.');
    }).finally(() => {
      closed = true;
      app.quit();
    });
  });
}
module.exports = { installGracefulQuit };

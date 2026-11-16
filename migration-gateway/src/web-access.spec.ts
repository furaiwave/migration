import express from 'express';
import request from 'supertest';
import { webAccess } from './web-access';
const app = express();
app.use(
  webAccess({ user: 'operator', password: 'test-password-123456:with-colon' }),
);
app.use((_req, res) => {
  res.json({ allowed: true });
});

test.each(['/', '/dbf/native/servers', '/assets/app.js'])(
  'requires credentials for %s even without Origin',
  async (url) => {
    const response = await request(app).get(url).expect(401);
    expect(response.headers['www-authenticate']).toContain('Basic');
    expect(response.headers['cache-control']).toBe('no-store');
  },
);
test('rejects unauthenticated POST and malformed or wrong credentials', async () => {
  await request(app).post('/dbf/parse-multiple').expect(401);
  for (const authorization of [
    'Bearer secret',
    'Basic !!!!',
    'Basic ' + Buffer.from('operator:wrong-password').toString('base64'),
  ]) {
    await request(app).get('/').set('Authorization', authorization).expect(401);
  }
});
test('accepts credentials including colons in passwords and protects API caching', async () => {
  const response = await request(app)
    .get('/dbf/session/test')
    .auth('operator', 'test-password-123456:with-colon')
    .expect(200);
  expect(response.body).toEqual({ allowed: true });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
});
test('only the exact GET/HEAD health endpoint is public', async () => {
  await request(app).get('/healthz').expect(200, { status: 'ok' });
  await request(app).head('/healthz').expect(200);
  await request(app).post('/healthz').expect(401);
  await request(app).get('/healthz/extra').expect(401);
});

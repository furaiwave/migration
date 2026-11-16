import { DbfService } from './dbf.service';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
test('rejects an upload without DBF tables before creating a session', () => {
  const sessions = { createSession: jest.fn() };
  const service = new DbfService(
    sessions as unknown as DbfSessionService,
    {} as DbfRelationshipService,
  );
  expect(() => service.parseMultipleFiles([])).toThrow();
  expect(sessions.createSession).not.toHaveBeenCalled();
});

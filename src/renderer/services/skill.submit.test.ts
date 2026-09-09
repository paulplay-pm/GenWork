import { describe, expect, test } from 'vitest';

import { buildSkillSubmitRequest } from './skill';

describe('buildSkillSubmitRequest', () => {
  test('maps form + zip base64 to the wire shape', () => {
    const req = buildSkillSubmitRequest({ desc: 'a desc', allCompany: true, zipBase64: 'QUJD' });
    expect(req).toEqual({ desc: 'a desc', scope: { allCompany: true, deptIds: [], userIds: [] }, zipBase64: 'QUJD' });
  });
});
